import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = new URL('../../../scripts/check-workflows.mjs', import.meta.url).pathname;
const real = (f: string) => readFileSync(new URL(`../../../.github/workflows/${f}`, import.meta.url), 'utf8');
const dirs: string[] = [];

function run(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'wfchk-'));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  const r = spawnSync(process.execPath, [script, d], { encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('check-workflows gate', () => {
  it('accepts the real workflows', () => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });
  it('rejects an action pinned to a tag', () => {
    const r = run({ 'ci.yml': real('ci.yml').replace(/actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not pinned to a commit SHA/);
  });
  it('rejects pull_request_target', () => expect(run({ 'ci.yml': real('ci.yml').replace('pull_request:', 'pull_request_target:') }).code).toBe(1));
  it('rejects a missing or widened permissions block', () => {
    expect(run({ 'ci.yml': real('ci.yml').replace('permissions:\n  contents: read\n', '') }).code).toBe(1);
    expect(run({ 'ci.yml': real('ci.yml').replace('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n') }).code).toBe(1);
  });
  it('rejects a checkout that keeps credentials', () => {
    expect(run({ 'ci.yml': real('ci.yml').replace('persist-credentials: false', 'persist-credentials: true') }).code).toBe(1);
    expect(run({ 'ci.yml': real('ci.yml').replace(/\n {10}persist-credentials: false/g, '') }).code).toBe(1);
  });
  it('rejects id-token outside a release workflow', () => {
    expect(run({ 'ci.yml': real('ci.yml').replace('jobs:\n', 'jobs:\n  x:\n    permissions:\n      id-token: write\n    runs-on: ubuntu-latest\n    steps: []\n') }).code).toBe(1);
  });
  it.each(['push', 'schedule', 'release', 'pull_request', 'workflow_run'])('rejects a release workflow that also triggers on %s', (t) => {
    const text = real('release-npm.yml').replace('on:\n  workflow_dispatch:\n', `on:\n  workflow_dispatch:\n  ${t}:\n`);
    const r = run({ 'release-npm.yml': text });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/only on workflow_dispatch/);
  });
  it('rejects a release workflow that is not on workflow_dispatch at all, or has no environment', () => {
    expect(run({ 'release-npm.yml': real('release-npm.yml').replace('workflow_dispatch:', 'push:') }).code).toBe(1);
    expect(run({ 'release-pypi.yml': real('release-pypi.yml').replace(/ {4}environment: .*\n/, '') }).code).toBe(1);
  });
  it('rejects attacker-controlled context in an expression', () => {
    expect(run({ 'ci.yml': real('ci.yml').replace('- run: npm test', '- run: echo "${{ github.event.pull_request.title }}"') }).code).toBe(1);
  });
});
