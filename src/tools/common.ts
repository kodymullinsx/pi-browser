import { defineTool, defineTabTool } from '../tool';

export const close = defineTool({
  schema: { name: 'browser_close' },
  handle: async (context, _params, result) => {
    // Closing with nothing open is a successful no-op, as it was before the close fix.
    if (!context.currentTab()) {
      result.setClose();
      result.addTextResult('No page was open.');
      return;
    }
    await context.closeTab(undefined);
    result.addCode('await page.close();');
    result.setClose();
    result.addTextResult('Page closed.');
  },
});

export const resize = defineTabTool({
  schema: { name: 'browser_resize' },
  handle: async (tab, params, result) => {
    await tab.page.setViewportSize({ width: params.width, height: params.height });
    result.addCode(`await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`);
    result.addTextResult(`Resized to ${params.width}x${params.height}`);
  },
});

export default [close, resize];
