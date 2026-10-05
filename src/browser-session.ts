/**
 * BrowserSession - manages the Browser and Context lifecycle.
 * Handles CDP attach, persistent launch, and isolated launch modes.
 */

import { existsSync } from 'node:fs';
import * as pw from 'playwright';
import { Context } from './context';
import type { ContextConfig } from './context';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type BrowserInstaller = (browserName: BrowserName) => Promise<void>;

export type ConnectionMode =
  | { type: 'cdp'; port: number }
  | { type: 'launch'; browserName: BrowserName }
  | { type: 'isolated'; browserName: BrowserName };

export function parseBrowserName(value = 'chromium'): BrowserName {
  if (value === 'chromium' || value === 'firefox' || value === 'webkit') return value;
  throw new Error(`Unsupported browser "${value}". Choose chromium, firefox, or webkit.`);
}

/** True when Playwright's matching browser build is not on disk. */
function isBrowserMissing(browserType: pw.BrowserType): boolean {
  try {
    return !existsSync(browserType.executablePath());
  } catch {
    // Playwright cannot name an executable here; let launch report the real error.
    return false;
  }
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
    try {
      await this._open(mode, config, installBrowser);
    } catch (error) {
      // Do not leave a half-open browser or a mode that reports a connection.
      await this.disconnect();
      throw error;
    }

    const browser = this._browser!;
    const context = this._context!;
    browser.on('disconnected', () => {
      if (this._browser !== browser) return;
      this._browser = null;
      if (this._context !== context) return;
      this._context = null;
      void context.dispose().catch(() => {});
    });
  }

  private async _open(
    mode: ConnectionMode,
    config: ContextConfig,
    installBrowser?: BrowserInstaller,
  ): Promise<void> {
    const launchOptions = { headless: false, handleSIGINT: false, handleSIGTERM: false };
    const prepare = async (browserType: pw.BrowserType, browserName: BrowserName) => {
      if (installBrowser && isBrowserMissing(browserType))
        await installBrowser(browserName);
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
        break;
      }

      case 'launch': {
        const browserType = pw[mode.browserName];
        await prepare(browserType, mode.browserName);
        const browserContext = await browserType.launchPersistentContext('', launchOptions);
        this._browser = browserContext.browser()!;
        this._context = new Context(browserContext, config);
        break;
      }

      case 'isolated': {
        const browserType = pw[mode.browserName];
        await prepare(browserType, mode.browserName);
        this._browser = await browserType.launch(launchOptions);
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
    if (!this._browser || !this._browser.isConnected() || !this._mode)
      return 'disconnected';
    switch (this._mode.type) {
      case 'cdp': return `connected via CDP (port ${this._mode.port})`;
      case 'launch': return `connected (launched ${this._mode.browserName})`;
      case 'isolated': return `connected (isolated ${this._mode.browserName})`;
    }
  }
}

export type CdpTarget = {
  type: string;
  url: string;
  title: string;
  id: string;
  webSocketDebuggerUrl: string;
};
