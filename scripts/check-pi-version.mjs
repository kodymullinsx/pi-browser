import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const packageName = '@earendil-works/pi-coding-agent';
const browserRoot = path.resolve(import.meta.dirname, '..');

function findPiPackage(entry) {
  let directory = path.dirname(realpathSync(entry));
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.name === packageName) return { directory, manifest };
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Cannot locate ${packageName} package behind ${entry}`);
    directory = parent;
  }
}

// Follow the same tsconfig and module resolution used by the ordinary typecheck.
// Comparing node_modules manifests alone would miss a paths/types redirection.
const configPath = path.join(browserRoot, 'tsconfig.json');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(configFile.error, undefined, 'Cannot read browser-control tsconfig.json');
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, browserRoot);
assert.equal(config.errors.length, 0, 'Invalid browser-control tsconfig.json');
const resolved = ts.resolveModuleName(
  packageName, path.join(browserRoot, 'index.ts'), config.options, ts.sys,
).resolvedModule;
assert.ok(resolved, `TypeScript cannot resolve ${packageName}`);
const typesPackage = findPiPackage(resolved.resolvedFileName);

// npm prepends package/ancestor node_modules/.bin directories. Ignore those
// injected development bins or npm test would compare the local Pi with itself.
const livePath = (process.env.PATH ?? '').split(path.delimiter)
  .filter(directory => !path.resolve(directory).endsWith(`${path.sep}node_modules${path.sep}.bin`))
  .join(path.delimiter);
const piBin = execFileSync('which', ['pi'], {
  encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: livePath },
}).trim();
const livePackage = findPiPackage(piBin);
const cliVersion = execFileSync(piBin, ['--version'], {
  encoding: 'utf8', timeout: 10_000,
}).trim();
const declaredVersion = JSON.parse(readFileSync(path.join(browserRoot, 'package.json'), 'utf8'))
  .devDependencies[packageName];

assert.equal(cliVersion, livePackage.manifest.version, 'Pi launcher/package version mismatch');
assert.equal(
  typesPackage.manifest.version, cliVersion,
  `Browser Pi types (${typesPackage.manifest.version}) differ from live Pi (${cliVersion}). ` +
  `Run npm install --save-dev --save-exact --ignore-scripts ${packageName}@${cliVersion}, then rerun npm test.`,
);
assert.equal(declaredVersion, cliVersion, 'Pin the browser Pi devDependency to the exact live version');
console.log(`[pi-version] live=${cliVersion} types=${typesPackage.manifest.version} pin=${declaredVersion}`);
console.log(`[pi-version] CLI: ${realpathSync(piBin)}`);
console.log(`[pi-version] TypeScript: ${resolved.resolvedFileName}`);

export { piBin };
