#!/usr/bin/env node
// Generates the SDK ABIs from the Foundry artifacts of an agent contracts checkout (MERCURIFI_CONTRACTS_DIR).
//   node scripts/gen-abis.mjs [--contracts DIR] [--allow-dirty]   generate
//   node scripts/gen-abis.mjs --check [--contracts DIR]           committed output must equal a regeneration
//   node scripts/gen-abis.mjs --verify-digest                      TS and Python copies agree with the digest (no contracts needed)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TS_OUT = join(ROOT, 'packages/typescript/src/abi/generated.ts');
const PY_DIR = join(ROOT, 'packages/python/src/mercurifi/abi');
const DIGEST_FILE = join(ROOT, 'fixtures/abi-digest.json');
const DEFAULT_CONTRACTS = resolve(ROOT, '../../agent-contracts');

// [SDK name, artifact directory under out/, contract name]
export const SOURCES = [
  ['agentAccount', 'AgentAccount.sol', 'AgentAccount'],
  ['agentPolicyRegistry', 'AgentPolicyRegistry.sol', 'AgentPolicyRegistry'],
  ['agentAccountFactory', 'AgentAccountFactory.sol', 'AgentAccountFactory'],
  ['bondingCurve', 'BondingCurve.sol', 'BondingCurve'],
  ['launchFactory', 'LaunchFactory.sol', 'LaunchFactory'],
  ['feeManager', 'FeeManager.sol', 'FeeManager'],
  ['graduationManager', 'GraduationManager.sol', 'GraduationManager'],
  ['launchHook', 'LaunchHook.sol', 'LaunchHook'],
  ['launchToken', 'LaunchToken.sol', 'LaunchToken'],
  ['v4Quoter', 'V4Quoter.sol', 'V4Quoter'],
  ['universalRouter', 'trade-router/UniversalRouter.sol', 'UniversalRouter'],
];

// Members the SDK calls or decodes. A missing one is an interface break with the contracts: stop and report.
const REQUIRED = {
  agentAccount: {
    function: ['FACTORY', 'REGISTRY', 'owner', 'referrer', 'basis', 'buy', 'sell', 'launch', 'swapExactIn', 'claimFees',
      'sweepToOwner', 'withdraw', 'withdrawMany', 'isValidSignature'],
    event: ['AgentAction', 'AccountWithdrawn'],
    error: ['TradeTooLarge', 'PriceImpactTooHigh', 'TokenNotRegistered', 'TokenNotAllowed', 'TokenTooNew', 'SnipeTaxTooHigh', 'ZeroMinOut',
      'NotTrading', 'NotGraduated', 'ZeroOutput', 'AmountTooLarge'],
  },
  agentPolicyRegistry: {
    function: ['FACTORY', 'owner', 'policy', 'periodSeconds', 'increaseDelay', 'agent', 'activeAgentCount', 'retired',
      'tokenAllowed', 'ownerPaused', 'writeSeq', 'epoch', 'policyWrite', 'agentWrite', 'tokenWrite', 'delayWrite', 'queued',
      'usage', 'tokenSpent', 'headroom', 'addAgent', 'setAgent', 'revokeAgent', 'rotateAgent', 'setPolicy', 'setTokenAllowed',
      'setIncreaseDelay', 'transferOwnership', 'acceptOwnership', 'executeQueued', 'cancelQueued', 'pauseAgents'],
    event: ['PolicyApplied', 'AgentActivated', 'AgentQueued', 'AgentRevoked', 'PolicyQueued', 'QueuedCancelled', 'QueuedExecuted',
      'TokenAllowed', 'TokenAllowQueued', 'AgentsPaused', 'IncreaseDelaySet', 'IncreaseDelayQueued', 'OwnershipQueued',
      'AccountOwnerChanged'],
    error: ['PeriodSpendExceeded', 'PeriodSellExceeded', 'TokenCapExceeded', 'ActionLimit', 'LaunchLimit', 'NotAgent', 'AgentExpired',
      'MissingPermission', 'Paused', 'DeadlineOutOfRange', 'StaleQueued'],
  },
  agentAccountFactory: {
    function: ['createAccount', 'predictAccount', 'isAccount', 'implementation', 'registry', 'ceilings', 'isPaused', 'pausedUntil'],
    event: ['AccountCreated'],
  },
  bondingCurve: { function: ['phase', 'quoteBuy', 'quoteSell', 'price', 'sold', 'curveSupply', 'currentSnipeBps', 'launchBlock', 'progressBps', 'token'], event: [] },
  launchFactory: { function: ['curveOf', 'config', 'configHash', 'createToken'], event: ['TokenCreated'] },
  feeManager: { function: ['balances', 'referrerOf', 'tokenInfo'], event: [] },
  graduationManager: { function: ['poolKey'], event: [] },
  launchHook: { function: [], event: [] },
  launchToken: { function: ['balanceOf', 'name', 'symbol', 'decimals'], event: [] },
  v4Quoter: { function: ['quoteExactInputSingle'], event: [] },
  universalRouter: { function: ['execute'], event: [] },
};

