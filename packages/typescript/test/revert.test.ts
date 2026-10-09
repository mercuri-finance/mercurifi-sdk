import { encodeErrorResult, type Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import { agentAccountAbi, agentAccountFactoryAbi, agentPolicyRegistryAbi, bondingCurveAbi, launchFactoryAbi } from '../src/abi/index.js';
import { ContractRevertError, decodeRevert, ERROR_MESSAGES, extractRevertData, localRevert, TxRevertedError } from '../src/revert.js';

const enc = (abi: Abi, errorName: string, args?: readonly unknown[]) => encodeErrorResult({ abi, errorName, args } as never);

describe('decodeRevert', () => {
  it('explains registry cap errors with the remaining headroom in USDC', () => {
    const d = decodeRevert(enc(agentPolicyRegistryAbi, 'PeriodSpendExceeded', [12_500_000n]));
    expect(d.name).toBe('PeriodSpendExceeded');
    expect(d.source).toBe('AgentPolicyRegistry');
    expect(d.message).toContain('12.5 USDC');
  });

  it('decodes account and registry errors from one trade alike', () => {
    const tooLarge = decodeRevert(enc(agentAccountAbi, 'TradeTooLarge', [100_000_000n]));
    expect([tooLarge.name, tooLarge.source]).toEqual(['TradeTooLarge', 'AgentAccount']);
    expect(tooLarge.message).toContain('100 USDC');
    const sell = decodeRevert(enc(agentPolicyRegistryAbi, 'PeriodSellExceeded', [3_000_000n]));
    expect([sell.name, sell.source]).toEqual(['PeriodSellExceeded', 'AgentPolicyRegistry']);
    expect(sell.message).toContain('3 USDC');
    expect(sell.message).toMatch(/high-water/);
  });

  it('names policy fields and shared errors', () => {
    expect(decodeRevert(enc(agentPolicyRegistryAbi, 'BetaCeiling', [0])).message).toContain('maxTradeUsdc');
    expect(decodeRevert(enc(agentPolicyRegistryAbi, 'InvalidPolicy', [9])).message).toContain('maxDeadlineSeconds');
    // Same signature in the account and the registry: one selector, named by the first source.
    expect(decodeRevert(enc(agentPolicyRegistryAbi, 'NotOwner')).source).toBe('AgentAccount');
  });

  it('decodes Launch errors that bubble through the account', () => {
    expect(decodeRevert(enc(bondingCurveAbi, 'Slippage')).message).toMatch(/slippage/i);
    expect(decodeRevert(enc(launchFactoryAbi, 'ConfigChanged')).message).toMatch(/config changed/i);
    expect(decodeRevert(enc(bondingCurveAbi, 'InsufficientGasForGraduation')).message).toContain('1,800,000');
  });

  it('handles Error(string), Panic, empty and unknown data', () => {
    expect(decodeRevert('0x08c379a0' + '0'.repeat(62) + '20' + '0'.repeat(62) + '03' + '616263' + '0'.repeat(58) as `0x${string}`).message).toBe('Reverted: abc');
    expect(decodeRevert('0x').name).toBe('EmptyRevert');
    expect(decodeRevert(undefined).name).toBe('EmptyRevert');
    expect(decodeRevert('0xdeadbeef').name).toBe('UnknownError');
  });

  it('has a readable message for every AgentAccount, AgentPolicyRegistry and factory error', () => {
    const errors = [...agentAccountAbi, ...agentPolicyRegistryAbi, ...agentAccountFactoryAbi]
      .filter((i) => i.type === 'error')
      .map((i) => (i as { name: string }).name);
    const missing = [...new Set(errors)].filter((n) => ERROR_MESSAGES[n] === undefined);
    expect(missing, `add ERROR_MESSAGES entries for: ${missing.join(', ')}`).toEqual([]);
  });

  it('reads revert data from nested RPC errors', () => {
    const data = enc(agentPolicyRegistryAbi, 'ActionLimit');
    const nested = { message: 'outer', cause: { message: 'mid', cause: { code: 3, data } } };
    expect(extractRevertData(nested)).toBe(data);
    expect(extractRevertData({ cause: { data: { data } } })).toBe(data);
    expect(extractRevertData(new Error('timeout'))).toBeUndefined();
  });

  it('builds local errors with the same message as on-chain ones', () => {
    expect(localRevert('NotTrading').revert.message).toBe(ERROR_MESSAGES.NotTrading!([]));
    expect(localRevert('NotTrading').phase).toBe('local');
  });
});

describe('revert error classes', () => {
  it('decodes Panic(uint256)', () => {
    const d = decodeRevert(`0x4e487b71${'0'.repeat(62)}11` as `0x${string}`);
    expect(d.name).toBe('Panic');
    expect(d.message).toContain('0x11');
  });

  it('carries the decoded revert on both error types', () => {
    const local = localRevert('TradeTooLarge', [100_000_000n]);
    expect(local).toBeInstanceOf(ContractRevertError);
    expect(local.code).toBe('CONTRACT_REVERT');
    expect(local.message).toContain('100 USDC');
    const hash = `0x${'ab'.repeat(32)}` as const;
    const none = new TxRevertedError(hash, null);
    expect([none.code, none.revert]).toEqual(['TX_REVERTED', null]);
    const some = new TxRevertedError(hash, local.revert);
    expect(some.message).toContain(local.revert.message);
  });
});
