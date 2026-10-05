import { existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playwright = vi.hoisted(() => {
  const browserListeners = new Map<string, Array<() => void>>();
  const browserContext = {
    pages: vi.fn(() => []),
    on: vi.fn(),
    browser: vi.fn(),
  };
  const browser = {
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => browserContext),
    contexts: vi.fn(() => [browserContext]),
    on: vi.fn((event: string, listener: () => void) => {
      const listeners = browserListeners.get(event) ?? [];
      listeners.push(listener);
      browserListeners.set(event, listeners);
    }),
    emit: (event: string) => {
      for (const listener of browserListeners.get(event) ?? []) listener();
    },
  };
  browserContext.browser.mockReturnValue(browser);
  const chromiumLaunch = vi.fn(async () => browser);
  const chromiumLaunchPersistentContext = vi.fn(async () => browserContext);
  const chromiumConnectOverCDP = vi.fn(async () => browser);
  // An existing file stands in for an installed browser; tests point it elsewhere to simulate a missing one.
  const chromiumExecutablePath = vi.fn(() => import.meta.filename);
  const resetBrowserListeners = () => browserListeners.clear();
  return {
    browser,
    browserContext,
    chromiumLaunch,
    chromiumLaunchPersistentContext,
    chromiumConnectOverCDP,
    chromiumExecutablePath,
    resetBrowserListeners,
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: playwright.chromiumLaunch,
    launchPersistentContext: playwright.chromiumLaunchPersistentContext,
    connectOverCDP: playwright.chromiumConnectOverCDP,
    executablePath: playwright.chromiumExecutablePath,
  },
  firefox: { launch: vi.fn(), launchPersistentContext: vi.fn(), executablePath: vi.fn(() => import.meta.filename) },
  webkit: { launch: vi.fn(), launchPersistentContext: vi.fn(), executablePath: vi.fn(() => import.meta.filename) },
}));

import { BrowserSession, parseBrowserName } from '../src/browser-session';

const missingBrowser = path.join(os.tmpdir(), `browser-session-missing-${process.pid}`);

beforeEach(() => {
  vi.clearAllMocks();
  playwright.chromiumExecutablePath.mockReturnValue(import.meta.filename);
  playwright.resetBrowserListeners();
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => [] })));
});

afterEach(() => {
  rmSync(missingBrowser, { force: true });
});

describe('parseBrowserName', () => {
  it('defaults to chromium and accepts every supported isolated browser', () => {
    expect(parseBrowserName()).toBe('chromium');
    expect(parseBrowserName('chromium')).toBe('chromium');
    expect(parseBrowserName('firefox')).toBe('firefox');
    expect(parseBrowserName('webkit')).toBe('webkit');
  });

  it('rejects unsupported browser names before launch', () => {
    expect(() => parseBrowserName('safari')).toThrow(
      'Unsupported browser "safari". Choose chromium, firefox, or webkit.',
    );
  });
});

describe('BrowserSession CDP disconnect', () => {
  it('disposes the context after an unexpected browser disconnect', async () => {
    const session = new BrowserSession();
    await session.connect({ type: 'cdp', port: 9222 });
    const context = session.context!;
    const dispose = vi.spyOn(context, 'dispose').mockResolvedValue();

    playwright.browser.emit('disconnected');
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(session.context).toBeNull();
    expect(session.status()).toBe('disconnected');
  });
});

describe('BrowserSession isolated mode', () => {
  it('launches a fresh browser context without a persistent profile', async () => {
    const session = new BrowserSession();

    await session.connect({ type: 'isolated', browserName: 'chromium' });

    expect(playwright.chromiumLaunch).toHaveBeenCalledWith({
      headless: false,
      handleSIGINT: false,
      handleSIGTERM: false,
    });
    expect(playwright.browser.newContext).toHaveBeenCalledOnce();
    expect(session.status()).toBe('connected (isolated chromium)');
    await session.disconnect();
  });
});

describe('BrowserSession connect failure', () => {
  it('closes the browser and reports disconnected when the CDP target list cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    const session = new BrowserSession();

    await expect(session.connect({ type: 'cdp', port: 9222 })).rejects.toThrow('connect ECONNREFUSED');

    expect(playwright.browser.close).toHaveBeenCalledOnce();
    expect(session.context).toBeNull();
    expect(session.status()).toBe('disconnected');
  });

  it('closes a launched isolated browser when its context cannot be created', async () => {
    playwright.browser.newContext.mockRejectedValueOnce(new Error('context failed'));
    const session = new BrowserSession();

    await expect(session.connect({ type: 'isolated', browserName: 'chromium' })).rejects.toThrow(
      'context failed',
    );

    expect(playwright.browser.close).toHaveBeenCalledOnce();
    expect(session.status()).toBe('disconnected');
  });
});

describe('BrowserSession browser provisioning', () => {
  it('installs a missing browser before the persistent launch', async () => {
    playwright.chromiumExecutablePath.mockReturnValue(missingBrowser);
    const installBrowser = vi.fn(async () => { writeFileSync(missingBrowser, ''); });
    const session = new BrowserSession();

    await session.connect(
      { type: 'launch', browserName: 'chromium' },
      {},
      installBrowser,
    );

    expect(installBrowser).toHaveBeenCalledOnce();
    expect(installBrowser).toHaveBeenCalledWith('chromium');
    expect(playwright.chromiumLaunchPersistentContext).toHaveBeenCalledOnce();
    expect(existsSync(missingBrowser)).toBe(true);
  });

  it('does not install a browser that is already present', async () => {
    const installBrowser = vi.fn(async () => {});
    const session = new BrowserSession();

    await session.connect({ type: 'isolated', browserName: 'chromium' }, {}, installBrowser);

    expect(installBrowser).not.toHaveBeenCalled();
    expect(playwright.chromiumLaunch).toHaveBeenCalledOnce();
  });

  it('does not launch when installing a missing browser fails', async () => {
    playwright.chromiumExecutablePath.mockReturnValue(missingBrowser);
    const installBrowser = vi.fn(async () => { throw new Error('download unavailable'); });
    const session = new BrowserSession();

    await expect(session.connect(
      { type: 'launch', browserName: 'chromium' },
      {},
      installBrowser,
    )).rejects.toThrow('download unavailable');

    expect(playwright.chromiumLaunchPersistentContext).not.toHaveBeenCalled();
    expect(session.status()).toBe('disconnected');
  });

  it('does not install after an unrelated launch error', async () => {
    playwright.chromiumLaunch.mockRejectedValueOnce(new Error('Browser closed during startup'));
    const installBrowser = vi.fn(async () => {});
    const session = new BrowserSession();

    await expect(session.connect(
      { type: 'isolated', browserName: 'chromium' },
      {},
      installBrowser,
    )).rejects.toThrow('Browser closed during startup');

    expect(installBrowser).not.toHaveBeenCalled();
    expect(playwright.chromiumLaunch).toHaveBeenCalledOnce();
  });
});
