import { defineTabTool } from '../tool';

export const type = defineTabTool({
  schema: { name: 'browser_type' },
  handle: async (tab, params, result) => {
    const { locator, resolved } = await tab.refLocator(params);
    await tab.waitForCompletion(async () => {
      if (params.slowly) {
        await locator.pressSequentially(params.text, tab.actionTimeoutOptions);
        result.addCode(`await page.${resolved}.pressSequentially(${JSON.stringify(params.text)});`);
      } else {
        await locator.fill(params.text, tab.actionTimeoutOptions);
        result.addCode(`await page.${resolved}.fill(${JSON.stringify(params.text)});`);
      }
      if (params.submit) {
        await locator.press('Enter', tab.actionTimeoutOptions);
        result.addCode(`await page.${resolved}.press('Enter');`);
        result.setIncludeSnapshot();
      }
    });
  },
});

export const pressKey = defineTabTool({
  schema: { name: 'browser_press_key' },
  handle: async (tab, params, result) => {
    result.addCode(`await page.keyboard.press('${params.key}');`);
    if (params.key === 'Enter') {
      result.setIncludeSnapshot();
      await tab.waitForCompletion(() => tab.page.keyboard.press('Enter'));
    } else {
      await tab.page.keyboard.press(params.key);
    }
  },
});

export default [type, pressKey];
