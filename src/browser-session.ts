/**
 * BrowserSession - manages the Browser and Context lifecycle.
 * Handles CDP attach, persistent launch, and isolated launch modes.
 */

import * as pw from 'playwright';
import { Context } from './context';
import type { ContextConfig } from './context';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type BrowserInstaller = (browserName: BrowserName) => Promise<void>;

export type ConnectionMode =
  | { type: 'cdp'; port: number }
  | { type: 'launch'; browserName?: BrowserName }
  | { type: 'isolated'; browserName?: BrowserName };

export function parseBrowserName(value = 'chromium'): BrowserName {
  if (value === 'chromium' || value === 'firefox' || value === 'webkit') return value;
  throw new Error(`Unsupported browser "${value}". Choose chromium, firefox, or webkit.`);
}

function isMissingBrowserExecutable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Executable doesn't exist at") &&
    error.message.includes('playwright install');
}

export class BrowserSession {
  private _browser: pw.Browser | null = null;
  private _context: Context | null = null;
  private _mode: ConnectionMode | null = null;

  get context(): Context | null {
    return this._context;
  }

  get isConnected(): boolean {
    return this._browser !== null && this._browser.isConnected();
  }

  async connect(
    mode: ConnectionMode,
    config: ContextConfig = {},
    installBrowser?: BrowserInstaller,
  ): Promise<void> {
    if (this._browser)
      await this.disconnect();

    this._mode = mode;

    const launch = async <T>(browserName: BrowserName, operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        if (!installBrowser || !isMissingBrowserExecutable(error)) throw error;
        await installBrowser(browserName);
        return operation();
      }
    };

    switch (mode.type) {
      case 'cdp': {
        const endpoint = `http://localhost:${mode.port}`;
        this._browser = await pw.chromium.connectOverCDP(endpoint);

        let contexts = this._browser.contexts();
        if (contexts.length === 0) await this._browser.newContext();
        contexts = this._browser.contexts();

        // Also fetch the full tab list from CDP so Context can show tabs
        // in other windows that Playwright can't directly control.
        const resp = await fetch(`${endpoint}/json/list`);
        const allTargets: CdpTarget[] = await resp.json();

        this._context = new Context(contexts, config, { port: mode.port, allTargets });
        this._browser.on('disconnected', () => { this._browser = null; this._context = null; });
        break;
      }

      case 'launch': {
        const browserName = mode.browserName ?? 'chromium';
        const browserType = pw[browserName];
        const browserContext = await launch(browserName, () => browserType.launchPersistentContext('', {
          headless: false,
          handleSIGINT: false,
          handleSIGTERM: false,
        }));
        this._browser = browserContext.browser()!;
        this._context = new Context(browserContext, config);
        break;
      }

      case 'isolated': {
        const browserName = mode.browserName ?? 'chromium';
        const browserType = pw[browserName];
        this._browser = await launch(browserName, () => browserType.launch({
          headless: false,
          handleSIGINT: false,
          handleSIGTERM: false,
        }));
        const browserContext = await this._browser.newContext();
        this._context = new Context(browserContext, config);
        break;
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this._context) {
      await this._context.dispose();
      this._context = null;
    }
    if (this._browser) {
      try { await this._browser.close(); } catch { /* ignore */ }
      this._browser = null;
    }
    this._mode = null;
  }

  status(): string {
    if (!this._browser || !this._browser.isConnected())
      return 'disconnected';
    const mode = this._mode;
    if (!mode) return 'disconnected';
    if (mode.type === 'cdp')
      return `connected via CDP (port ${(mode as { type: 'cdp'; port: number }).port})`;
    if (mode.type === 'launch')
      return `connected (launched ${(mode as { type: 'launch'; browserName?: string }).browserName ?? 'chromium'})`;
    return `connected (isolated ${(mode as { type: 'isolated'; browserName?: string }).browserName ?? 'chromium'})`;
  }
}

export type CdpTarget = {
  type: string;
  url: string;
  title: string;
  id: string;
  webSocketDebuggerUrl: string;
};
