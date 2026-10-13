import { describe, it, expect } from 'vitest';
import { Context } from '../src/context';
import { BrowserToolResult } from '../src/response';
import { close } from '../src/tools/common';
import type { CdpTarget } from '../src/browser-session';

function makePage(url: string) {
  const listeners: Record<string, Function[]> = {};
  return {
    url: () => url,
    title: async () => url,
    close: async () => {
      (listeners['close'] ?? []).forEach(fn => fn());
    },
    bringToFront: async () => {},
    on: (event: string, fn: Function) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(fn);
    },
    emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach(fn => fn(...args));
    },
  };
}

function makeBrowserContext(pages: ReturnType<typeof makePage>[]) {
  const listeners: Record<string, Function[]> = {};
  return {
    pages: () => pages,
    on: (event: string, fn: Function) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(fn);
    },
    emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach(fn => fn(...args));
    },
    newPage: async () => {
      const p = makePage('about:blank');
      pages.push(p);
      (listeners['page'] ?? []).forEach(fn => fn(p));
      return p;
    },
    route: async () => {},
    unroute: async () => {},
    setOffline: async () => {},
    cookies: async () => [],
    addCookies: async () => {},
    clearCookies: async () => {},
    storageState: async () => ({}),
    addInitScript: async () => {},
  };
}

