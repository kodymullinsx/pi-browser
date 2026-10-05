import { defineTool } from '../tool';
import { MONITOR_LIMITS, MONITOR_SIGNALS } from '../devtools';
import type { DevToolsMonitorSignal } from '../devtools';

function requiredMonitorId(params: Record<string, any>): string {
  if (typeof params.monitorId !== 'string' || !params.monitorId)
    throw new Error(`browser_devtools ${params.action} requires monitorId.`);
  return params.monitorId;
}

export const devtools = defineTool({
  capability: 'devtools',
  schema: {
    name: 'browser_devtools',
    title: 'Inspect browser DevTools data',
    description: 'Read browser metadata or page performance metrics, or start/read/stop a bounded monitor for runtime exceptions, network failures, and page lifecycle events.',
    type: 'action',
  },
  handle: async (context, params, result) => {
    const manager = context.devtools();
    let value: unknown;

    if (params.action === 'info') {
      value = await manager.info((await context.ensureTab()).page);
    } else if (params.action === 'metrics') {
      value = await manager.metrics((await context.ensureTab()).page);
    } else if (params.action === 'monitor_start') {
      const signals = (params.signals ?? MONITOR_SIGNALS) as DevToolsMonitorSignal[];
      value = await manager.startMonitor((await context.ensureTab()).page, signals, params.maxEvents ?? MONITOR_LIMITS.maxEvents.default);
    } else if (params.action === 'monitor_read') {
      value = manager.readMonitor(requiredMonitorId(params), params.limit ?? MONITOR_LIMITS.readLimit.default, params.clear ?? false);
    } else if (params.action === 'monitor_stop') {
      value = manager.stopMonitor(requiredMonitorId(params));
    } else {
      throw new Error(`Unsupported browser_devtools action: ${params.action}`);
    }

    result.addTextResult(JSON.stringify(value, null, 2));
  },
});

export default [devtools];
