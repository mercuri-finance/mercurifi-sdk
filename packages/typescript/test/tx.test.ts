import { encodeErrorResult, encodeFunctionData, parseTransaction } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { NetworkMismatchError, TxDroppedError } from '../src/errors.js';
import { createClient } from '../src/client.js';
import { MercurifiError } from '../src/errors.js';
import { localNetwork } from '../src/networks.js';
import { localJson } from './helpers/local.js';
import { ContractRevertError } from '../src/revert.js';
import { localKey } from '../src/signers.js';
import { chainDeadline } from '../src/time.js';
import { TxSender } from '../src/tx.js';
import { ACCOUNT, localClient, localRpc, OWNER_KEY as KEY, TOKEN } from './helpers/local.js';
import { MockRpc } from './helpers/mockRpc.js';

const buyData = encodeFunctionData({ abi: agentAccountAbi, functionName: 'buy', args: [TOKEN, 1_000_000n, 1n, 1n] });

const setup = async (rpc: MockRpc, receiptTimeoutMs = 60_000) => {
  rpc.read(ACCOUNT, agentAccountAbi, 'buy', 5n);
  return localClient(rpc, { receiptTimeoutMs });
};

afterEach(() => vi.useRealTimers());

describe('TxSender', () => {
  it('preflights, floors the fee and sends a type-2 transaction', async () => {
    const rpc = localRpc();
    rpc.block.baseFeePerGas = 0n;
    const mf = await setup(rpc);
    const sent = await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(sent.receipt.status).toBe('success');
    const tx = parseTransaction(rpc.sent[0]!);
    expect(tx.maxFeePerGas).toBe(20_000_000_000n);
    expect(tx.gas).toBe(180_000n);
    expect(tx.nonce).toBe(7);
  });

  it('sends graduating buys with the 1.8M floor and preflights with it', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, mayGraduate: true, label: 'buy' });
    expect(parseTransaction(rpc.sent[0]!).gas).toBe(1_800_000n);
    const call = rpc.methods('eth_call').find((p) => (p[0] as { to: string }).to.toLowerCase() === ACCOUNT)!;
    expect(BigInt((call[0] as { gas: string }).gas)).toBe(1_800_000n);
  });

  it('stops at a preflight revert and signs nothing', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    // The registry's cap error bubbles through the account call unchanged (the decoder merges both ABIs).
    rpc.revert(ACCOUNT, agentAccountAbi, 'buy', encodeErrorResult({ abi: agentPolicyRegistryAbi, errorName: 'PeriodSpendExceeded', args: [3_000_000n] } as never));
    const err = await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).message).toContain('3 USDC');
    expect(rpc.sent).toHaveLength(0);
  });

  it('a dropped transaction re-reads the nonce (Review Focus 3)', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc, 5);
    rpc.receiptMode = 'none';
    await expect(mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' })).rejects.toThrow(TxDroppedError);
    rpc.receiptMode = 'success';
    rpc.nonce = 7; // the dropped nonce was never used on chain
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(parseTransaction(rpc.sent[1]!).nonce).toBe(7);
    expect(rpc.methods('eth_getTransactionCount')).toHaveLength(2);
  });

  it('serialises concurrent sends from one key and increments the nonce locally', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    const s = localKey(KEY);
    await Promise.all([1, 2, 3].map(() => mf.sender.send(s, { to: ACCOUNT, data: buyData, label: 'buy' })));
    expect(rpc.sent.map((r) => parseTransaction(r).nonce)).toEqual([7, 8, 9]);
    expect(rpc.methods('eth_getTransactionCount')).toHaveLength(1);
  });

  it('uses chain time, not the local clock (Review Focus 2)', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Number(rpc.block.timestamp) * 1000 + 10 * 60 * 1000);
    expect(await chainDeadline(mf.publicClient, 120, 60)).toBe(rpc.block.timestamp + 60n);
    expect(await chainDeadline(mf.publicClient, 30, 60)).toBe(rpc.block.timestamp + 30n);
  });

  it('signs the verified chain id and aborts, signing nothing, when the RPC changes chain', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(parseTransaction(rpc.sent[0]!).chainId).toBe(31337);
    (rpc as { chainId: number }).chainId = 5042;
    const err = await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkMismatchError);
    expect(rpc.sent).toHaveLength(1);
  });

  it('floors maxFeePerGas at 20 gwei even when the node reports a lower base fee and tip', async () => {
    const rpc = localRpc();
    rpc.block.baseFeePerGas = 1n;
    rpc.on('eth_maxPriorityFeePerGas', () => '0x1');
    const mf = await setup(rpc);
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(parseTransaction(rpc.sent[0]!).maxFeePerGas).toBeGreaterThanOrEqual(20_000_000_000n);
  });

  it('keeps a private key out of every surfaced error', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc, 5);
    rpc.receiptMode = 'none';
    const err = (await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' }).catch((e: unknown) => e)) as Error;
    expect(`${err.message}${err.stack}${JSON.stringify(err)}`).not.toContain(KEY.slice(2, 20));
  });
});

