import { beforeEach, describe, expect, it, vi } from 'vitest';

const playwright = vi.hoisted(() => {
  const browserContext = {
    pages: vi.fn(() => []),
    on: vi.fn(),
    browser: vi.fn(),
  };
  const browser = {
    close: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => browserContext),
  };
  browserContext.browser.mockReturnValue(browser);
  const chromiumLaunch = vi.fn(async () => browser);
  const chromiumLaunchPersistentContext = vi.fn(async () => browserContext);
  return { browser, browserContext, chromiumLaunch, chromiumLaunchPersistentContext };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: playwright.chromiumLaunch,
    launchPersistentContext: playwright.chromiumLaunchPersistentContext,
    connectOverCDP: vi.fn(),
  },
  firefox: { launch: vi.fn(), launchPersistentContext: vi.fn() },
  webkit: { launch: vi.fn(), launchPersistentContext: vi.fn() },
}));

import { BrowserSession, parseBrowserName } from '../src/browser-session';

beforeEach(() => {
  vi.clearAllMocks();
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

describe('BrowserSession browser provisioning', () => {
  it('installs a missing browser and retries persistent launch once', async () => {
    const missingExecutable = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /cache/chromium-1228/chrome\n" +
      'Please run the following command to download new browsers:\n\n    npx playwright install',
    );
    playwright.chromiumLaunchPersistentContext
      .mockRejectedValueOnce(missingExecutable)
      .mockResolvedValueOnce(playwright.browserContext);
    const installBrowser = vi.fn(async () => {});
    const session = new BrowserSession();

    await session.connect(
      { type: 'launch', browserName: 'chromium' },
      {},
      installBrowser,
    );

    expect(installBrowser).toHaveBeenCalledOnce();
    expect(installBrowser).toHaveBeenCalledWith('chromium');
    expect(playwright.chromiumLaunchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('does not install or retry after an unrelated launch error', async () => {
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
