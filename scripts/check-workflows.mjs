// Supply-chain gate for .github/workflows: SHA-pinned actions, explicit least-privilege permissions, no
// pull_request_target, and release workflows that only run on a manual dispatch, with the OIDC token confined to a
// publish job that does nothing but download the build job's artifact and publish it.
//
// zizmor (hash-pinned in .github/ci-requirements.txt, run in CI) is the primary workflow audit. This gate is a
// dependency-free backstop for the repository's own rules, so it reads only the YAML subset these files use: block
// mappings and sequences, plain or quoted scalars, and block scalars for run steps.
// Usage: node scripts/check-workflows.mjs [workflows-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = 'mercuri-finance';
const ACCOUNT = 'mercurifinance';
// Actions a publish job (one holding id-token: write) may use, and the only command it may run.
const PUBLISH_JOB_ACTIONS = new Set(['actions/checkout', 'actions/download-artifact', 'actions/setup-node', 'pypa/gh-action-pypi-publish']);
const PUBLISH_ACTIONS = new Set(['pypa/gh-action-pypi-publish']);
// npm publish of a downloaded tarball; plain words, paths and globs only, so no ;, &, |, $, `, redirect or subshell.
const PUBLISH_RUN = /^npm publish(?: [\w./*@=-]+)+$/;
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

  const top = mapping(lines, 0, lines.length);
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
  if (jobs === undefined) {
    problems.push(`${file}: no jobs`);
    return problems;
  }
  let publishJobs = 0;
  for (const [name, job] of mapping(lines, ...jobs.block)) {
    if (typeof name !== 'string') continue;
    const where = `${file}: job ${name}`;
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
    const steps = keys.get('steps');
    let publishSteps = 0;
    for (const { body, map } of steps ? sequence(lines, ...steps.block) : []) {
      for (const k of map.keys()) if (typeof k !== 'string' || !PUBLISH_STEP_KEYS.has(k)) problems.push(`${where}: step key ${String(k)} is not allowed in a publish job`);
      const uses = map.get('uses')?.value;
      if (uses !== undefined) {
        const action = uses.split('@')[0];
        if (!PUBLISH_JOB_ACTIONS.has(action)) problems.push(`${where}: ${action} is not allowed in a publish job`);
        if (PUBLISH_ACTIONS.has(action)) publishSteps++;
        const w = map.get('with');
        if (w && mapping(body, ...w.block).has('cache')) problems.push(`${where}: no dependency cache in a publish job`);
      }
      const run = map.get('run');
      if (run !== undefined) {
        // The raw text, comments included: a shell would still run what follows a quoted "#".
        const cmds = /^[|>][-+]?$/.test(run.raw.trim()) ? body.slice(...run.block).map((l) => l.trim()).filter(Boolean) : [run.raw.trim()];
        for (const c of cmds) {
          if (!PUBLISH_RUN.test(c)) problems.push(`${where}: a publish job runs only npm publish of the downloaded tarball (found: ${c})`);
          else publishSteps++;
        }
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
