import { inspect } from 'node:util';
import { parseTransaction, recoverTransactionAddress, type TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { generateAgentKey, kmsSigner, localKey } from '../src/signers.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SECRET = KEY.slice(2, 20);
const TX: TransactionSerializableEIP1559 = {
  type: 'eip1559', chainId: 31337, nonce: 1, to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n,
  gas: 21_000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1n,
};

describe('signers', () => {
  it('never exposes the key through JSON, inspect, enumeration or errors', () => {
    const s = localKey(KEY);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    for (const opts of [{}, { showHidden: true, depth: 8 }, { showHidden: true, depth: null, getters: true }]) {
      expect(inspect(s, opts)).not.toContain(SECRET);
    }
    expect(inspect(s)).toBe(`LocalKeySigner(${s.address})`);
    expect(`${String(s)}${JSON.stringify({ s })}`).not.toContain(SECRET);
    // no own property (enumerable or not) holds the key
    const own = [...Object.getOwnPropertyNames(s), ...Object.getOwnPropertySymbols(s)];
    for (const k of own) expect(inspect((s as never)[k as never], { showHidden: true, depth: 5 })).not.toContain(SECRET);
    expect(Object.keys(s).sort()).toEqual(['address', 'signTransaction']);
    let message = '';
    try { localKey(`${KEY}zz`); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/32-byte hex/);
    expect(message).not.toContain(SECRET);
  });

  it('rejects an out-of-range key without echoing it', () => {
    const zero = `0x${'00'.repeat(32)}`;
    const err = (() => { try { localKey(zero); } catch (e) { return e as Error; } return undefined; })();
    expect(err?.message).toMatch(/not a valid secp256k1/);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it('signs a transaction that recovers to its address', async () => {
    const s = localKey(KEY);
    const raw = await s.signTransaction(TX);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(s.address);
  });

  it('generates a fresh key locally', () => {
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(a.exportPrivateKey()).not.toBe(b.exportPrivateKey());
    expect(privateKeyToAccount(a.exportPrivateKey()).address).toBe(a.address);
  });

  it('wraps a KMS adapter and checks the recovered address', async () => {
    const account = privateKeyToAccount(KEY);
    const adapter = {
      address: account.address,
      signDigest: async (digest: `0x${string}`) => {
        const sig = await account.sign({ hash: digest });
        return { r: `0x${sig.slice(2, 66)}` as `0x${string}`, s: `0x${sig.slice(66, 130)}` as `0x${string}`, yParity: (parseInt(sig.slice(130, 132), 16) - 27) as 0 | 1 };
      },
    };
    const raw = await kmsSigner(adapter).signTransaction(TX);
    expect(parseTransaction(raw).nonce).toBe(1);
    await expect(kmsSigner({ ...adapter, address: '0x0000000000000000000000000000000000000002' }).signTransaction(TX)).rejects.toThrow(/does not recover/);
    expect(JSON.stringify(kmsSigner(adapter))).not.toContain(SECRET);
  });

  const kms = (mutate: (r: `0x${string}`, s: bigint, parity: 0 | 1) => { r: `0x${string}`; s: bigint; yParity?: 0 | 1 }) => {
    const account = privateKeyToAccount(KEY);
    return {
      address: account.address,
      signDigest: async (digest: `0x${string}`) => {
        const sig = await account.sign({ hash: digest });
        const out = mutate(`0x${sig.slice(2, 66)}`, BigInt(`0x${sig.slice(66, 130)}`), (parseInt(sig.slice(130, 132), 16) - 27) as 0 | 1);
        return { r: out.r, s: `0x${out.s.toString(16).padStart(64, '0')}` as `0x${string}`, ...(out.yParity === undefined ? {} : { yParity: out.yParity }) };
      },
    };
  };
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  it('normalises a high s and flips the parity instead of rejecting', async () => {
    const raw = await kmsSigner(kms((r, s, p) => ({ r, s: N - s, yParity: (p === 0 ? 1 : 0) as 0 | 1 }))).signTransaction(TX);
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(privateKeyToAccount(KEY).address);
    expect(BigInt(parseTransaction(raw).s!) <= N / 2n).toBe(true);
  });

  it('finds the recovery id itself when the adapter returns none', async () => {
    for (const flip of [false, true]) {
      const raw = await kmsSigner(kms((r, s) => ({ r, s: flip ? N - s : s }))).signTransaction(TX);
      expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(privateKeyToAccount(KEY).address);
    }
  });

  it('rejects r or s equal to 0 or not below n', async () => {
    const zero = `0x${'00'.repeat(32)}` as const;
    const nHex = `0x${N.toString(16)}` as const;
    await expect(kmsSigner(kms((_r, s) => ({ r: zero, s }))).signTransaction(TX)).rejects.toThrow(/outside 1\.\.n-1/);
    await expect(kmsSigner(kms((r) => ({ r, s: 0n }))).signTransaction(TX)).rejects.toThrow(/outside 1\.\.n-1/);
    await expect(kmsSigner(kms((r) => ({ r, s: N }))).signTransaction(TX)).rejects.toThrow(/outside 1\.\.n-1/);
    await expect(kmsSigner(kms((_r, s) => ({ r: nHex, s }))).signTransaction(TX)).rejects.toThrow(/outside 1\.\.n-1/);
  });

  it('rejects non-string key input with InvalidInputError', () => {
    for (const bad of [undefined, null, 5, {}, ['0x']] as unknown[]) {
      expect(() => localKey(bad as string)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });

  it('keeps a generated key out of JSON and inspect, with an explicit accessor', () => {
    const k = generateAgentKey();
    const secret = k.exportPrivateKey().slice(2, 20);
    expect(k.privateKey).toBe(k.exportPrivateKey());
    expect(Object.keys(k)).toEqual(['address']);
    expect(JSON.stringify(k)).not.toContain(secret);
    expect(inspect(k, { showHidden: true, depth: 5 })).not.toContain(secret);
    expect(`${JSON.stringify({ k })}${inspect({ k }, { depth: 5 })}`).not.toContain(secret);
    expect(privateKeyToAccount(k.exportPrivateKey()).address).toBe(k.address);
  });
});
