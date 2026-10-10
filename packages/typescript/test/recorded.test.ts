import { readdirSync, readFileSync } from 'node:fs';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { fillFromReceipt } from '../src/fills.js';
import { decodeRevert } from '../src/revert.js';

const DIR = new URL('../../../fixtures/recorded/', import.meta.url);
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
const str = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));

describe('recorded Anvil fixtures', () => {
  it('exist', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'fill-buy.json',
        'fill-launch.json',
        'fill-sell.json',
        'fill-sell-high-water.json',
        'revert-launch-limit.json',
        'revert-missing-permission.json',
        'revert-snipe.json',
        'revert-stale.json',
        'revert-trade-too-large.json',
      ]),
    );
  });
  it('names the declaring contract in every recorded revert', () => {
    const reverts = files.filter((f) => f.startsWith('revert-'));
    expect(reverts.length).toBeGreaterThan(0);
    for (const f of reverts) {
      const source = JSON.parse(readFileSync(new URL(f, DIR), 'utf8')).expected?.source;
      expect(['AgentAccount', 'AgentPolicyRegistry', 'AgentAccountFactory'], f).toContain(source);
    }
  });
  it.each(files)('%s decodes exactly as recorded', (f) => {
    const r = JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
    if (r.kind === 'fill') {
      const fill = fillFromReceipt(
        {
          ...r.receipt,
          blockNumber: BigInt(r.receipt.blockNumber),
          gasUsed: BigInt(r.receipt.gasUsed),
          effectiveGasPrice: BigInt(r.receipt.effectiveGasPrice),
        },
        r.account as Address,
        r.launchFactory as Address,
      );
      const { action, token, usdcSpent6, usdcReceived6, tokenDelta, basisValue6, launched } = fill;
      expect(
        str({ action, token, usdcSpent6, usdcReceived6, tokenDelta, basisValue6, launched }),
      ).toEqual(r.expected);
    } else {
      expect(r.kind).toBe('revert');
      const d = decodeRevert(r.data as Hex);
      expect({ name: d.name, message: d.message, source: d.source }).toEqual(r.expected);
    }
  });
});
