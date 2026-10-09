// Fails when package.json could run code on install, gains a runtime dependency, or ships more than dist.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'];
const problems = [];
const present = lifecycle.filter((s) => pkg.scripts?.[s] !== undefined);
if (present.length > 0) problems.push(`lifecycle scripts are not allowed: ${present.join(', ')}`);
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length !== 1 || deps[0] !== 'viem') problems.push(`viem must be the only runtime dependency; found [${deps.join(', ')}]`);
if (!/^\d+\.\d+\.\d+$/.test(pkg.dependencies?.viem ?? '')) problems.push('viem must be pinned to an exact version');
for (const field of ['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
  if (pkg[field] !== undefined) problems.push(`${field} is not allowed`);
}
if (JSON.stringify(pkg.files) !== JSON.stringify(['dist', 'README.md', 'LICENSE'])) problems.push('files must be exactly ["dist","README.md","LICENSE"]');
const npmrc = readFileSync(new URL('../.npmrc', import.meta.url), 'utf8');
if (!/^ignore-scripts=true$/m.test(npmrc)) problems.push('.npmrc must set ignore-scripts=true');
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('package policy ok');
