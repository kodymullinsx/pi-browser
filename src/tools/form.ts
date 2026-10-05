import { defineTabTool } from '../tool';

// Guidance for reactive frameworks (Vue, React, etc.), carried over from the original
// schema description. It was never part of the description registered with Pi in
// index.ts, so the model does not currently see it:
//
//   If fields appear filled but the framework state does not update, use
//   browser_evaluate to set each field via document.execCommand('insertText', ...)
//   after focusing it. That fires the native input event frameworks listen to,
//   whereas locator.fill() sets the DOM value directly and may bypass reactivity.
export const fillForm = defineTabTool({
  schema: { name: 'browser_fill_form' },
  handle: async (tab, params, result) => {
    for (const field of params.fields as Array<{ name: string; type: string; ref?: string; selector?: string; value: string }>) {
      const { locator, resolved } = await tab.refLocator({ element: field.name, ref: field.ref, selector: field.selector });
      const src = `await page.${resolved}`;
      if (field.type === 'textbox' || field.type === 'slider') {
        await locator.fill(field.value, tab.actionTimeoutOptions);
        result.addCode(`${src}.fill(${JSON.stringify(field.value)});`);
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        await locator.setChecked(field.value === 'true', tab.actionTimeoutOptions);
        result.addCode(`${src}.setChecked(${field.value});`);
      } else if (field.type === 'combobox') {
        await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
        result.addCode(`${src}.selectOption(${JSON.stringify(field.value)});`);
      }
    }
    result.setIncludeSnapshot();
  },
});

export default [fillForm];
