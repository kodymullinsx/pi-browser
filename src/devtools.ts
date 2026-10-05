import { randomUUID } from 'node:crypto';
import type * as pw from 'playwright';

// Monitors read Chromium DevTools Protocol events directly. Playwright's own page
// events (pageerror, request, response) cover the same ground in Tab, but they are
// unbounded and lack the CORS and blocked-reason details, structured call frames,
// and lifecycle events recorded here. info() and metrics() have no Playwright
// equivalent.

export const MONITOR_SIGNALS = ['runtime', 'network-failures', 'lifecycle'] as const;
export type DevToolsMonitorSignal = typeof MONITOR_SIGNALS[number];

// Limits shared with the tool schema so the manager and the schema agree.
export const MONITOR_LIMITS = {
  maxEvents: { default: 200, max: 1_000 },
  readLimit: { default: 100, max: 500 },
} as const;

const MAX_MONITOR_READ_CHARS = 30_000;
const MAX_MONITORS = 16;
const MAX_MONITORS_PER_PAGE = 4;

export type DevToolsEvent = {
  method: string;
  capturedAt: number;
  data: Record<string, unknown>;
};

type PageChannel = {
  session: pw.CDPSession;
  enabled: Map<string, Promise<void>>;
  monitors: Set<string>;
  closed: boolean;
};

type Monitor = {
  page: pw.Page;
  signals: Set<DevToolsMonitorSignal>;
  maxEvents: number;
  events: DevToolsEvent[];
  dropped: number;
  closed: boolean;
  closeReason?: string;
};

function boundedString(value: unknown, maxLength = 2_048): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function browserForPage(page: pw.Page): pw.Browser {
  const browser = page.context().browser();
  if (!browser) throw new Error('browser_devtools requires a browser-backed page.');
  const browserName = browser.browserType().name();
  if (browserName !== 'chromium')
    throw new Error(`browser_devtools requires Chromium; current browser is ${browserName}.`);
  return browser;
}

type Params = Record<string, any>;
type EventData = Record<string, unknown>;

function runtimeException(params: Params): EventData {
  const details = params.exceptionDetails ?? {};
  const exception = details.exception ?? {};
  const callFrames = Array.isArray(details.stackTrace?.callFrames)
    ? details.stackTrace.callFrames.slice(0, 8).map((frame: Record<string, unknown>) => ({
        functionName: boundedString(frame.functionName, 300),
        url: boundedString(frame.url, 1_000),
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
      }))
    : undefined;
  return {
    timestamp: params.timestamp,
    text: boundedString(details.text, 1_000),
    description: boundedString(exception.description, 4_000),
    url: boundedString(details.url),
    lineNumber: details.lineNumber,
    columnNumber: details.columnNumber,
    callFrames,
  };
}

function loadingFailed(params: Params): EventData {
  return {
    requestId: boundedString(params.requestId, 500),
    timestamp: params.timestamp,
    resourceType: boundedString(params.type, 100),
    errorText: boundedString(params.errorText, 1_000),
    canceled: params.canceled,
    blockedReason: boundedString(params.blockedReason, 200),
    corsErrorStatus: params.corsErrorStatus
      ? {
          corsError: boundedString(params.corsErrorStatus.corsError, 200),
          failedParameter: boundedString(params.corsErrorStatus.failedParameter, 500),
        }
      : undefined,
  };
}

function failedResponse(params: Params): EventData | null {
  const response = params.response ?? {};
  if (typeof response.status !== 'number' || response.status < 400) return null;
  return {
    requestId: boundedString(params.requestId, 500),
    timestamp: params.timestamp,
    resourceType: boundedString(params.type, 100),
    status: response.status,
    statusText: boundedString(response.statusText, 500),
    url: boundedString(response.url),
    mimeType: boundedString(response.mimeType, 200),
    protocol: boundedString(response.protocol, 100),
  };
}

function lifecycleEvent(params: Params): EventData {
  return {
    frameId: boundedString(params.frameId, 500),
    loaderId: boundedString(params.loaderId, 500),
    name: boundedString(params.name, 200),
    timestamp: params.timestamp,
  };
}

function frameNavigated(params: Params): EventData {
  const frame = params.frame ?? {};
  return {
    frameId: boundedString(frame.id, 500),
    parentId: boundedString(frame.parentId, 500),
    loaderId: boundedString(frame.loaderId, 500),
    name: boundedString(frame.name, 500),
    url: boundedString(frame.url),
    mimeType: boundedString(frame.mimeType, 200),
    navigationType: boundedString(params.type, 100),
  };
}

type SignalSpec = {
  /** Shared key so signals that need the same CDP domain enable it once per page. */
  enableKey: string;
  enable: (session: pw.CDPSession) => Promise<void>;
  /** CDP event method to sanitizer. A sanitizer returns null for events to skip. */
  events: Record<string, (params: Params) => EventData | null>;
};

