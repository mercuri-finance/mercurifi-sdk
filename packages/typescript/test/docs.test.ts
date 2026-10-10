import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LOSS_BOUND =
  "A stolen agent key can still lose money through bad trades: buying an attacker's token, or selling the account's holdings into a price the attacker pushed down. **That loss is bounded by the account's caps, not prevented.** Per period, the bound is the USDC spend cap plus the sell cap, which is measured at the account's own cost basis. It keeps accruing every period until the key is revoked or expires.";
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('docs carry the loss bound verbatim', () => {
  it.each(['../../../README.md', '../README.md', '../../../docs/security-model.md'])('%s', (p) =>
    expect(read(p)).toContain(LOSS_BOUND),
  );
  it.each(['quickstart-testnet', 'market-maker', 'launch-bot', 'llm-tools'])(
    'example %s links the security model',
    (n) => expect(read(`../examples/${n}.ts`)).toContain('docs/security-model.md'),
  );
  it('quickstart stays about ten statements', () => {
    // Statements, not lines: Prettier wraps long calls over several lines.
    const code = read('../examples/quickstart-testnet.ts')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'));
    expect(code.filter((l) => l.trimEnd().endsWith(';')).length).toBeLessThanOrEqual(12);
  });
  it('the README quickstart is the example', () => {
    const example = read('../examples/quickstart-testnet.ts');
    const body = example.slice(example.indexOf('import type')).trim();
    expect(read('../README.md')).toContain(body);
    expect(read('../../../README.md')).toContain(body);
  });
});

describe('the security model matches the contracts as built', () => {
  const model = read('../../../docs/security-model.md');
  it('says where funds and settings live', () => {
    expect(model).toContain('## Where things live');
    expect(model).toContain('AgentPolicyRegistry');
    expect(model).toMatch(/no admin and no owner of its own/);
  });
  it('explains the high-water sell valuation', () =>
    expect(model).toMatch(/high-water average cost/));
  it('names every immutable piece', () =>
    expect(model).toContain('Accounts, the policy registry and factories are immutable'));
  it('states the testnet-only notice, gas figures and the API', () => {
    expect(model).toContain('NotDeployedError');
    expect(model).toContain('Agent Accounts are deployed on Arc testnet');
    expect(model).toContain('withdraw them');
    expect(model).toContain('older than 24 hours');
    expect(model).toContain('60 seconds on testnet');
    expect(model).toContain('353,719');
    expect(model).toContain('16,777,216');
    expect(model).toContain('X-Api-Key');
    expect(model).toContain('agent-account:<addr>');
    expect(model).toMatch(/no origin bypass/i);
  });
  it('maps every SDK method to the contract it calls', () => {
    const readme = read('../README.md');
    for (const row of [
      'registry `setPolicy`',
      'factory `createAccount`',
      'registry `acceptOwnership`',
    ])
      expect(readme).toContain(row);
  });
  it('keeps the handling notes and the testnet notice in the package README', () => {
    const readme = read('../README.md');
    for (const h of [
      '## Handling agent keys',
      '## Untrusted text for models',
      '## Logging and secrets',
      '## Supply chain',
    ])
      expect(readme).toContain(h);
    expect(readme).toContain('Agent Accounts are deployed on Arc testnet');
    expect(readme).toContain('stay empty until an owner-approved deployment');
    expect(readme).toContain('older than 24 hours');
    expect(readme).toContain('withdraw them');
    expect(readme).toContain('exportPrivateKey()');
    expect(readme).toContain('Never put it in a markdown code fence');
    expect(readme).toContain('pool_trade');
  });
});

describe('no stale "not deployed yet" claims now that testnet is recorded', () => {
  const files = [
    '../../../README.md',
    '../README.md',
    '../../../docs/security-model.md',
    '../../../docs/releasing.md',
    '../../python/README.md',
    '../examples/quickstart-testnet.ts',
    '../examples/market-maker.ts',
    '../examples/launch-bot.ts',
    '../examples/llm-tools.ts',
    '../../python/examples/quickstart_testnet.py',
    '../../python/examples/market_maker.py',
    '../../python/examples/launch_bot.py',
    '../../python/examples/llm_tools.py',
  ];
  it.each(files)('%s', (p) =>
    expect(read(p)).not.toMatch(
      /No Agent Accounts deployment exists|deployment is recorded\)|runs once a testnet deployment|until one is recorded|## No deployment yet/,
    ),
  );
});

describe('the ERC-8004 and Circle notes say who signs', () => {
  it.each(['../../../README.md', '../README.md', '../../python/README.md'])('%s', (p) => {
    const text = read(p);
    for (const h of ['## ERC-8004 identity (optional)', '## Circle Wallets'])
      expect(text).toContain(h);
    expect(text).toContain('`isValidSignature` always fails');
    expect(text).toContain('no exportable');
    expect(text).toMatch(/No adapter is provided|provides no Circle adapter/);
  });
});