describe('Context', () => {
  describe('browser_close', () => {
    it('closes the selected page and keeps the other tab available', async () => {
      const pages = [makePage('https://first.test'), makePage('https://selected.test')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      await ctx.selectTab(1);
      const result = new BrowserToolResult(ctx);

      await close.handle(ctx, {}, result);

      expect(ctx.tabs().map(tab => tab.page.url())).toEqual(['https://first.test']);
      expect(ctx.currentTab()?.page).toBe(pages[0]);
      expect((await result.build()).details.tabs).toEqual([
        expect.objectContaining({ url: 'https://first.test', title: 'https://first.test', current: true }),
      ]);
    });

    it('removes the current tab when closing the last page', async () => {
      const ctx = new Context(makeBrowserContext([makePage('https://last.test')]) as any);
      const result = new BrowserToolResult(ctx);

      await close.handle(ctx, {}, result);

      expect(ctx.tabs()).toEqual([]);
      expect(ctx.currentTab()).toBeUndefined();
      expect((await result.build()).details).toEqual({ tabs: [], isClose: true });
    });

    it('succeeds when no page is open', async () => {
      const ctx = new Context(makeBrowserContext([]) as any);
      const result = new BrowserToolResult(ctx);

      await close.handle(ctx, {}, result);

      const response = await result.build();
      expect(response.details).toEqual({ tabs: [], isClose: true });
      expect(response.content).toEqual([{ type: 'text', text: expect.stringContaining('No page was open.') }]);
    });

    it('waits for page closure before reporting success', async () => {
      const page = makePage('https://pending.test');
      const finishClose = page.close;
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      page.close = async () => { await pending; await finishClose(); };
      const ctx = new Context(makeBrowserContext([page]) as any);
      const result = new BrowserToolResult(ctx);

      const handling = close.handle(ctx, {}, result);
      await Promise.resolve();
      const beforeClosure = await result.build();
      release();
      await handling;

      expect(beforeClosure.details.isClose).toBe(false);
      expect(beforeClosure.content).toEqual([{ type: 'text', text: expect.not.stringContaining('Page closed.') }]);
      expect(ctx.tabs()).toEqual([]);
    });

    it('propagates a close failure without claiming the page closed', async () => {
      const page = makePage('https://failure.test');
      page.close = async () => { throw new Error('Close rejected'); };
      const ctx = new Context(makeBrowserContext([page]) as any);
      const result = new BrowserToolResult(ctx);

      await expect(close.handle(ctx, {}, result)).rejects.toThrow('Close rejected');

      expect(ctx.currentTab()?.page).toBe(page);
      const response = await result.build();
      expect(response.details.isClose).toBe(false);
      expect(response.content).toEqual([{ type: 'text', text: expect.not.stringContaining('Page closed.') }]);
    });
  });

  describe('tab management', () => {
    it('registers pages from browserContext on construction', () => {
      const pages = [makePage('https://example.com'), makePage('https://github.com')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      expect(ctx.tabs()).toHaveLength(2);
    });

    it('sets the first page as current tab', () => {
      const pages = [makePage('https://example.com'), makePage('https://github.com')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      expect(ctx.currentTab()?.page.url()).toBe('https://example.com');
    });

    it('picks up new pages added after construction', () => {
      const pages = [makePage('https://example.com')];
      const bc = makeBrowserContext(pages);
      const ctx = new Context(bc as any);
      const newPage = makePage('https://new.com');
      pages.push(newPage);
      bc.emit('page', newPage);
      expect(ctx.tabs()).toHaveLength(2);
    });

    it('removes a tab when its page closes', () => {
      const pages = [makePage('https://example.com'), makePage('https://github.com')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      pages[1].emit('close');
      expect(ctx.tabs()).toHaveLength(1);
    });

    it('selects a tab by index', async () => {
      const pages = [makePage('https://example.com'), makePage('https://github.com')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      await ctx.selectTab(1);
      expect(ctx.currentTab()?.page.url()).toBe('https://github.com');
    });

    it('throws when selecting an out-of-range index', async () => {
      const pages = [makePage('https://example.com')];
      const ctx = new Context(makeBrowserContext(pages) as any);
      await expect(ctx.selectTab(5)).rejects.toThrow('Tab 5 not found');
    });
  });

  describe('CDP-only targets', () => {
    it('tracks CDP-only targets passed at construction', () => {
      const pages = [makePage('https://example.com')];
      const cdpTargets: CdpTarget[] = [{
        type: 'page',
        url: 'https://other.com',
        title: 'Other',
        id: 'abc',
        webSocketDebuggerUrl: 'ws://...',
      }];
      const ctx = new Context(makeBrowserContext(pages) as any, {}, { port: 9222, allTargets: cdpTargets });
      expect(ctx.cdpOnlyTargets()).toHaveLength(1);
      expect(ctx.cdpOnlyTargets()[0].url).toBe('https://other.com');
    });

    it('does not include CDP targets whose URL is already in a Playwright tab', () => {
      const pages = [makePage('https://example.com')];
      const cdpTargets: CdpTarget[] = [{
        type: 'page',
        url: 'https://example.com', // same as the Playwright tab
        title: 'Example',
        id: 'abc',
        webSocketDebuggerUrl: 'ws://...',
      }];
      const ctx = new Context(makeBrowserContext(pages) as any, {}, { port: 9222, allTargets: cdpTargets });
      expect(ctx.cdpOnlyTargets()).toHaveLength(0);
    });

    it('excludes about:blank from CDP-only targets', () => {
      const pages = [makePage('https://example.com')];
      const cdpTargets: CdpTarget[] = [{
        type: 'page',
        url: 'about:blank',
        title: '',
        id: 'abc',
        webSocketDebuggerUrl: 'ws://...',
      }];
      const ctx = new Context(makeBrowserContext(pages) as any, {}, { port: 9222, allTargets: cdpTargets });
      expect(ctx.cdpOnlyTargets()).toHaveLength(0);
    });
  });

  describe('allTabInfos', () => {
    it('returns Playwright tabs followed by CDP-only targets with correct indices', () => {
      const pages = [makePage('https://a.com'), makePage('https://b.com')];
      const cdpTargets: CdpTarget[] = [{
        type: 'page',
        url: 'https://c.com',
        title: 'C',
        id: 'abc',
        webSocketDebuggerUrl: 'ws://...',
      }];
      const ctx = new Context(makeBrowserContext(pages) as any, {}, { port: 9222, allTargets: cdpTargets });
      const infos = ctx.allTabInfos();
      expect(infos).toHaveLength(3);
      expect(infos[0].index).toBe(0);
      expect(infos[0].tab).toBeDefined();
      expect(infos[1].index).toBe(1);
      expect(infos[2].index).toBe(2);
      expect(infos[2].cdpTarget?.url).toBe('https://c.com');
    });
  });
});
