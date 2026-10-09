import { encodeErrorResult, encodeFunctionData, parseTransaction } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentAccountAbi, agentPolicyRegistryAbi } from '../src/abi/index.js';
import { NetworkMismatchError, TxDroppedError } from '../src/errors.js';
import { createClient } from '../src/client.js';
import { localNetwork } from '../src/networks.js';
import { localJson } from './helpers/local.js';
import { ContractRevertError } from '../src/revert.js';
import { localKey } from '../src/signers.js';
import { chainDeadline } from '../src/time.js';
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
