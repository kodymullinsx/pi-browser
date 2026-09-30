import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = manifest.devDependencies['@earendil-works/pi-coding-agent'];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkAgainstLivePackage(packageVersion: string, cliVersion = packageVersion, npmPath = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'browser-pi-version-'));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, 'bin');
  const packageRoot = path.join(directory, 'pi-package');
  mkdirSync(bin);
  mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-coding-agent', version: packageVersion,
  }));
  const cli = path.join(packageRoot, 'dist', 'cli');
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '${cliVersion}'\n`);
  chmodSync(cli, 0o755);
  symlinkSync(cli, path.join(bin, 'pi'));

  return spawnSync(process.execPath, [path.join(root, 'scripts/check-pi-version.mjs')], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: `${npmPath ? `${path.join(root, 'node_modules/.bin')}:` : ''}${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: directory,
      PI_OFFLINE: '1',
    },
  });
}

describe('browser Pi compatibility guard', () => {
  it('accepts the exact live version and reports the actual TypeScript declaration path', () => {
    const result = checkAgainstLivePackage(version);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`live=${version} types=${version} pin=${version}`);
    expect(result.stdout).toContain('TypeScript:');
    expect(result.stdout).toContain('/dist/index.d.ts');
  });

  it('fails closed when the live harness changes but browser types do not', () => {
    const result = checkAgainstLivePackage('999.0.0');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('differ from live Pi (999.0.0)');
  });

  it('ignores npm-injected .bin paths rather than comparing the local Pi copy with itself', () => {
    const result = checkAgainstLivePackage('999.0.0', '999.0.0', true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('differ from live Pi (999.0.0)');
  });

  it('rejects a launcher whose reported version disagrees with its owning package', () => {
    const result = checkAgainstLivePackage(version, '999.0.0');
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Pi launcher/package version mismatch');
  });
});
