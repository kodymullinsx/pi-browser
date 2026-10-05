import { defineTabTool } from '../tool';

const LEVELS = ['error', 'warning', 'info', 'debug'] as const;
type Level = typeof LEVELS[number];

function levelIndex(l: Level): number { return LEVELS.indexOf(l); }

export const consoleMessages = defineTabTool({
  schema: { name: 'browser_console_messages' },
  handle: async (tab, params, result) => {
    const level: Level = params.level ?? 'info';
    const threshold = levelIndex(level);
    const msgs = tab.consoleMessages().filter(m => {
      const ml: Level = m.type === 'warning' ? 'warning' : m.type === 'error' ? 'error' : m.type === 'debug' ? 'debug' : 'info';
      return levelIndex(ml) <= threshold;
    });
    if (!msgs.length) {
      result.addTextResult('No console messages.');
      return;
    }
    const MAX = 10_000;
    let text = msgs.map(m => m.toString()).join('\n');
    if (text.length > MAX)
      text = text.slice(0, MAX) + `\n[truncated, ${msgs.length} messages total]`;
    result.addTextResult(text);
  },
});

export const consoleClear = defineTabTool({
  schema: { name: 'browser_console_clear' },
  handle: async (tab, _params, result) => {
    tab.clearConsoleMessages();
    result.addTextResult('Console messages cleared.');
  },
});

export default [consoleMessages, consoleClear];