// Exact field names the SDK encodes or decodes by name: [SDK name, item type, item name, where, names].
// `where` is 'inputs', 'outputs' or 'components' (the components of the first input, a struct).
const SHAPES = [
  ['agentAccount', 'function', 'launch', 'components',
    ['name', 'symbol', 'metadataURI', 'salt', 'expectedConfigHash', 'initialBuyUsdc', 'minTokensOut', 'deadline']],
  ['agentAccount', 'function', 'basis', 'outputs', ['costUsdc', 'tokens', 'highWater']],
  ['agentAccount', 'event', 'AgentAction', 'inputs',
    ['agent', 'action', 'token', 'usdcSpent', 'usdcReceived', 'tokenDelta', 'basisValue', 'periodId']],
  ['agentPolicyRegistry', 'function', 'queued', 'outputs', ['kind', 'eta', 'itemEpoch', 'seq', 'payload']],
  ['agentPolicyRegistry', 'event', 'AgentQueued', 'inputs', ['account', 'id', 'agent', 'expiresAt', 'permissions', 'eta']],
];

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
      : v;

/** JSON with sorted keys and no whitespace; Python's json.dumps(sort_keys=True, separators=(",",":")) is identical. */
export const canonical = (value) => JSON.stringify(sortKeys(value));

/** sha256 over "<name>\n<canonical abi>\n" for every entry, sorted by name. */
export const digestOf = (entries) =>
  createHash('sha256')
    .update([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, abi]) => `${n}\n${canonical(abi)}\n`).join(''))
    .digest('hex');

const loadAbi = (outDir, dir, contract) => {
  const files = ['', '.default', '.small', '.posm'].map((p) => join(outDir, dir, `${contract}${p}.json`)).filter((f) => existsSync(f));
  if (files.length === 0) {
    throw new Error(`missing artifact out/${dir}/${contract}: run forge build (and bash script/build-trade-router.sh for the router) in the contracts worktree`);
  }
  const abis = files.map((f) => JSON.parse(readFileSync(f, 'utf8')).abi);
  if (new Set(abis.map(canonical)).size !== 1) throw new Error(`${contract}: compiler profiles disagree on the ABI`);
  return abis[0];
};

/** Non-fatal: a Foundry artifact older than its Solidity source may predate a contract edit (run forge build). */
const warnStale = (contractsDir, dir, contract) => {
  const artifacts = ['', '.default', '.small', '.posm'].map((p) => join(contractsDir, 'out', dir, `${contract}${p}.json`)).filter((f) => existsSync(f));
  const source = findSource(contractsDir, contract);
  if (source === null) return;
  const sourceTime = statSync(source).mtimeMs;
  for (const f of artifacts) {
    if (statSync(f).mtimeMs < sourceTime) console.warn(`warning: ${f} is older than ${source}; run forge build in the contracts worktree`);
  }
};

const findSource = (root, contract) => {
  const stack = [join(root, 'src'), join(root, 'lib')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'test' && e.name !== '.git') stack.push(join(dir, e.name));
      } else if (e.name === `${contract}.sol`) return join(dir, e.name);
    }
  }
  return null;
};

const checkRequired = (name, abi) => {
  for (const [type, members] of Object.entries(REQUIRED[name])) {
    const have = new Set(abi.filter((i) => i.type === type).map((i) => i.name));
    const missing = members.filter((m) => !have.has(m));
    if (missing.length > 0) throw new Error(`${name} is missing ${type}(s) ${missing.join(', ')}: interface break, see the plan's "Interface dependencies"`);
  }
};

