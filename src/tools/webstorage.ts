import { defineTabTool } from '../tool';

// LocalStorage

export const localStorageList = defineTabTool({
  schema: { name: 'browser_localstorage_list' },
  handle: async (tab, _p, result) => {
    const items: { key: string; value: string }[] = await tab.page.evaluate(() => {
      const r: { key: string; value: string }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null) r.push({ key: k, value: localStorage.getItem(k) ?? '' });
      }
      return r;
    });
    result.addTextResult(items.length ? items.map(i => `${i.key}=${i.value}`).join('\n') : 'localStorage is empty.');
  },
});

export const localStorageGet = defineTabTool({
  schema: { name: 'browser_localstorage_get' },
  handle: async (tab, params, result) => {
    const value: string | null = await tab.page.evaluate((key: string) => localStorage.getItem(key), params.key);
    result.addTextResult(value !== null ? `${params.key}=${value}` : `Key '${params.key}' not found.`);
  },
});

export const localStorageSet = defineTabTool({
  schema: { name: 'browser_localstorage_set' },
  handle: async (tab, params, result) => {
    await tab.page.evaluate(([key, value]: string[]) => localStorage.setItem(key, value), [params.key, params.value]);
    result.addTextResult(`localStorage['${params.key}'] set.`);
    result.addCode(`await page.evaluate(() => localStorage.setItem('${params.key}', '${params.value}'));`);
  },
});

export const localStorageDelete = defineTabTool({
  schema: { name: 'browser_localstorage_delete' },
  handle: async (tab, params, result) => {
    await tab.page.evaluate((key: string) => localStorage.removeItem(key), params.key);
    result.addTextResult(`localStorage['${params.key}'] deleted.`);
  },
});

export const localStorageClear = defineTabTool({
  schema: { name: 'browser_localstorage_clear' },
  handle: async (tab, _p, result) => {
    await tab.page.evaluate(() => localStorage.clear());
    result.addTextResult('localStorage cleared.');
  },
});

// SessionStorage

export const sessionStorageList = defineTabTool({
  schema: { name: 'browser_sessionstorage_list' },
  handle: async (tab, _p, result) => {
    const items: { key: string; value: string }[] = await tab.page.evaluate(() => {
      const r: { key: string; value: string }[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k !== null) r.push({ key: k, value: sessionStorage.getItem(k) ?? '' });
      }
      return r;
    });
    result.addTextResult(items.length ? items.map(i => `${i.key}=${i.value}`).join('\n') : 'sessionStorage is empty.');
  },
});

export const sessionStorageGet = defineTabTool({
  schema: { name: 'browser_sessionstorage_get' },
  handle: async (tab, params, result) => {
    const value: string | null = await tab.page.evaluate((key: string) => sessionStorage.getItem(key), params.key);
    result.addTextResult(value !== null ? `${params.key}=${value}` : `Key '${params.key}' not found.`);
  },
});

export const sessionStorageSet = defineTabTool({
  schema: { name: 'browser_sessionstorage_set' },
  handle: async (tab, params, result) => {
    await tab.page.evaluate(([key, value]: string[]) => sessionStorage.setItem(key, value), [params.key, params.value]);
    result.addTextResult(`sessionStorage['${params.key}'] set.`);
  },
});

export const sessionStorageDelete = defineTabTool({
  schema: { name: 'browser_sessionstorage_delete' },
  handle: async (tab, params, result) => {
    await tab.page.evaluate((key: string) => sessionStorage.removeItem(key), params.key);
    result.addTextResult(`sessionStorage['${params.key}'] deleted.`);
  },
});

export const sessionStorageClear = defineTabTool({
  schema: { name: 'browser_sessionstorage_clear' },
  handle: async (tab, _p, result) => {
    await tab.page.evaluate(() => sessionStorage.clear());
    result.addTextResult('sessionStorage cleared.');
  },
});

export default [
  localStorageList, localStorageGet, localStorageSet, localStorageDelete, localStorageClear,
  sessionStorageList, sessionStorageGet, sessionStorageSet, sessionStorageDelete, sessionStorageClear,
];
