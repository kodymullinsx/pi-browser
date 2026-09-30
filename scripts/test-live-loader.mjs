import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { piBin } from './check-pi-version.mjs';

const browserRoot = path.resolve(import.meta.dirname, '..');
const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-live-loader-'));
const marker = 'BROWSER_REGISTRATION=';
try {
  const probe = path.join(directory, 'probe.ts');
  writeFileSync(probe, `export default function (pi) {
    pi.registerCommand('probe-browser-registration', {
      handler: async () => console.log(${JSON.stringify(marker)} + JSON.stringify({
        tools: pi.getAllTools().map(tool => tool.name),
        commands: pi.getCommands().map(command => command.name),
      })),
    });
  }`);
  const result = spawnSync(piBin, [
    '--no-session', '--no-context-files', '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-themes',
    '-e', path.join(browserRoot, 'index.ts'), '-e', probe,
    '-p', '/probe-browser-registration',
  ], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 30_000,
    // No real credentials, global extensions or signed-in browser state.
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: directory,
      TMPDIR: os.tmpdir(),
      PI_CODING_AGENT_DIR: path.join(directory, 'agent'),
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0',
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Live Pi failed:\n${result.stderr}\n${result.stdout}`);
  // Pi's output guard routes extension console output to stderr in print mode.
  const line = `${result.stdout}\n${result.stderr}`.split('\n').find(line => line.startsWith(marker));
  assert.ok(line, `Registration probe did not execute:\n${result.stderr}\n${result.stdout}`);
  const registration = JSON.parse(line.slice(marker.length));
  assert.ok(registration.commands.includes('browser'), '/browser must register');
  const names = registration.tools.filter(name => name.startsWith('browser_'));
  assert.ok(names.length >= 50, `Expected at least 50 registered browser tools, got ${names.length}`);
  assert.equal(new Set(names).size, names.length, 'Browser tool names must be unique');
  for (const name of ['browser_navigate', 'browser_snapshot', 'browser_devtools', 'browser_set_storage_state']) {
    assert.ok(names.includes(name), `Missing browser tool: ${name}`);
  }
  console.log(`[live-loader] /browser and ${names.length} browser tools registered through ${piBin}`);
  console.log('[live-loader] No browser launched or attached; no provider request made.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
