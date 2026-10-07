import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

// The official managed install uses a shell launcher outside the npm package.
// Resolve its selected release before checking the actual launcher version.
function findLivePiPackage(entry) {
  const launcher = realpathSync(entry);
  const installRoot = path.resolve(path.dirname(launcher), '../install');
  const markerPath = path.join(installRoot, 'managed-install.json');
  if (!existsSync(markerPath)) return { ...findPiPackage(entry), cliPath: launcher };

  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  assert.ok(
    marker.kind === 'pi-managed-install' && marker.schemaVersion === 1 && marker.layout === 'releases-v1',
    'Unsupported Pi managed install marker',
  );
  const selectedVersion = readFileSync(path.join(installRoot, 'current-version'), 'utf8').trim();
  assert.ok(
    /^[A-Za-z0-9._+-]+$/.test(selectedVersion) && !['.', '..'].includes(selectedVersion),
    'Invalid Pi managed release version',
  );
  const directory = path.join(installRoot, 'releases', selectedVersion, 'node_modules', packageName);
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  assert.equal(manifest.name, packageName, 'Managed release is not the Pi package');
  assert.equal(manifest.version, selectedVersion, 'Managed release/package version mismatch');
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.pi;
  assert.equal(typeof bin, 'string', 'Managed Pi package has no CLI entrypoint');
  return { directory, manifest, cliPath: realpathSync(path.join(directory, bin)) };
}

/**
 * Compare the live Pi CLI with the Pi declaration package TypeScript resolves and the
 * exact devDependency pin. Throws on any mismatch; returns the live CLI path.
 */
export function checkLivePi() {
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
  // injected development bins or the guard would compare the local Pi with itself.
  const livePath = (process.env.PATH ?? '').split(path.delimiter)
    .filter(directory => !path.resolve(directory).endsWith(`${path.sep}node_modules${path.sep}.bin`))
    .join(path.delimiter);
  let piBin;
  try {
    piBin = execFileSync('which', ['pi'], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, PATH: livePath },
    }).trim();
  } catch {
    assert.fail('No live `pi` command found on PATH; the compatibility guard compares against the installed Pi.');
  }
  const livePackage = findLivePiPackage(piBin);
  const cliVersion = execFileSync(piBin, ['--version'], {
    encoding: 'utf8', timeout: 10_000,
  }).trim();
  const declaredVersion = JSON.parse(readFileSync(path.join(browserRoot, 'package.json'), 'utf8'))
    .devDependencies[packageName];

  assert.equal(cliVersion, livePackage.manifest.version, 'Pi launcher/package version mismatch');
  assert.equal(
    typesPackage.manifest.version, cliVersion,
    `Browser Pi types (${typesPackage.manifest.version}) differ from live Pi (${cliVersion}). ` +
    `Run npm install --save-dev --save-exact --ignore-scripts ${packageName}@${cliVersion}, then rerun npm run test:loader.`,
  );
  assert.equal(declaredVersion, cliVersion, 'Pin the browser Pi devDependency to the exact live version');
  console.log(`[pi-version] live=${cliVersion} types=${typesPackage.manifest.version} pin=${declaredVersion}`);
  console.log(`[pi-version] CLI: ${livePackage.cliPath}`);
  console.log(`[pi-version] TypeScript: ${resolved.resolvedFileName}`);
  return { piBin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) checkLivePi();
