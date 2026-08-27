import { describe, expect, it, vi } from 'vitest';
import { DevToolsManager } from '../src/devtools';
import { devtools as devtoolsTool } from '../src/tools/devtools';

type Listener = (...args: any[]) => void;

function makeEmitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(event: string, listener: Listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

function makeHarness(browserName = 'chromium') {
  const pageEvents = makeEmitter();
  const pageSessionEvents = makeEmitter();
  const browserSessionEvents = makeEmitter();

  const pageSession = {
    on: vi.fn(pageSessionEvents.on),
    send: vi.fn(async (method: string) => {
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'Documents', value: 2 }, { name: 'JSHeapUsedSize', value: 512 }] };
      }
      return {};
    }),
    detach: vi.fn(async () => {}),
    emit: pageSessionEvents.emit,
  };

  const browserSession = {
    on: vi.fn(browserSessionEvents.on),
    send: vi.fn(async (method: string) => {
      if (method === 'Browser.getVersion') {
        return {
          protocolVersion: '1.3',
          product: 'Chrome/151.0.7922.34',
          revision: '@revision',
          userAgent: 'Chrome test agent',
          jsVersion: '15.1',
        };
      }
      if (method === 'Target.getTargets') {
        return {
          targetInfos: [
            { type: 'page', targetId: 'page-1', title: 'Example', url: 'https://example.com', attached: true, canAccessOpener: false },
            { type: 'service_worker', targetId: 'worker-1', title: '', url: 'https://example.com/sw.js', attached: false, canAccessOpener: false },
          ],
        };
      }
      return {};
    }),
    detach: vi.fn(async () => {}),
    emit: browserSessionEvents.emit,
  };

  const browser = {
    browserType: () => ({ name: () => browserName }),
    newBrowserCDPSession: vi.fn(async () => browserSession),
  };
  const context = {
    browser: () => browser,
    newCDPSession: vi.fn(async () => pageSession),
  };
  const page = {
    context: () => context,
    url: () => 'https://example.com',
    title: async () => 'Example',
    on: vi.fn(pageEvents.on),
    emit: pageEvents.emit,
  };

  return { page, context, browser, pageSession, browserSession };
}

describe('browser_devtools tool', () => {
  it('reads an existing monitor without opening a new page', async () => {
    const readMonitor = vi.fn(() => ({ id: 'monitor-1', events: [] }));
    const ensureTab = vi.fn();
    const addTextResult = vi.fn();
    const context = {
      devtools: () => ({ readMonitor }),
      ensureTab,
    };

    await devtoolsTool.handle(
      context as any,
      { action: 'monitor_read', monitorId: 'monitor-1' },
      { addTextResult } as any,
    );

    expect(readMonitor).toHaveBeenCalledWith('monitor-1', 100, false);
    expect(ensureTab).not.toHaveBeenCalled();
  });
});

