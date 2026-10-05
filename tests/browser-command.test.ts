import path from 'node:path';
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
    on: vi.fn(),
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

const toolModules = import.meta.glob<{ default: Array<{ schema: { name: string } }> }>(
  '../src/tools/*.ts',
  { eager: true },
);
const extensionRoot = path.resolve(import.meta.dirname, '..');

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
  const registerTool = vi.fn();
  const pi = {
    registerTool,
    registerCommand: vi.fn((name: string, definition: BrowserCommand) => {
      if (name === 'browser') command = definition;
    }),
    on: vi.fn(),
    exec,
  };
  browserControl(pi as never);

  const notify = vi.fn();
  const ctx = { ui: { notify } };
  return { command: command!, ctx, exec, notify, registerTool };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('browser-control registration', () => {
  it('registers every implemented tool exactly once, all with deferred exposure', () => {
    const { registerTool } = loadExtension({ stdout: '', stderr: '', code: 0, killed: false });
    const definitions = registerTool.mock.calls.map(([definition]) => definition);
    const registered = definitions.map(definition => definition.name);
    const implemented = Object.values(toolModules)
      .flatMap(module => module.default)
      .map(tool => tool.schema.name);

    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...implemented].sort());
    expect(definitions.filter(definition => definition.exposure !== 'deferred')).toEqual([]);
  });

  it('registers one compact browser_devtools surface', () => {
    const { registerTool } = loadExtension({ stdout: '', stderr: '', code: 0, killed: false });

    const matches = registerTool.mock.calls
      .map(([definition]) => definition)
      .filter(definition => definition.name === 'browser_devtools');

    expect(matches).toHaveLength(1);
  });

  it('keeps snapshot guidance in the tool description rather than system-prompt metadata', () => {
    const { registerTool } = loadExtension({ stdout: '', stderr: '', code: 0, killed: false });
    const snapshot = registerTool.mock.calls
      .map(([definition]) => definition)
      .find(definition => definition.name === 'browser_snapshot');

    expect(snapshot.description).toContain('check the snapshot included in action responses');
    expect(snapshot).not.toHaveProperty('promptGuidelines');
    expect(snapshot).not.toHaveProperty('promptSnippet');
  });
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
      [path.join(extensionRoot, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
      { cwd: extensionRoot, timeout: 600000 },
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
