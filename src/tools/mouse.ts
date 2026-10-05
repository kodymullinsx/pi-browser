import { defineTabTool } from '../tool';

export const mouseMove = defineTabTool({
  schema: { name: 'browser_mouse_move_xy' },
  handle: async (tab, params, result) => {
    await tab.waitForCompletion(async () => { await tab.page.mouse.move(params.x, params.y); });
    result.addCode(`await page.mouse.move(${params.x}, ${params.y});`);
  },
});

export const mouseDown = defineTabTool({
  schema: { name: 'browser_mouse_down' },
  handle: async (tab, params, result) => {
    const opts = params.button ? { button: params.button } : {};
    await tab.page.mouse.down(opts);
    result.addCode(`await page.mouse.down(${params.button ? `{ button: '${params.button}' }` : ''});`);
  },
});

export const mouseUp = defineTabTool({
  schema: { name: 'browser_mouse_up' },
  handle: async (tab, params, result) => {
    const opts = params.button ? { button: params.button } : {};
    await tab.page.mouse.up(opts);
    result.addCode(`await page.mouse.up(${params.button ? `{ button: '${params.button}' }` : ''});`);
  },
});

export const mouseWheel = defineTabTool({
  schema: { name: 'browser_mouse_wheel' },
  handle: async (tab, params, result) => {
    await tab.page.mouse.wheel(params.deltaX ?? 0, params.deltaY ?? 0);
    result.addCode(`await page.mouse.wheel(${params.deltaX ?? 0}, ${params.deltaY ?? 0});`);
  },
});

export const mouseClickXY = defineTabTool({
  schema: { name: 'browser_mouse_click_xy' },
  handle: async (tab, params, result) => {
    const opts: Record<string, any> = {};
    if (params.button) opts.button = params.button;
    if (params.clickCount) opts.clickCount = params.clickCount;
    if (params.delay) opts.delay = params.delay;
    await tab.waitForCompletion(async () => { await tab.page.mouse.click(params.x, params.y, opts); });
    result.addCode(`await page.mouse.click(${params.x}, ${params.y}${Object.keys(opts).length ? ', ' + JSON.stringify(opts) : ''});`);
    result.setIncludeSnapshot();
  },
});

export const mouseDragXY = defineTabTool({
  schema: { name: 'browser_mouse_drag_xy' },
  handle: async (tab, params, result) => {
    await tab.waitForCompletion(async () => {
      await tab.page.mouse.move(params.startX, params.startY);
      await tab.page.mouse.down();
      await tab.page.mouse.move(params.endX, params.endY);
      await tab.page.mouse.up();
    });
    result.addCode(`await page.mouse.move(${params.startX}, ${params.startY});\nawait page.mouse.down();\nawait page.mouse.move(${params.endX}, ${params.endY});\nawait page.mouse.up();`);
    result.setIncludeSnapshot();
  },
});

export default [mouseMove, mouseClickXY, mouseDragXY, mouseDown, mouseUp, mouseWheel];
