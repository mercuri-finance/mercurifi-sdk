import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('../scripts/check-package.mjs', import.meta.url).pathname;
const base = {
  name: '@mercurifi/sdk', version: '1.0.0', type: 'module', files: ['dist', 'README.md', 'LICENSE'],
  scripts: { test: 'vitest run' }, dependencies: { viem: '2.56.5' },
};
const dirs: string[] = [];

function run(over: Record<string, unknown> = {}, npmrc = 'ignore-scripts=true\n', omit: string[] = [], license: 'file' | 'dir' | 'link' = 'file') {
  const d = mkdtempSync(join(tmpdir(), 'pkgchk-'));
  dirs.push(d);
  const pkg: Record<string, unknown> = { ...base, ...over };
  for (const [k, v] of Object.entries(pkg)) if (v === undefined) delete pkg[k];
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(d, '.npmrc'), npmrc);
  if (!omit.includes('README.md')) writeFileSync(join(d, 'README.md'), 'x');
  if (!omit.includes('LICENSE')) {
    if (license === 'file') writeFileSync(join(d, 'LICENSE'), 'x');
    else if (license === 'dir') mkdirSync(join(d, 'LICENSE'));
    else { writeFileSync(join(d, 'LICENSE.real'), 'x'); symlinkSync(join(d, 'LICENSE.real'), join(d, 'LICENSE')); }
  }
  const r = spawnSync(process.execPath, [script, d], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('check-package gate', () => {
  it('accepts a compliant package', () => expect(run().code).toBe(0));
  it('accepts the real package', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
  it('rejects ignore-scripts=false after true', () => {
    const r = run({}, 'ignore-scripts=true\nignore-scripts=false\n');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/ignore-scripts/);
  });
  it('rejects ignore-scripts=false before true', () => expect(run({}, 'ignore-scripts=false\nignore-scripts=true\n').code).toBe(1));
  it.each(['overrides', 'resolutions', 'workspaces', 'bin', 'gypfile', 'optionalDependencies', 'peerDependencies'])(
    'rejects key %s', (key) => {
      const r = run({ [key]: key === 'gypfile' ? true : {} });
      expect(r.code).toBe(1);
      expect(r.err).toContain(key);
    });
  it('limits publishConfig to access/provenance', () => {
    expect(run({ publishConfig: { access: 'public', provenance: true } }).code).toBe(0);
    expect(run({ publishConfig: { registry: 'https://evil.example' } }).code).toBe(1);
    expect(run({ publishConfig: { access: 'public', registry: 'https://evil.example' } }).code).toBe(1);
  });
  it.each(['README.md', 'LICENSE'])('rejects a missing %s', (f) => expect(run({}, undefined, [f]).code).toBe(1));
  it('rejects a lifecycle script and a second dependency', () => {
    expect(run({ scripts: { postinstall: 'x' } }).code).toBe(1);
    expect(run({ dependencies: { viem: '2.56.5', evil: '1.0.0' } }).code).toBe(1);
  });
  it('accepts every allowed script and refuses any other', () => {
    const allowed = { build: 'x', typecheck: 'x', test: 'x', 'test:integration': 'x', 'check:package': 'x', 'gen:abis': 'x', 'smoke:dist': 'x' };
    expect(run({ scripts: allowed }).code).toBe(0);
    const r = run({ scripts: { ...allowed, release: 'npm publish' } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/scripts not on the allowlist: release/);
    for (const s of ['preuninstall', 'postuninstall']) expect(run({ scripts: { test: 'x', [s]: 'x' } }).code).toBe(1);
  });
  it('confines exports, main, module and types to ./dist/', () => {
    const exports = { '.': { import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' }, require: { default: './dist/cjs/index.js' } } };
    expect(run({ exports, main: './dist/cjs/index.js', module: './dist/esm/index.js', types: './dist/esm/index.d.ts' }).code).toBe(0);
    expect(run({ exports: { '.': './src/index.ts' } }).code).toBe(1);
    expect(run({ exports: { '.': { import: './dist/../src/index.js' } } }).code).toBe(1);
    expect(run({ exports: { './package.json': './package.json' } }).code).toBe(1);
    expect(run({ main: './src/index.js' }).code).toBe(1);
    expect(run({ types: 'index.d.ts' }).code).toBe(1);
  });
  it.each(['dir', 'link'] as const)('rejects a LICENSE that is a %s', (kind) => {
    const r = run({}, undefined, [], kind);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/LICENSE must be a regular file/);
  });
});
