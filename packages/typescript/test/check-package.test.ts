import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('../scripts/check-package.mjs', import.meta.url).pathname;
const base = {
  name: '@mercurifi/sdk', version: '1.0.0', type: 'module', files: ['dist', 'README.md', 'LICENSE'],
  scripts: { test: 'vitest run' }, dependencies: { viem: '2.56.5' },
};
const dirs: string[] = [];

function run(over: Record<string, unknown> = {}, npmrc = 'ignore-scripts=true\n', omit: string[] = []) {
  const d = mkdtempSync(join(tmpdir(), 'pkgchk-'));
  dirs.push(d);
  const pkg: Record<string, unknown> = { ...base, ...over };
  for (const [k, v] of Object.entries(pkg)) if (v === undefined) delete pkg[k];
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(d, '.npmrc'), npmrc);
  for (const f of ['README.md', 'LICENSE']) if (!omit.includes(f)) writeFileSync(join(d, f), 'x');
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
});