// The single place that says which CDP domains and events each signal uses.
const SIGNALS: Record<DevToolsMonitorSignal, SignalSpec> = {
  runtime: {
    enableKey: 'Runtime',
    enable: async session => { await session.send('Runtime.enable'); },
    events: { 'Runtime.exceptionThrown': runtimeException },
  },
  'network-failures': {
    enableKey: 'Network',
    enable: async session => { await session.send('Network.enable'); },
    events: {
      'Network.loadingFailed': loadingFailed,
      'Network.responseReceived': failedResponse,
    },
  },
  lifecycle: {
    enableKey: 'Page.lifecycle',
    enable: async session => {
      await session.send('Page.enable');
      await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
    },
    events: {
      'Page.lifecycleEvent': lifecycleEvent,
      'Page.frameNavigated': frameNavigated,
    },
  },
};

const EVENT_HANDLERS = new Map(
  (Object.entries(SIGNALS) as Array<[DevToolsMonitorSignal, SignalSpec]>).flatMap(
    ([signal, spec]) => Object.entries(spec.events).map(
      ([method, sanitize]) => [method, { signal, sanitize }] as const,
    ),
  ),
);

/** Share one pending promise per key and forget it again if it rejects. */
function once<K, V>(cache: Map<K, Promise<V>>, key: K, create: () => Promise<V>): Promise<V> {
  let pending = cache.get(key);
  if (!pending) {
    const created = create();
    pending = created;
    cache.set(key, created);
    created.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  return pending;
}

function assertLimit(name: string, value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`browser_devtools ${name} must be an integer from 1 to ${max}.`);
}

export class DevToolsManager {
  private _browserSessions = new Map<pw.Browser, Promise<pw.CDPSession>>();
  private _pageChannels = new Map<pw.Page, Promise<PageChannel>>();
  private _monitors = new Map<string, Monitor>();
  private _disposed = false;

  async info(page: pw.Page) {
    const session = await this._ensureBrowserSession(page);
    const [version, targets] = await Promise.all([
      session.send('Browser.getVersion'),
      session.send('Target.getTargets'),
    ]);
    const targetCounts: Record<string, number> = {};
    for (const target of targets.targetInfos)
      targetCounts[target.type] = (targetCounts[target.type] ?? 0) + 1;

    return {
      product: version.product,
      revision: version.revision,
      protocolVersion: version.protocolVersion,
      jsVersion: version.jsVersion,
      targetCounts,
      page: { title: await page.title(), url: page.url() },
    };
  }

  async metrics(page: pw.Page): Promise<Record<string, number>> {
    const channel = await this._ensurePageChannel(page);
    await this._enableOnce(channel, 'Performance', async () => {
      await channel.session.send('Performance.enable');
    });
    const result = await channel.session.send('Performance.getMetrics');
    return Object.fromEntries(result.metrics.map(metric => [metric.name, metric.value]));
  }

  async startMonitor(
    page: pw.Page,
    signals: DevToolsMonitorSignal[],
    maxEvents: number,
  ): Promise<{ id: string; page: { title: string; url: string }; signals: DevToolsMonitorSignal[] }> {
    if (!signals.length) throw new Error('browser_devtools monitor_start requires at least one signal.');
    const unsupported = signals.find(signal => !Object.hasOwn(SIGNALS, signal));
    if (unsupported) throw new Error(`browser_devtools does not support signal "${unsupported}".`);
    assertLimit('maxEvents', maxEvents, MONITOR_LIMITS.maxEvents.max);
    const channel = await this._ensurePageChannel(page);

    // Check the caps and claim the slot with no await in between, so concurrent
    // starts cannot all pass the check. Closed monitors stay readable but do not
    // use up slots.
    if (channel.monitors.size >= MAX_MONITORS_PER_PAGE)
      throw new Error(`browser_devtools allows at most ${MAX_MONITORS_PER_PAGE} monitors per page.`);
    if (this._openMonitorCount() >= MAX_MONITORS)
      throw new Error(`browser_devtools allows at most ${MAX_MONITORS} monitors per browser context.`);
    const id = randomUUID();
    const monitor: Monitor = {
      page,
      signals: new Set(signals),
      maxEvents,
      events: [],
      dropped: 0,
      closed: false,
    };
    this._monitors.set(id, monitor);
    channel.monitors.add(id);

    try {
      for (const signal of monitor.signals) {
        const spec = SIGNALS[signal];
        await this._enableOnce(channel, spec.enableKey, () => spec.enable(channel.session));
      }
      const info = { title: await page.title(), url: page.url() };
      this._evictClosedMonitors();
      return { id, page: info, signals: [...monitor.signals] };
    } catch (error) {
      this._monitors.delete(id);
      channel.monitors.delete(id);
      throw error;
    }
  }