const checkShapes = (name, abi) => {
  for (const [source, type, item, where, expected] of SHAPES) {
    if (source !== name) continue;
    const found = abi.find((i) => i.type === type && i.name === item);
    const fields = where === 'components' ? found?.inputs?.[0]?.components : found?.[where];
    const actual = (fields ?? []).map((f) => f.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${name}.${item} ${where} are [${actual.join(', ')}], expected [${expected.join(', ')}]: interface break, see the plan's "Interface dependencies"`);
    }
  }
};

const contractsCommit = (dir, allowDirty) => {
  const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', 'src', 'lib'], { encoding: 'utf8' }).trim() !== '';
  if (dirty && !allowDirty) throw new Error('the contracts checkout has uncommitted changes under src/ or lib/; commit them or pass --allow-dirty');
  return dirty ? `${sha}-dirty` : sha;
};

const renderTs = (entries, digest, commit) =>
  `// GENERATED by scripts/gen-abis.mjs from contracts ${commit}. Do not edit; run npm run gen:abis.\n\n` +
  `export const ABI_DIGEST = '${digest}';\n\n` +
  entries.map(([n, abi]) => `export const ${n}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`).join('\n');

const body = (ts) => ts.split('\n').slice(1).join('\n'); // drop the header line that names the commit

const generate = (contractsDir, allowDirty) => {
  const outDir = join(contractsDir, 'out');
  const entries = SOURCES.map(([name, dir, contract]) => {
    const abi = loadAbi(outDir, dir, contract);
    warnStale(contractsDir, dir, contract);
    checkRequired(name, abi);
    checkShapes(name, abi);
    return [name, abi];
  });
  const digest = digestOf(entries);
  const commit = contractsCommit(contractsDir, allowDirty);
  return { entries, digest, commit, ts: renderTs(entries, digest, commit) };
};

const readPythonEntries = () =>
  readdirSync(PY_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(PY_DIR, f), 'utf8'))]);

const verifyDigest = () => {
  const shared = JSON.parse(readFileSync(DIGEST_FILE, 'utf8'));
  const py = readPythonEntries();
  const stems = py.map(([n]) => n).sort();
  const expected = SOURCES.map(([n]) => n).sort();
  if (JSON.stringify(stems) !== JSON.stringify(expected)) {
    console.error(`Python abi/ files [${stems.join(', ')}] differ from SOURCES [${expected.join(', ')}]`);
    process.exit(1);
  }
  const order = new Map(SOURCES.map(([n], i) => [n, i]));
  py.sort(([a], [b]) => order.get(a) - order.get(b));
  const problems = [];
  if (digestOf(py) !== shared.digest) problems.push('Python ABIs do not match fixtures/abi-digest.json');
  if (body(readFileSync(TS_OUT, 'utf8')) !== body(renderTs(py, shared.digest, shared.contractsCommit))) problems.push('TS generated.ts does not match the Python ABIs');
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`ABIs consistent (${shared.digest.slice(0, 12)}, contracts ${shared.contractsCommit})`);
};

const main = () => {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const contractsDir = args.includes('--contracts') ? resolve(args[args.indexOf('--contracts') + 1]) : DEFAULT_CONTRACTS;

  if (flag('--verify-digest')) {
    verifyDigest();
    return;
  }

  const { entries, digest, commit, ts } = generate(contractsDir, flag('--allow-dirty'));
  if (flag('--check')) {
    verifyDigest();
    const shared = JSON.parse(readFileSync(DIGEST_FILE, 'utf8'));
    if (shared.digest !== digest || body(readFileSync(TS_OUT, 'utf8')) !== body(ts)) {
      console.error(`ABIs are stale: committed ${shared.digest.slice(0, 12)}, contracts ${commit} give ${digest.slice(0, 12)}. Run npm run gen:abis.`);
      process.exit(1);
    }
    console.log('ABIs current');
    return;
  }

  mkdirSync(dirname(TS_OUT), { recursive: true });
  mkdirSync(PY_DIR, { recursive: true });
  mkdirSync(dirname(DIGEST_FILE), { recursive: true });
  writeFileSync(TS_OUT, ts);
  for (const [name, abi] of entries) writeFileSync(join(PY_DIR, `${name}.json`), `${JSON.stringify(abi, null, 2)}\n`);
  writeFileSync(DIGEST_FILE, `${JSON.stringify({ digest, contractsCommit: commit, names: entries.map(([n]) => n) }, null, 2)}\n`);
  console.log(`generated ${entries.length} ABIs from contracts ${commit} (${digest.slice(0, 12)})`);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
