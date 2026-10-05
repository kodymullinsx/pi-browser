import { defineTool, defineTabTool } from '../tool';

export const navigate = defineTool({
  schema: { name: 'browser_navigate' },
  handle: async (context, params, result) => {
    const tab = await context.ensureTab();
    let url: string = params.url;
    try { new URL(url); } catch {
      url = url.startsWith('localhost') ? 'http://' + url : 'https://' + url;
    }
    await tab.navigate(url);
    result.addCode(`await page.goto('${url}');`);
    result.setIncludeSnapshot();
  },
});

export const goBack = defineTabTool({
  schema: { name: 'browser_navigate_back' },
  handle: async (tab, _params, result) => {
    await tab.page.goBack(tab.navigationTimeoutOptions);
    result.addCode('await page.goBack();');
    result.setIncludeSnapshot();
  },
});

export const reload = defineTabTool({
  schema: { name: 'browser_reload' },
  handle: async (tab, _params, result) => {
    await tab.page.reload(tab.navigationTimeoutOptions);
    result.addCode('await page.reload();');
    result.setIncludeSnapshot();
  },
});

export default [navigate, goBack, reload];