describe('DevToolsManager', () => {
  it('returns browser metadata and enables page performance metrics once', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();

    const info = await manager.info(harness.page as any);
    const [firstMetrics, secondMetrics] = await Promise.all([
      manager.metrics(harness.page as any),
      manager.metrics(harness.page as any),
    ]);

    expect(info).toEqual({
      product: 'Chrome/151.0.7922.34',
      revision: '@revision',
      protocolVersion: '1.3',
      jsVersion: '15.1',
      targetCounts: { page: 1, service_worker: 1 },
      page: { title: 'Example', url: 'https://example.com' },
    });
    expect(firstMetrics).toEqual({ Documents: 2, JSHeapUsedSize: 512 });
    expect(secondMetrics).toEqual(firstMetrics);
    expect(harness.browser.newBrowserCDPSession).toHaveBeenCalledOnce();
    expect(harness.context.newCDPSession).toHaveBeenCalledOnce();
    expect(harness.pageSession.send.mock.calls.filter(([method]) => method === 'Performance.enable')).toHaveLength(1);
  });

  it('buffers only curated monitor events and reports dropped events', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();
    const monitor = await manager.startMonitor(
      harness.page as any,
      ['runtime', 'network-failures', 'lifecycle'],
      2,
    );

    harness.pageSession.emit('event', {
      method: 'Runtime.exceptionThrown',
      params: {
        timestamp: 1,
        exceptionDetails: {
          text: 'Uncaught',
          url: 'https://example.com/app.js',
          lineNumber: 4,
          columnNumber: 2,
          exception: { description: 'Error: boom', objectId: 'secret-handle' },
        },
      },
    });
    harness.pageSession.emit('event', {
      method: 'Network.responseReceived',
      params: {
        requestId: 'request-1',
        timestamp: 2,
        type: 'Fetch',
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          url: 'https://example.com/api',
          mimeType: 'application/json',
          protocol: 'h2',
          headers: { authorization: 'secret' },
        },
      },
    });
    harness.pageSession.emit('event', {
      method: 'Page.lifecycleEvent',
      params: { frameId: 'frame-1', loaderId: 'loader-1', name: 'load', timestamp: 3 },
    });
    harness.pageSession.emit('event', {
      method: 'Network.responseReceived',
      params: { response: { status: 204, url: 'https://example.com/ok' } },
    });

    const result = manager.readMonitor(monitor.id, 10, false);

    expect(result.dropped).toBe(1);
    expect(result.events).toHaveLength(2);
    expect(result.events.map(event => event.method)).toEqual([
      'Network.responseReceived',
      'Page.lifecycleEvent',
    ]);
    expect(JSON.stringify(result.events)).not.toContain('authorization');
    expect(JSON.stringify(result.events)).not.toContain('secret-handle');
    expect(harness.pageSession.send).toHaveBeenCalledWith('Runtime.enable');
    expect(harness.pageSession.send).toHaveBeenCalledWith('Network.enable');
    expect(harness.pageSession.send).toHaveBeenCalledWith('Page.enable');
    expect(harness.pageSession.send).toHaveBeenCalledWith('Page.setLifecycleEventsEnabled', { enabled: true });

    const limited = manager.readMonitor(monitor.id, 1, false);
    expect(limited.events).toHaveLength(1);
    expect(limited.truncated).toBe(true);

    manager.readMonitor(monitor.id, 10, true);
    expect(manager.readMonitor(monitor.id, 10, false).events).toEqual([]);
  });

  it('caps monitor reads before they overload tool context', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();
    const monitor = await manager.startMonitor(harness.page as any, ['runtime'], 100);

    for (let i = 0; i < 20; i++) {
      harness.pageSession.emit('event', {
        method: 'Runtime.exceptionThrown',
        params: {
          exceptionDetails: {
            text: `Exception ${i}`,
            exception: { description: 'x'.repeat(4_000) },
          },
        },
      });
    }

    const read = manager.readMonitor(monitor.id, 100, false);
    expect(read.truncated).toBe(true);
    expect(JSON.stringify(read).length).toBeLessThan(31_000);
  });

  it('keeps one large sanitized event readable and clearable', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();
    const monitor = await manager.startMonitor(harness.page as any, ['runtime'], 10);

    harness.pageSession.emit('event', {
      method: 'Runtime.exceptionThrown',
      params: {
        exceptionDetails: {
          text: 'Large exception',
          exception: { description: 'x'.repeat(10_000) },
          stackTrace: {
            callFrames: Array.from({ length: 20 }, () => ({
              functionName: 'f'.repeat(1_000),
              url: `https://example.com/${'u'.repeat(4_000)}`,
              lineNumber: 1,
              columnNumber: 2,
            })),
          },
        },
      },
    });

    const read = manager.readMonitor(monitor.id, 1, true);
    expect(read.events).toHaveLength(1);
    expect(read.truncated).toBe(false);
    expect(JSON.stringify(read).length).toBeLessThan(31_000);
    expect(manager.readMonitor(monitor.id, 1, false).events).toEqual([]);
  });

  it('bounds concurrent monitors per page', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();

    for (let i = 0; i < 4; i++)
      await manager.startMonitor(harness.page as any, ['runtime'], 10);

    await expect(manager.startMonitor(harness.page as any, ['runtime'], 10)).rejects.toThrow(
      'browser_devtools allows at most 4 monitors per page.',
    );
  });

  it('bounds monitors across the browser context', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();
    const pages = Array.from({ length: 5 }, (_, index) => ({
      ...harness.page,
      url: () => `https://example.com/${index}`,
    }));

    for (const page of pages.slice(0, 4)) {
      for (let i = 0; i < 4; i++)
        await manager.startMonitor(page as any, ['runtime'], 10);
    }

    await expect(manager.startMonitor(pages[4] as any, ['runtime'], 10)).rejects.toThrow(
      'browser_devtools allows at most 16 monitors per browser context.',
    );
  });

  it('binds monitors to their page and cleans up sessions', async () => {
    const harness = makeHarness();
    const manager = new DevToolsManager();
    const monitor = await manager.startMonitor(harness.page as any, ['runtime'], 10);
    await manager.info(harness.page as any);

    harness.page.emit('close');
    await Promise.resolve();

    expect(manager.readMonitor(monitor.id, 10, false)).toMatchObject({
      closed: true,
      closeReason: 'page closed',
    });
    expect(harness.pageSession.detach).toHaveBeenCalledOnce();

    await manager.dispose();
    expect(harness.browserSession.detach).toHaveBeenCalledOnce();
  });

  it('rejects non-Chromium browsers explicitly', async () => {
    const harness = makeHarness('firefox');
    const manager = new DevToolsManager();

    await expect(manager.metrics(harness.page as any)).rejects.toThrow(
      'browser_devtools requires Chromium; current browser is firefox.',
    );
  });
});
