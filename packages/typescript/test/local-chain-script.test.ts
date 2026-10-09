// scripts/local-chain.sh run against stub anvil / curl / forge binaries in a throwaway root: no node is started and no
// network is touched. Pins the cleanup scope (only this script's own outputs) and the anvil identity check.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptsDir = new URL('../../../scripts/', import.meta.url).pathname;
const dirs: string[] = [];

const CURL = `#!/usr/bin/env bash
# Stub curl: answers only once the stub anvil is up; never opens a socket.
data=""
while [ $# -gt 0 ]; do
  case "$1" in --data) data="$2"; shift 2 ;; *) shift ;; esac
done
[ -f "$STUB_STATE/up" ] || exit 7
case "$data" in
  *eth_chainId*) printf '{"jsonrpc":"2.0","id":1,"result":"0x7a69"}' ;;
  *web3_clientVersion*) printf '{"jsonrpc":"2.0","id":2,"result":"%s"}' "$STUB_CLIENT" ;;
  *) printf '{}' ;;
esac
`;

const ANVIL = `#!/usr/bin/env bash
touch "$STUB_STATE/up"
exec "$STUB_STATE/real/anvil" 30
`;

const FORGE = `#!/usr/bin/env bash
touch "$STUB_STATE/forge-ran"
mkdir -p broadcast/DeployAgentLocal.s.sol/31337 cache/DeployAgentLocal.s.sol/31337 test-export
echo '{}' > broadcast/DeployAgentLocal.s.sol/31337/run-latest.json
echo '{}' > cache/DeployAgentLocal.s.sol/31337/run-latest.json
# A real deployment's broadcast written while this script runs (another terminal): must never be removed.
mkdir -p broadcast/DeployAgentAccounts.s.sol/5042002
echo '{"real":true}' > broadcast/DeployAgentAccounts.s.sol/5042002/run-latest.json
[ "\${STUB_FORGE_FAIL:-0}" = 1 ] && exit 3
echo '{"chainId":31337}' > test-export/agent-local-31337.json
`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lchain-'));
  dirs.push(root);
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const contracts = join(root, 'contracts');
  for (const d of [join(root, 'scripts'), join(root, 'fixtures'), state, join(state, 'real'), bin, join(contracts, 'script')]) {
    mkdirSync(d, { recursive: true });
  }
  for (const f of ['local-chain.sh', 'stop-local-chain.sh']) {
    copyFileSync(join(scriptsDir, f), join(root, 'scripts', f));
    chmodSync(join(root, 'scripts', f), 0o755);
  }
  // A process whose command name contains "anvil", so stop-local-chain.sh recognises and kills it.
  // A symlink, not a copy: a copied signed system binary can hang in exit on macOS.
  symlinkSync('/bin/sleep', join(state, 'real', 'anvil'));
  for (const [name, text] of [['curl', CURL], ['anvil', ANVIL], ['forge', FORGE]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(contracts, 'script', 'build-trade-router.sh'), 'true\n');
  return { root, state, bin, contracts };
}

function run(t: ReturnType<typeof setup>, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(t.root, 'scripts', 'local-chain.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${t.bin}:${process.env.PATH ?? ''}`,
      MERCURIFI_CONTRACTS_DIR: t.contracts,
      ANVIL_PORT: '59999',
      STUB_STATE: t.state,
      STUB_CLIENT: 'anvil/v1.3.0',
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const pidFile = (t: { root: string }) => join(t.root, '.anvil-59999.pid');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    const p = join(d, '.anvil-59999.pid');
    if (existsSync(p)) {
      const pid = Number(readFileSync(p, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          /* already gone */
        }
      }
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === 'win32')('scripts/local-chain.sh', () => {
  it('removes only its own outputs and keeps a real broadcast that appeared during the run', () => {
    const t = setup();
    const r = run(t);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(t.root, 'fixtures', 'local-book-59999.json'))).toBe(true);
    expect(existsSync(join(t.contracts, 'broadcast', 'DeployAgentAccounts.s.sol', '5042002', 'run-latest.json'))).toBe(true);
    expect(existsSync(join(t.contracts, 'broadcast', 'DeployAgentLocal.s.sol'))).toBe(false);
    expect(existsSync(join(t.contracts, 'cache', 'DeployAgentLocal.s.sol'))).toBe(false);
    expect(existsSync(join(t.contracts, 'test-export', 'agent-local-31337.json'))).toBe(false);
    const pid = Number(readFileSync(pidFile(t), 'utf8').trim());
    expect(alive(pid)).toBe(true);
    const stop = spawnSync('bash', [join(t.root, 'scripts', 'stop-local-chain.sh'), '59999'], { encoding: 'utf8' });
    expect(stop.status).toBe(0);
    expect(existsSync(pidFile(t))).toBe(false);
  });

  it('keeps a pre-existing broadcast tree and stops the node when the deploy fails', () => {
    const t = setup();
    const keep = join(t.contracts, 'broadcast', 'Old.s.sol', '1', 'run-latest.json');
    mkdirSync(join(t.contracts, 'broadcast', 'Old.s.sol', '1'), { recursive: true });
    writeFileSync(keep, '{}');
    const r = run(t, { STUB_FORGE_FAIL: '1' });
    expect(r.code).not.toBe(0);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(join(t.contracts, 'broadcast', 'DeployAgentAccounts.s.sol', '5042002', 'run-latest.json'))).toBe(true);
    expect(existsSync(join(t.contracts, 'broadcast', 'DeployAgentLocal.s.sol'))).toBe(false);
    expect(existsSync(pidFile(t))).toBe(false);
  });

  it('refuses to deploy when the node does not name itself anvil', () => {
    const t = setup();
    const r = run(t, { STUB_CLIENT: 'Geth/v1.14.0' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not Anvil/);
    expect(existsSync(join(t.state, 'forge-ran'))).toBe(false);
    expect(existsSync(pidFile(t))).toBe(false);
  });
});