describe('TxSender hardening', () => {
  const SECRET_URL = 'https://h.example/v2/SECRET';
  const leaks = (e: unknown): string => { const x = e as Error; return `${x.message}${x.stack}${JSON.stringify(x)}${String(x.cause)}`; };

  it.each(['eth_chainId', 'eth_call', 'eth_estimateGas', 'eth_getBlockByNumber', 'eth_sendRawTransaction', 'eth_getTransactionReceipt'])(
    'turns a %s transport failure into a credential-free RPC_ERROR', async (method) => {
      const rpc = localRpc();
      const mf = await setup(rpc);
      rpc.on(method, () => { throw new Error(`HTTP request failed. URL: ${SECRET_URL}\nRequest body: {}`); });
      const err = await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, mayGraduate: true, label: 'buy' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MercurifiError);
      expect((err as MercurifiError).code).toBe('RPC_ERROR');
      expect(leaks(err)).not.toContain('SECRET');
      expect((err as Error).cause).toBeUndefined();
    });

  it('preflight() also redacts', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    rpc.on('eth_call', () => { throw new Error(`failed at ${SECRET_URL}`); });
    const err = await mf.sender.preflight(localKey(KEY).address, { to: ACCOUNT, data: buyData, label: 'buy' }).catch((e: unknown) => e);
    expect(leaks(err)).not.toContain('SECRET');
  });

  it('preflights a queued send after its predecessor lands, and never signs it if it now reverts', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    const revertData = encodeErrorResult({ abi: agentPolicyRegistryAbi, errorName: 'PeriodSpendExceeded', args: [0n] } as never);
    rpc.read(ACCOUNT, agentAccountAbi, 'buy', () => {
      if (rpc.sent.length > 0) throw Object.assign(new Error('execution reverted'), { code: 3, data: revertData });
      return 5n;
    });
    const s = localKey(KEY);
    const [first, second] = await Promise.allSettled([
      mf.sender.send(s, { to: ACCOUNT, data: buyData, label: 'buy' }),
      mf.sender.send(s, { to: ACCOUNT, data: buyData, label: 'buy' }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(ContractRevertError);
    expect(rpc.sent).toHaveLength(1);
  });

  it('falls back to 1.8M only when the node failed to estimate, not on transport errors', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    rpc.on('eth_estimateGas', () => { throw Object.assign(new Error('gas required exceeds allowance'), { code: -32000 }); });
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, mayGraduate: true, label: 'buy' });
    expect(parseTransaction(rpc.sent[0]!).gas).toBe(1_800_000n);
    rpc.on('eth_estimateGas', () => { throw new Error('socket hang up'); });
    const err = await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, mayGraduate: true, label: 'buy' }).catch((e: unknown) => e);
    expect((err as MercurifiError).code).toBe('RPC_ERROR');
    expect(rpc.sent).toHaveLength(1);
  });

  it('caps the priority fee at 100 gwei by default and at a configured ceiling', async () => {
    const rpc = localRpc();
    rpc.on('eth_maxPriorityFeePerGas', () => `0x${(500_000_000_000n).toString(16)}`);
    const mf = await setup(rpc);
    await mf.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(parseTransaction(rpc.sent[0]!).maxPriorityFeePerGas).toBe(100_000_000_000n);
    const rpc2 = localRpc();
    rpc2.on('eth_maxPriorityFeePerGas', () => `0x${(500_000_000_000n).toString(16)}`);
    rpc2.read(ACCOUNT, agentAccountAbi, 'buy', 5n);
    const mf2 = await localClient(rpc2, { maxPriorityFeePerGas: 2_000_000_000n });
    await mf2.sender.send(localKey(KEY), { to: ACCOUNT, data: buyData, label: 'buy' });
    expect(parseTransaction(rpc2.sent[0]!).maxPriorityFeePerGas).toBe(2_000_000_000n);
  });

  it('rejects non-positive-integer pollMs and receiptTimeoutMs', async () => {
    for (const over of [{ pollMs: 0 }, { pollMs: 1.5 }, { pollMs: Number.NaN }, { receiptTimeoutMs: 0 }, { receiptTimeoutMs: -1 }, { receiptTimeoutMs: Infinity }]) {
      await expect(localClient(localRpc(), over)).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
});

describe('verify: false', () => {
  it('is honoured for the local book', async () => {
    const rpc = new MockRpc(31337);
    const mf = await createClient({ network: localNetwork(localJson()), rpcUrl: 'http://127.0.0.1:8545', transport: rpc.transport(), verify: false });
    expect(mf.network.chainId).toBe(31337);
    expect(rpc.calls).toHaveLength(0);
  });

  it('is ignored with a warning on testnet and mainnet: the chain check still runs', async () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      const rpc = new MockRpc(31337); // wrong chain for both books
      const warnings: string[] = [];
      await expect(createClient({
        network, rpcUrl: 'https://rpc.example.org', transport: rpc.transport(), verify: false, onWarning: (m) => warnings.push(m),
      })).rejects.toThrow(NetworkMismatchError);
      expect(warnings.join(' ')).toContain('verify: false is ignored');
    }
  });
});

describe('signer and sender hardening', () => {
  it('reports a signer failure by its shortMessage with URLs reduced to hosts', async () => {
    const rpc = localRpc();
    const mf = await setup(rpc);
    const bad = {
      address: localKey(KEY).address,
      signTransaction: async () => { throw Object.assign(new Error('long message https://kms.example/secret-key-path\nbody'), { shortMessage: 'kms down at https://kms.example/secret-key-path' }); },
    };
    const err = await mf.sender.send(bad, { to: ACCOUNT, data: buyData, label: 'buy' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SIGNER_ERROR' });
    expect((err as Error).message).toContain('kms down at kms.example');
    expect((err as Error).message).not.toContain('secret-key-path');
  });

  it('validates pollMs and receiptTimeoutMs on direct construction', async () => {
    const mf = await setup(localRpc());
    const deps = { client: mf.publicClient, chainId: 31337, nonces: mf.nonces, receiptTimeoutMs: 1000, pollMs: 10, maxFeePerGasCap: undefined, maxPriorityFeePerGas: 1n };
    for (const over of [{ pollMs: 0 }, { pollMs: 1.5 }, { pollMs: Number.NaN }, { receiptTimeoutMs: 0 }, { receiptTimeoutMs: Infinity }]) {
      expect(() => new TxSender({ ...deps, ...over })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    expect(() => new TxSender(deps)).not.toThrow();
  });
});
