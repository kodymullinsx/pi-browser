import { randomUUID } from 'node:crypto';
import type * as pw from 'playwright';

export type DevToolsMonitorSignal = 'runtime' | 'network-failures' | 'lifecycle';

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

function sanitizeEvent(method: string, params: Record<string, any>): DevToolsEvent | null {
  let data: Record<string, unknown>;

  if (method === 'Runtime.exceptionThrown') {
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
    data = {
      timestamp: params.timestamp,
      text: boundedString(details.text, 1_000),
      description: boundedString(exception.description, 4_000),
      url: boundedString(details.url),
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      callFrames,
    };
  } else if (method === 'Network.loadingFailed') {
    data = {
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
  } else if (method === 'Network.responseReceived') {
    const response = params.response ?? {};
    if (typeof response.status !== 'number' || response.status < 400) return null;
    data = {
      requestId: boundedString(params.requestId, 500),
      timestamp: params.timestamp,
      resourceType: boundedString(params.type, 100),
      status: response.status,
      statusText: boundedString(response.statusText, 500),
      url: boundedString(response.url),
      mimeType: boundedString(response.mimeType, 200),
      protocol: boundedString(response.protocol, 100),
    };
  } else if (method === 'Page.lifecycleEvent') {
    data = {
      frameId: boundedString(params.frameId, 500),
      loaderId: boundedString(params.loaderId, 500),
      name: boundedString(params.name, 200),
      timestamp: params.timestamp,
    };
  } else if (method === 'Page.frameNavigated') {
    const frame = params.frame ?? {};
    data = {
      frameId: boundedString(frame.id, 500),
      parentId: boundedString(frame.parentId, 500),
      loaderId: boundedString(frame.loaderId, 500),
      name: boundedString(frame.name, 500),
      url: boundedString(frame.url),
      mimeType: boundedString(frame.mimeType, 200),
      navigationType: boundedString(params.type, 100),
    };
  } else {
    return null;
  }

  return { method, capturedAt: Date.now(), data };
}

function signalForEvent(method: string): DevToolsMonitorSignal | undefined {
  if (method === 'Runtime.exceptionThrown') return 'runtime';
  if (method === 'Network.loadingFailed' || method === 'Network.responseReceived')
    return 'network-failures';
  if (method === 'Page.lifecycleEvent' || method === 'Page.frameNavigated')
    return 'lifecycle';
  return undefined;
}

export class DevToolsManager {
  private _browserSession: Promise<pw.CDPSession> | undefined;
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
    const channel = await this._ensurePageChannel(page);
    if (channel.monitors.size >= MAX_MONITORS_PER_PAGE)
      throw new Error(`browser_devtools allows at most ${MAX_MONITORS_PER_PAGE} monitors per page.`);
    if (this._monitors.size >= MAX_MONITORS)
      throw new Error(`browser_devtools allows at most ${MAX_MONITORS} monitors per browser context.`);

    for (const signal of new Set(signals)) {
      if (signal === 'runtime') {
        await this._enableOnce(channel, 'Runtime', async () => {
          await channel.session.send('Runtime.enable');
        });
      } else if (signal === 'network-failures') {
        await this._enableOnce(channel, 'Network', async () => {
          await channel.session.send('Network.enable');
        });
      } else if (signal === 'lifecycle') {
        await this._enableOnce(channel, 'Page.lifecycle', async () => {
          await channel.session.send('Page.enable');
          await channel.session.send('Page.setLifecycleEventsEnabled', { enabled: true });
        });
      }
    }

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
    return {
      id,
      page: { title: await page.title(), url: page.url() },
      signals: [...monitor.signals],
    };
  }

  readMonitor(id: string, limit: number, clear: boolean) {
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
    this._pageChannels.clear();
    const browserSession = this._browserSession;
    this._browserSession = undefined;

    await Promise.allSettled(pageChannels.map(async pending => {
      const channel = await pending;
      channel.closed = true;
      await channel.session.detach();
    }));
    if (browserSession) {
      await Promise.resolve(browserSession)
        .then(session => session.detach())
        .catch(() => {});
    }
    this._monitors.clear();
  }

  private async _ensureBrowserSession(page: pw.Page): Promise<pw.CDPSession> {
    this._assertActive();
    const browser = browserForPage(page);
    if (!this._browserSession) {
      const pending = browser.newBrowserCDPSession();
      this._browserSession = pending;
      pending.then(session => {
        session.on('close', () => {
          if (this._browserSession === pending) this._browserSession = undefined;
        });
      }).catch(() => {
        if (this._browserSession === pending) this._browserSession = undefined;
      });
    }
    return this._browserSession;
  }

  private async _ensurePageChannel(page: pw.Page): Promise<PageChannel> {
    this._assertActive();
    browserForPage(page);
    let pending = this._pageChannels.get(page);
    if (!pending) {
      pending = this._createPageChannel(page);
      this._pageChannels.set(page, pending);
      const captured = pending;
      pending.catch(() => {
        if (this._pageChannels.get(page) === captured) this._pageChannels.delete(page);
      });
    }
    return pending;
  }

  private async _createPageChannel(page: pw.Page): Promise<PageChannel> {
    const session = await page.context().newCDPSession(page);
    const channel: PageChannel = {
      session,
      enabled: new Map(),
      monitors: new Set(),
      closed: false,
    };
    session.on('event', ({ method, params }) => {
      this._captureEvent(channel, method, (params ?? {}) as Record<string, any>);
    });
    session.on('close', () => this._closePage(page, 'CDP session closed', false));
    page.on('close', () => this._closePage(page, 'page closed', true));
    return channel;
  }

  private async _enableOnce(
    channel: PageChannel,
    key: string,
    enable: () => Promise<void>,
  ): Promise<void> {
    let pending = channel.enabled.get(key);
    if (!pending) {
      pending = enable();
      channel.enabled.set(key, pending);
      const captured = pending;
      pending.catch(() => {
        if (channel.enabled.get(key) === captured) channel.enabled.delete(key);
      });
    }
    await pending;
  }

  private _captureEvent(channel: PageChannel, method: string, params: Record<string, any>) {
    const signal = signalForEvent(method);
    if (!signal) return;
    const event = sanitizeEvent(method, params);
    if (!event) return;

    for (const id of channel.monitors) {
      const monitor = this._monitors.get(id);
      if (!monitor || monitor.closed || !monitor.signals.has(signal)) continue;
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

  private _monitorOrDie(id: string): Monitor {
    const monitor = this._monitors.get(id);
    if (!monitor) throw new Error(`DevTools monitor ${id} not found.`);
    return monitor;
  }

  private _assertActive() {
    if (this._disposed) throw new Error('DevTools manager is disposed.');
  }
}
