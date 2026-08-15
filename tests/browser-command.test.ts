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
  };
  browserContext.browser.mockReturnValue(browser);
  return {
    browserContext,
    launchPersistentContext: vi.fn(),
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
    launchPersistentContext: playwright.launchPersistentContext,
    connectOverCDP: vi.fn(),
  },
  firefox: { launch: vi.fn(), launchPersistentContext: vi.fn() },
  webkit: { launch: vi.fn(), launchPersistentContext: vi.fn() },
}));

import browserControl from '../index';

const missingExecutable = new Error(
  "browserType.launchPersistentContext: Executable doesn't exist at /cache/chromium/chrome\n" +
  'Please run the following command to download new browsers:\n\n    npx playwright install',
);

type BrowserCommand = {
  handler: (args: string, ctx: any) => Promise<void>;
};

function loadExtension(execResult: { stdout: string; stderr: string; code: number; killed: boolean }) {
  let command: BrowserCommand | undefined;
  const exec = vi.fn(async () => execResult);
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn((name: string, definition: BrowserCommand) => {
      if (name === 'browser') command = definition;
    }),
    on: vi.fn(),
    exec,
  };
  browserControl(pi as never);

  const notify = vi.fn();
  const ctx = { ui: { notify } };
  return { command: command!, ctx, exec, notify };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/browser launch provisioning', () => {
  it('uses the extension-local Playwright CLI and retries launch once', async () => {
    playwright.launchPersistentContext
      .mockRejectedValueOnce(missingExecutable)
      .mockResolvedValueOnce(playwright.browserContext);
    const { command, ctx, exec, notify } = loadExtension({
      stdout: '',
      stderr: '',
      code: 0,
      killed: false,
    });

    await command.handler('launch chromium', ctx);

    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/browser-control\/node_modules\/playwright\/cli\.js$/),
        'install',
        'chromium',
      ],
      {
        cwd: expect.stringMatching(/browser-control$/),
        timeout: 600000,
      },
    );
    expect(playwright.launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('Launched chromium.', 'info');
  });

  it('surfaces installer failure and does not retry launch', async () => {
    playwright.launchPersistentContext.mockRejectedValueOnce(missingExecutable);
    const { command, ctx, exec, notify } = loadExtension({
      stdout: '',
      stderr: 'download unavailable',
      code: 1,
      killed: false,
    });

    await command.handler('launch chromium', ctx);

    expect(exec).toHaveBeenCalledOnce();
    expect(playwright.launchPersistentContext).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(
      'Launch failed: Failed to install Playwright chromium: download unavailable',
      'error',
    );
  });
});