  readMonitor(id: string, limit: number, clear: boolean) {
    assertLimit('limit', limit, MONITOR_LIMITS.readLimit.max);
    const monitor = this._monitorOrDie(id);
    const events: DevToolsEvent[] = [];
    let chars = 2;
    for (const event of monitor.events.slice(0, limit)) {
      const eventChars = JSON.stringify(event).length + 1;
      if (chars + eventChars > MAX_MONITOR_READ_CHARS) break;
      events.push(event);
      chars += eventChars;
    }
    const truncated = events.length < monitor.events.length;
    if (clear) monitor.events.splice(0, events.length);
    return {
      id,
      events,
      buffered: monitor.events.length,
      dropped: monitor.dropped,
      truncated,
      closed: monitor.closed,
      closeReason: monitor.closeReason,
    };
  }

  stopMonitor(id: string) {
    const monitor = this._monitorOrDie(id);
    this._monitors.delete(id);
    const channel = this._pageChannels.get(monitor.page);
    if (channel) void channel.then(value => value.monitors.delete(id)).catch(() => {});
    return { id, stopped: true, buffered: monitor.events.length, dropped: monitor.dropped };
  }

  async dispose(): Promise<void> {
    if (this._disposed) return;
    this._disposed = true;
    for (const monitor of this._monitors.values()) {
      monitor.closed = true;
      monitor.closeReason = 'browser session closed';
    }

    const pageChannels = [...this._pageChannels.values()];
    const browserSessions = [...this._browserSessions.values()];
    this._pageChannels.clear();
    this._browserSessions.clear();

    await Promise.allSettled([
      ...pageChannels.map(async pending => {
        const channel = await pending;
        channel.closed = true;
        await channel.session.detach();
      }),
      ...browserSessions.map(async pending => (await pending).detach()),
    ]);
    this._monitors.clear();
  }

  private _ensureBrowserSession(page: pw.Page): Promise<pw.CDPSession> {
    this._assertActive();
    const browser = browserForPage(page);
    return once(this._browserSessions, browser, async () => {
      const session = await browser.newBrowserCDPSession();
      session.on('close', () => this._browserSessions.delete(browser));
      return session;
    });
  }

  private _ensurePageChannel(page: pw.Page): Promise<PageChannel> {
    this._assertActive();
    browserForPage(page);
    return once(this._pageChannels, page, async () => {
      const session = await page.context().newCDPSession(page);
      const channel: PageChannel = {
        session,
        enabled: new Map(),
        monitors: new Set(),
        closed: false,
      };
      session.on('event', ({ method, params }) => {
        this._captureEvent(channel, method, (params ?? {}) as Params);
      });
      session.on('close', () => this._closePage(page, 'CDP session closed', false));
      page.on('close', () => this._closePage(page, 'page closed', true));
      return channel;
    });
  }

  private _enableOnce(channel: PageChannel, key: string, enable: () => Promise<void>): Promise<void> {
    return once(channel.enabled, key, enable);
  }

  private _captureEvent(channel: PageChannel, method: string, params: Params) {
    const handler = EVENT_HANDLERS.get(method);
    if (!handler) return;
    const data = handler.sanitize(params);
    if (!data) return;
    const event: DevToolsEvent = { method, capturedAt: Date.now(), data };

    for (const id of channel.monitors) {
      const monitor = this._monitors.get(id);
      if (!monitor || monitor.closed || !monitor.signals.has(handler.signal)) continue;
      if (monitor.events.length === monitor.maxEvents) {
        monitor.events.shift();
        monitor.dropped += 1;
      }
      monitor.events.push(event);
    }
  }

  private _closePage(page: pw.Page, reason: string, detach: boolean) {
    const pending = this._pageChannels.get(page);
    if (!pending) return;
    this._pageChannels.delete(page);
    void pending.then(async channel => {
      if (channel.closed) return;
      channel.closed = true;
      for (const id of channel.monitors) {
        const monitor = this._monitors.get(id);
        if (!monitor) continue;
        monitor.closed = true;
        monitor.closeReason = reason;
      }
      if (detach) await channel.session.detach().catch(() => {});
    }).catch(() => {});
  }

  private _openMonitorCount(): number {
    let count = 0;
    for (const monitor of this._monitors.values())
      if (!monitor.closed) count += 1;
    return count;
  }

  /** Keep the most recent closed monitors readable, but not an unbounded number. */
  private _evictClosedMonitors() {
    const closed = [...this._monitors].filter(([, monitor]) => monitor.closed);
    for (const [id] of closed.slice(0, Math.max(0, closed.length - MAX_MONITORS)))
      this._monitors.delete(id);
  }

  private _monitorOrDie(id: string): Monitor {
    const monitor = this._monitors.get(id);
    if (!monitor) throw new Error(`DevTools monitor ${id} not found.`);
    return monitor;
  }

  private _assertActive() {
    if (this._disposed) throw new Error('DevTools manager is disposed.');
  }
}
