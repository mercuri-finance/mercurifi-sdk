// Fails when package.json could run code on install, alters the runtime tree, gains a dependency, or ships more than dist.
// Usage: node scripts/check-package.mjs [package-dir]   (defaults to this package)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

const ALLOWED_KEYS = new Set([
  'name', 'version', 'description', 'license', 'type', 'sideEffects', 'engines', 'main', 'module', 'types',
  'exports', 'files', 'scripts', 'dependencies', 'devDependencies', 'keywords', 'repository', 'homepage', 'bugs',
  'publishConfig',
]);
const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'];
const problems = [];

const extra = Object.keys(pkg).filter((k) => !ALLOWED_KEYS.has(k));
if (extra.length > 0) problems.push(`package.json keys not on the allowlist: ${extra.join(', ')}`);

const present = lifecycle.filter((s) => pkg.scripts?.[s] !== undefined);
if (present.length > 0) problems.push(`lifecycle scripts are not allowed: ${present.join(', ')}`);

const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length !== 1 || deps[0] !== 'viem') problems.push(`viem must be the only runtime dependency; found [${deps.join(', ')}]`);
if (!/^\d+\.\d+\.\d+$/.test(pkg.dependencies?.viem ?? '')) problems.push('viem must be pinned to an exact version');

if (pkg.publishConfig !== undefined) {
  const pc = pkg.publishConfig;
  const keys = pc !== null && typeof pc === 'object' && !Array.isArray(pc) ? Object.keys(pc) : null;
  if (keys === null || keys.length === 0 || keys.some((k) => k !== 'access' && k !== 'provenance')) {
    problems.push('publishConfig may only contain access and/or provenance');
  }
}

if (JSON.stringify(pkg.files) !== JSON.stringify(['dist', 'README.md', 'LICENSE'])) problems.push('files must be exactly ["dist","README.md","LICENSE"]');
for (const f of ['README.md', 'LICENSE']) {
  if (!existsSync(join(dir, f))) problems.push(`${f} must exist in the package directory`);
}

// npm uses the last value of a repeated key, so judge the last ignore-scripts line and reject any false.
const values = readFileSync(join(dir, '.npmrc'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith(';'))
  .map((l) => /^ignore-scripts\s*=\s*(.*)$/.exec(l))
  .filter((m) => m !== null)
  .map((m) => m[1].trim().toLowerCase());
if (values.length === 0 || values[values.length - 1] !== 'true') problems.push('.npmrc must end with ignore-scripts=true');
if (values.some((v) => v !== 'true')) problems.push('.npmrc must not set ignore-scripts to anything but true');

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('package policy ok');
