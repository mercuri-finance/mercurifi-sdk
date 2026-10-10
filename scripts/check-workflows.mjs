// Supply-chain gate for .github/workflows: SHA-pinned actions, explicit least-privilege permissions, no
// pull_request_target, and release workflows that only run on a manual dispatch, with the OIDC token confined to a
// publish job that does nothing but download the build job's artifact and publish it.
//
// zizmor (hash-pinned in .github/ci-requirements.txt, run in CI) is the primary workflow audit. This gate is a
// dependency-free backstop for the repository's own rules, so it reads only the YAML subset these files use: block
// mappings and sequences, single-line plain or quoted scalars, single-line flow collections, and block scalars (| or >).
// Anything outside that subset (a scalar continued on deeper lines, an unclosed quote or flow collection, an anchor,
// alias, tag or merge key, a duplicate key) is refused rather than guessed at, so the parser and GitHub cannot disagree.
// Usage: node scripts/check-workflows.mjs [workflows-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = 'mercuri-finance';
const ACCOUNT = 'mercurifinance';
// Actions a publish job (one holding id-token: write) may use, and the only command it may run.
// No checkout: a publish job never sees the source tree, only the build job's artifact.
// Each action's allowed with: keys; a value of null means any value, otherwise the exact value (or the key may be absent).
const PUBLISH_JOB_ACTIONS = new Map([
  ['actions/download-artifact', new Map([['name', null], ['path', null]])],
  ['actions/setup-node', new Map([['node-version', null], ['registry-url', 'https://registry.npmjs.org']])],
  ['pypa/gh-action-pypi-publish', new Map([['packages-dir', null], ['attestations', null]])],
]);
const PUBLISH_ACTIONS = new Set(['pypa/gh-action-pypi-publish']);
// The one artifact each release workflow's publish job may download: without a name, download-artifact fetches every
// artifact of the run (the SBOM too), and another name could hand the publish step a different file.
const PUBLISH_ARTIFACTS = new Map([['release-npm.yml', 'npm-package'], ['release-pypi.yml', 'pypi-dist']]);
// npm publish of the downloaded tarball, in one fixed form: a relative .tgz path (globs allowed, no ..), provenance,
// public access (the package is scoped, so npm would otherwise refuse the first publish), an explicit latest tag (npm 11
// refuses a prerelease without --tag, and latest must move off the name-reserving 0.0.0) and no lifecycle scripts.
const PUBLISH_RUN = /^npm publish (?![^ ]*\.\.)[\w-]+(?:\/[\w.*-]+)*\.tgz --provenance --access public --tag latest --ignore-scripts$/;
const TOP_KEYS = new Set(['name', 'run-name', 'on', 'permissions', 'concurrency', 'jobs']);
// Workflow syntax keys and permission scopes; a key that differs from one of these only by case is refused, so a
// case-insensitive reader (GitHub's or a later one) cannot see a key this gate skipped.
const KNOWN_KEYS = new Set([
  ...TOP_KEYS, 'env', 'defaults', 'run', 'shell', 'working-directory', 'needs', 'if', 'runs-on', 'timeout-minutes', 'environment',
  'steps', 'uses', 'with', 'id', 'continue-on-error', 'strategy', 'matrix', 'fail-fast', 'max-parallel', 'container', 'services',
  'outputs', 'secrets', 'inputs', 'cancel-in-progress', 'group', 'url', 'workflow_dispatch', 'workflow_call', 'push',
  'pull_request', 'pull_request_target', 'schedule', 'branches', 'tags', 'paths', 'actions', 'attestations', 'checks',
  'contents', 'deployments', 'discussions', 'id-token', 'issues', 'models', 'packages', 'pages', 'pull-requests',
  'repository-projects', 'security-events', 'statuses',
]);
const GUARD = ["github.repository_owner == 'mercuri-finance'", "github.actor == 'mercurifinance'", "github.triggering_actor == 'mercurifinance'"];
const PUBLISH_JOB_KEYS = new Set(['name', 'needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'steps', 'concurrency']);
const PUBLISH_STEP_KEYS = new Set(['name', 'id', 'uses', 'with', 'run', 'timeout-minutes']);
// Untrusted text in an expression. Not exhaustive (zizmor's template-injection audit is): event payload fields an outside
// contributor controls, the head branch name, and workflow or dispatch inputs.
const UNTRUSTED =
  /\$\{\{[^}]*\b(github\.event\.(issue|pull_request|comment|review|review_comment|head_commit|commits|pages|discussion|discussion_comment|workflow_run|release|inputs|client_payload|forkee|label|milestone|project_card|check_run|check_suite|merge_group)\b|github\.event\s*[)}]|github\.head_ref\b|inputs\.)/;

const indentOf = (l) => l.search(/\S/);
const blank = (l) => l.trim() === '';
const KEY = /^(\s*)(-\s+)?(?:'([^']*)'|"([^"]*)"|([^\s:'"#][^:#]*?))\s*:(?:\s+(.*?))?\s*$/;
const unquote = (v) => (v ?? '').replace(/\s+#.*$/, '').replace(/^'(.*)'$|^"(.*)"$/, '$1$2').trim();
const BLOCK_SCALAR = /^[|>][-+1-9]*$/;
// The text after "key:" or "- " on one line: a key, then the rest of the line.
const CONTENT_KEY = /^(?:'[^']*'|"[^"]*"|[^\s:'"#][^:#]*?)\s*:(?:\s+(.*?))?\s*$/;

/** Whether a flow collection opened on this line closes on it (brackets balanced outside quotes). */
function flowClosed(v) {
  const stack = [];
  for (let k = 0, q = ''; k < v.length; k++) {
    const c = v[k];
    if (q) {
      if (c === q) q = '';
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') {
      if (stack.pop() !== (c === '}' ? '{' : '[')) return false;
      if (stack.length === 0) return /^\s*(#.*)?$/.test(v.slice(k + 1));
    }
  }
  return false;
}

/**
 * Whole-file structure check, independent of the mapping walk: every node must be one the walk reads the same way GitHub
 * does. Refuses a scalar continued on deeper-indented lines (a plain "run: x" followed by "  ; curl", or "if: a" followed
 * by "  || true"), an unclosed quote or flow collection, anchors, aliases, tags and merge keys. Block scalar bodies are
 * skipped (their text is data, re-checked where it matters).
 */
function structureProblems(file, lines) {
  const problems = [];
  let blockCol = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (blank(line)) continue;
    if (blockCol !== -1) {
      if (indentOf(line) > blockCol) continue;
      blockCol = -1;
    }
    if (/\t/.test(line.slice(0, indentOf(line) + 1))) {
      problems.push(`${file}:${i + 1}: tab in indentation`);
      continue;
    }
    const m = /^( *)((?:-(?: +|$))*)(.*)$/.exec(line);
    if (m === null) {
      problems.push(`${file}:${i + 1}: unreadable line`);
      continue;
    }
    const col = m[1].length + m[2].length;
    const rest = m[3].trim();
    if (rest === '') continue;
    let value;
    const k = CONTENT_KEY.exec(rest);
    if (k !== null) {
      if (/^<<\s*:/.test(rest)) problems.push(`${file}:${i + 1}: merge keys are not allowed`);
      const key = /^(?:'([^']*)'|"([^"]*)"|([^:]*?))\s*:/.exec(rest);
      const name = key?.[1] ?? key?.[2] ?? key?.[3] ?? '';
      if (name !== name.toLowerCase() && KNOWN_KEYS.has(name.toLowerCase())) problems.push(`${file}:${i + 1}: ${name} differs from the key ${name.toLowerCase()} only by case`);
      value = (k[1] ?? '').trim();
    } else if (m[2] !== '') value = rest;
    else {
      problems.push(`${file}:${i + 1}: not a key or a list item (a scalar continued from the line above?)`);
      continue;
    }
    if (value === '' || /^#/.test(value)) continue;
    if (BLOCK_SCALAR.test(value.replace(/\s+#.*$/, ''))) {
      blockCol = col;
      continue;
    }
    if (/^[&*!]/.test(value)) problems.push(`${file}:${i + 1}: anchors, aliases and tags are not allowed`);
    if (/^[{[]/.test(value) && !flowClosed(value)) problems.push(`${file}:${i + 1}: a flow collection must open and close on one line`);
    if (/^"/.test(value) && !/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(value)) problems.push(`${file}:${i + 1}: a quoted scalar must close on its line`);
    if (/^'/.test(value) && !/^'(?:[^']|'')*'\s*(#.*)?$/.test(value)) problems.push(`${file}:${i + 1}: a quoted scalar must close on its line`);
    let n = i + 1;
    while (n < lines.length && blank(lines[n])) n++;
    if (n < lines.length && indentOf(lines[n]) > col) {
      problems.push(`${file}:${i + 1}: a scalar continued on deeper-indented lines is not allowed (found: ${lines[n].trim()})`);
    }
  }
  return problems;
}

/** The lines nested under line i (deeper indent), as [start, end). */
function blockAfter(lines, i) {
  const base = indentOf(lines[i]);
  let e = i + 1;
  while (e < lines.length && (blank(lines[e]) || indentOf(lines[e]) > base)) e++;
  return [i + 1, e];
}

/** A block mapping in [s, e): its keys at the first child's indent, each with its scalar value and nested block. */
function mapping(lines, s, e) {
  const out = new Map();
  let ci = -1;
  for (let i = s; i < e; i++) {
    if (blank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ci === -1) ci = ind;
    if (ind !== ci) continue;
    const m = KEY.exec(lines[i]);
    if (m === null || m[2]) {
      out.set(Symbol('not-a-key'), { line: lines[i] });
      continue;
    }
    const key = m[3] ?? m[4] ?? m[5];
    if (out.has(key)) {
      out.set(Symbol(`duplicate key ${key}`), { line: lines[i] });
      continue;
    }
    // A plain or quoted scalar with deeper lines under it is a multi-line scalar: refused (structureProblems names it).
    const [bs, be] = blockAfter(lines, i);
    const v = (m[6] ?? '').replace(/\s+#.*$/, '').trim();
    if (v !== '' && !BLOCK_SCALAR.test(v) && lines.slice(bs, be).some((l) => !blank(l))) {
      out.set(Symbol(`multi-line ${key}`), { line: lines[i] });
      continue;
    }
    out.set(key, { i, value: unquote(m[6]), raw: m[6] ?? '', block: blockAfter(lines, i) });
  }
  return out;
}

/** The items of a block sequence in [s, e); each item is its own small mapping (the "- " line and what is under it). */
function sequence(lines, s, e) {
  const items = [];
  let ci = -1;
  for (let i = s; i < e; i++) {
    if (blank(lines[i])) continue;
    const ind = indentOf(lines[i]);
    if (ci === -1) ci = ind;
    if (ind === ci && /^\s*-(\s|$)/.test(lines[i])) items.push(i);
  }
  return items.map((i, n) => {
    const end = n + 1 < items.length ? items[n + 1] : e;
    // Rewrite "- key: v" as "  key: v" so the item reads as a mapping at one indent.
    const body = [lines[i].replace(/^(\s*)-\s/, '$1  '), ...lines.slice(i + 1, end)];
    return { body, map: mapping(body, 0, body.length) };
  });
}

/** Problems with one permissions entry (scalar or block). */
function permissionProblems(where, entry, idTokenAllowed) {
  const problems = [];
  if (entry.value !== '') {
    if (entry.value !== '{}') problems.push(`${where}: permissions must be a block of scopes or {} (found ${entry.value})`);
    return { problems, idToken: false };
  }
  let idToken = false;
  for (const [scope, v] of mapping(entry.lines, ...entry.block)) {
    if (typeof scope !== 'string') {
      problems.push(`${where}: unreadable permissions entry`);
      continue;
    }
    if (!['read', 'write', 'none'].includes(v.value)) problems.push(`${where}: ${scope}: ${v.value} is not a permission level`);
    if (v.value !== 'write') continue;
    if (scope !== 'id-token') problems.push(`${where}: ${scope}: write is not allowed (only id-token may be write)`);
    else if (!idTokenAllowed) problems.push(`${where}: id-token: write belongs only in a release workflow's publish job`);
    else idToken = true;
  }
  return { problems, idToken };
}

export function checkWorkflow(file, text) {
  const problems = [];
  // Byte rule, before any parsing: printable ASCII (no backslash), space and \n only. A lone \r, NEL, U+2028/9 or any
  // other line break the YAML reader honours but this gate's \n split does not could hide a job; NBSP, zero-width
  // characters, a BOM and tabs could make a key or a command read differently. Nothing else is examined until the file
  // is clean.
  if (text.includes('\r\n')) return [`${file}: CRLF line endings are not allowed (use LF)`];
  const bad = /[^\x20-\x7e\n]/.exec(text);
  if (bad !== null) {
    const before = text.slice(0, bad.index);
    const line = before.split('\n').length;
    const col = bad.index - before.lastIndexOf('\n');
    const cp = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return [`${file}:${line}:${col}: only printable ASCII, spaces and \\n are allowed (found U+${cp})`];
  }
  // No backslash anywhere: in a double-quoted scalar or key, "p\x65rmissions" is permissions to YAML but not to this
  // gate, so an escape could hide a permissions block, a scope or any other key. The workflows need none.
  const slash = text.indexOf('\\');
  if (slash !== -1) {
    const before = text.slice(0, slash);
    return [`${file}:${before.split('\n').length}:${slash - before.lastIndexOf('\n')}: backslashes are not allowed (a YAML escape could spell a key the gate does not see)`];
  }
  // Full-line comments are blanked (line numbers kept); comments may mention forbidden names.
  const lines = text.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l));
  const code = lines.join('\n');
  const release = file.startsWith('release-');

  for (const [, ref] of code.matchAll(/^\s*-?\s*uses:\s*['"]?([^\s#'"]+)/gm)) {
    if (ref.startsWith('./')) continue;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) problems.push(`${file}: ${ref} is not pinned to a commit SHA`);
  }
  if (/pull_request_target/.test(code)) problems.push(`${file}: pull_request_target is not allowed`);
  if (/^\s*-?\s*uses:\s*['"]?docker:/m.test(code)) problems.push(`${file}: docker:// actions are not allowed`);
  if (/write-all/.test(code)) problems.push(`${file}: write-all is not allowed`);
  // Backstop for a permissions block the parser below might not reach (for example a flow mapping).
  for (const [, scope] of code.matchAll(/^\s*-?\s*['"]?([\w-]+)['"]?\s*:\s*write\s*(?:#.*)?$/gm)) {
    if (scope !== 'id-token') problems.push(`${file}: ${scope}: write is not allowed`);
  }
  if (/\{[^}\n]*\b[\w-]+\s*:\s*write\b/.test(code)) problems.push(`${file}: write a permissions block, not a flow mapping`);
  if (/^\s*persist-credentials:\s*true/m.test(code)) problems.push(`${file}: persist-credentials must stay false`);
  if (UNTRUSTED.test(code)) problems.push(`${file}: attacker-controlled github context or inputs in an expression`);
  problems.push(...structureProblems(file, lines));

  const top = mapping(lines, 0, lines.length);
  for (const k of top.keys()) {
    if (typeof k !== 'string' || !TOP_KEYS.has(k)) problems.push(`${file}: top-level ${String(k)} is not allowed (only ${[...TOP_KEYS].join(', ')})`);
  }
  const perms = top.get('permissions');
  if (perms === undefined) problems.push(`${file}: missing top-level permissions`);
  else {
    // Exactly one scope, contents: read; parsed as a whole block so an extra line cannot slip in after it.
    const scopes = perms.value === '' ? [...mapping(lines, ...perms.block)] : [];
    if (scopes.length !== 1 || scopes[0][0] !== 'contents' || scopes[0][1].value !== 'read') {
      problems.push(`${file}: the top-level permissions block must be exactly contents: read`);
    }
  }

  const on = top.get('on') ?? top.get('true');
  if (on === undefined || on.value !== '') problems.push(`${file}: write the on: block as a mapping so the trigger list can be checked`);
  else if (release) {
    // Triggers are the keys at the first child's indent only (workflow_dispatch's own inputs: are not triggers).
    const triggers = [...mapping(lines, ...on.block).keys()].map(String);
    if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
      problems.push(`${file}: release workflows run only on workflow_dispatch (found: ${triggers.join(', ') || 'none'})`);
    }
  }

  // Each checkout step (the "- uses:" line and the lines indented under it) must turn credential persistence off.
  lines.forEach((line, n) => {
    const step = /^(\s*)- uses:\s*actions\/checkout@/.exec(line);
    if (step === null) return;
    const block = [];
    for (let k = n + 1; k < lines.length && (lines[k].trim() === '' || lines[k].search(/\S/) > step[1].length); k++) block.push(lines[k]);
    if (!block.some((l) => /^\s*persist-credentials:\s*false\s*$/.test(l))) problems.push(`${file}: every checkout must set persist-credentials: false`);
  });

  const jobs = top.get('jobs');
  if (jobs === undefined || jobs.value !== '') {
    problems.push(`${file}: ${jobs === undefined ? 'no jobs' : 'write jobs as a block mapping'}`);
    return problems;
  }
  let publishJobs = 0;
  for (const [name, job] of mapping(lines, ...jobs.block)) {
    if (typeof name !== 'string') {
      problems.push(`${file}: unreadable job entry: ${job.line.trim()}`);
      continue;
    }
    const where = `${file}: job ${name}`;
    if (job.value !== '') {
      problems.push(`${where}: write each job as a block mapping`);
      continue;
    }
    const keys = mapping(lines, ...job.block);
    const p = keys.get('permissions');
    if (release && p === undefined) problems.push(`${where}: release jobs set their own permissions`);
    const { problems: pp, idToken } = p === undefined ? { problems: [], idToken: false } : permissionProblems(where, { ...p, lines }, release);
    problems.push(...pp);
    if (!idToken) {
      if (keys.has('environment')) problems.push(`${where}: only the publish job (the one holding id-token) may use a release environment`);
      continue;
    }
    publishJobs++;
    for (const k of keys.keys()) if (typeof k === 'string' && !PUBLISH_JOB_KEYS.has(k)) problems.push(`${where}: ${k} is not allowed in a publish job`);
    if (!keys.get('environment')?.value) problems.push(`${where}: the publish job needs a protected environment`);
    if (!keys.get('needs')?.value) problems.push(`${where}: the publish job must need the build job and publish only its artifact`);
    const guard = keys.get('if')?.value ?? '';
    for (const [ctx, want] of [['github.repository_owner', ORG], ['github.actor', ACCOUNT], ['github.triggering_actor', ACCOUNT]]) {
      if (!new RegExp(`(^|&&)\\s*${ctx.replace('.', '\\.')}\\s*==\\s*'${want}'\\s*(&&|$)`).test(guard)) {
        problems.push(`${where}: the publish job's if: must require ${ctx} == '${want}'`);
      }
    }
    if (/\|\|/.test(guard)) problems.push(`${where}: the publish job's if: must be a plain conjunction`);
    // Exactly the three clauses, nothing else: no always(), success(), failure(), cancelled() or other condition.
    const clauses = guard.split('&&').map((c) => c.trim().replace(/\s+/g, ' '));
    if (clauses.length !== GUARD.length || GUARD.some((c) => !clauses.includes(c))) {
      problems.push(`${where}: the publish job's if: must be exactly ${GUARD.join(' && ')}`);
    }
    if (keys.get('runs-on')?.value !== 'ubuntu-latest') problems.push(`${where}: the publish job runs on ubuntu-latest (a GitHub-hosted runner)`);
    const steps = keys.get('steps');
    if (steps !== undefined && steps.value !== '') problems.push(`${where}: write the publish job's steps as a block sequence`);
    let publishSteps = 0;
    for (const { body, map } of steps ? sequence(lines, ...steps.block) : []) {
      for (const k of map.keys()) if (typeof k !== 'string' || !PUBLISH_STEP_KEYS.has(k)) problems.push(`${where}: step key ${String(k)} is not allowed in a publish job`);
      const uses = map.get('uses')?.value;
      const w = map.get('with');
      if (w !== undefined && uses === undefined) problems.push(`${where}: with: without uses: in a publish job`);
      if (uses !== undefined) {
        const action = uses.split('@')[0];
        const allowed = PUBLISH_JOB_ACTIONS.get(action);
        if (allowed === undefined) problems.push(`${where}: ${action} is not allowed in a publish job`);
        if (PUBLISH_ACTIONS.has(action)) publishSteps++;
        if (w !== undefined && w.value !== '') problems.push(`${where}: write ${action}'s with: as a block mapping`);
        if (action === 'actions/download-artifact') {
          const name = w ? [...mapping(body, ...w.block)].find(([k]) => k === 'name')?.[1].value : undefined;
          const want = PUBLISH_ARTIFACTS.get(file);
          if (name === undefined) problems.push(`${where}: download-artifact in a publish job must name its artifact${want === undefined ? '' : ` (${want})`}`);
          else if (want === undefined ? !/^[\w.-]+$/.test(name) : name !== want) problems.push(`${where}: download-artifact name must be ${want ?? 'a plain artifact name'} (found: ${name})`);
        }
        for (const [k, v] of w ? mapping(body, ...w.block) : []) {
          if (k === 'cache') problems.push(`${where}: no dependency cache in a publish job`);
          else if (k === 'repository-url') problems.push(`${where}: repository-url is not allowed: publish only to the default index`);
          else if (typeof k !== 'string' || allowed === undefined || !allowed.has(k)) problems.push(`${where}: with: ${String(k)} is not allowed for ${action} in a publish job`);
          else if (allowed.get(k) !== null && v.value !== allowed.get(k)) problems.push(`${where}: ${action} ${k} must be ${allowed.get(k)} (found: ${v.value})`);
          else if (action === 'actions/download-artifact' && k === 'path' && !/^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+)*\/?$/.test(v.value)) {
            problems.push(`${where}: the download path must be relative to the workspace, without .. (found: ${v.value})`);
          }
        }
      }
      const run = map.get('run');
      if (run !== undefined) {
        // One line, read raw (comments included): a shell would still run what follows a quoted "#".
        const c = run.raw.trim();
        if (BLOCK_SCALAR.test(run.value)) problems.push(`${where}: a publish job runs one single-line npm publish (found: a ${c} block)`);
        else if (!PUBLISH_RUN.test(c)) problems.push(`${where}: a publish job runs only npm publish <tarball>.tgz --provenance --access public --tag latest --ignore-scripts (found: ${c})`);
        else publishSteps++;
      }
    }
    if (publishSteps === 0) problems.push(`${where}: the publish job has no publish step`);
  }
  if (release && publishJobs === 0) problems.push(`${file}: a release workflow needs one publish job with id-token: write`);
  return problems;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const problems = files.length === 0 ? ['no workflow files found'] : files.flatMap((f) => checkWorkflow(f, readFileSync(join(dir, f), 'utf8')));
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('workflows ok');
}
