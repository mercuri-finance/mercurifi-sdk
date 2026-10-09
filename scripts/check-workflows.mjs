// Supply-chain gate for .github/workflows: SHA-pinned actions, explicit least-privilege permissions, no
// pull_request_target, and release workflows that only run on a manual, environment-gated dispatch.
// Usage: node scripts/check-workflows.mjs [workflows-dir]
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const problems = [];
const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
if (files.length === 0) problems.push('no workflow files found');
for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8');
  const code = text.replace(/^\s*#.*$/gm, ''); // comments may mention forbidden names
  for (const [, ref] of code.matchAll(/^\s*-?\s*uses:\s*['"]?([^\s#'"]+)/gm)) {
    if (ref.startsWith('./')) continue;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) problems.push(`${file}: ${ref} is not pinned to a commit SHA`);
  }
  if (/pull_request_target/.test(code)) problems.push(`${file}: pull_request_target is not allowed`);
  if (/^\s*uses:\s*docker:/m.test(code)) problems.push(`${file}: docker:// actions are not allowed`);
  if (!/^permissions:[ \t]*$/m.test(code) || !/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(code)) {
    problems.push(`${file}: the top-level permissions block must be exactly contents: read`);
  }
  if (/:\s*write-all|permissions:\s*write-all/.test(code)) problems.push(`${file}: write-all is not allowed`);
  if (/^\s+(contents|packages|actions|pull-requests|issues|checks|deployments|statuses):\s*write/m.test(code)) problems.push(`${file}: only id-token may be write`);
  if (/^\s*persist-credentials:\s*true/m.test(code)) problems.push(`${file}: persist-credentials must stay false`);
  // Each checkout step (the "- uses:" line and the lines indented under it) must turn credential persistence off.
  const lines = code.split('\n');
  lines.forEach((line, n) => {
    const step = /^(\s*)- uses:\s*actions\/checkout@/.exec(line);
    if (step === null) return;
    const block = [];
    for (let k = n + 1; k < lines.length && (lines[k].trim() === '' || lines[k].search(/\S/) > step[1].length); k++) block.push(lines[k]);
    if (!block.some((l) => /^\s*persist-credentials:\s*false\s*$/.test(l))) problems.push(`${file}: every checkout must set persist-credentials: false`);
  });
  // Untrusted event text must never be interpolated into a shell step.
  if (/\$\{\{\s*github\.(event\.(issue|pull_request|comment|review|head_commit|pages|commits)|head_ref)/.test(code)) {
    problems.push(`${file}: attacker-controlled github context in an expression`);
  }
  const hasIdToken = /^\s+id-token:\s*write/m.test(code);
  const release = file.startsWith('release-');
  if (hasIdToken && !release) problems.push(`${file}: id-token: write belongs only in a release workflow`);
  if (release) {
    const on = code.match(/^on:\s*\n((?:[ \t]+.*\n|\n)+)/m)?.[1] ?? '';
    const triggers = [...on.matchAll(/^ {1,4}(\S+?):/gm)].map((m) => m[1]);
    if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') problems.push(`${file}: release workflows run only on workflow_dispatch (found: ${triggers.join(', ') || 'none'})`);
    if (/^on:[ \t]*\S/m.test(code)) problems.push(`${file}: write the on: block as a mapping so the trigger list can be checked`);
    if (!/^\s+environment:\s*\S+/m.test(code)) problems.push(`${file}: the publish job needs a protected environment`);
    if (!hasIdToken) problems.push(`${file}: the publish job needs id-token: write for trusted publishing`);
    if (!/^\s+if:\s*github\.repository_owner\s*==/m.test(code)) problems.push(`${file}: the publish job must be restricted to the owning organisation`);
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('workflows ok');
