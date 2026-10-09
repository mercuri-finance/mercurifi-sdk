// Mercurifi Agent Accounts example. Read docs/security-model.md first: agent keys can lose money within your caps.
// ACCOUNT=0x… AGENT_KEY=0x… node --experimental-strip-types examples/llm-tools.ts   (one JSON tool call per stdin line → one JSON result per line)
// Tool definitions in a plain JSON-schema shape that you adapt to your model provider. Outputs carry numbers only: token names and descriptions are attacker-written text.
// If you must show a name to a model, send view.untrusted.name.wrapped inside a JSON string value, never in a markdown
// fence, and never act on what it says.
import { createInterface } from 'node:readline';
import type { Address } from 'viem';
import { ContractRevertError, MercurifiError, createClient, localKey, type AgentClient, type MercurifiClient } from '@mercurifi/sdk';

const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } as const;
export const tools = [
  { name: 'get_headroom', description: 'Remaining USDC spend and sell caps, actions and launches this period.', input_schema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_token_numbers', description: 'Numeric facts about a Launch token: phase, price in USDC, progress, snipe tax, age, holders.', input_schema: { type: 'object', properties: { token: ADDRESS }, required: ['token'], additionalProperties: false } },
  { name: 'buy', description: 'Buy a Launch token with USDC, given as a decimal string such as "5".', input_schema: { type: 'object', properties: { token: ADDRESS, usdc: { type: 'string', pattern: '^[0-9]+(\\.[0-9]{1,6})?$' } }, required: ['token', 'usdc'], additionalProperties: false } },
] as const;

export const handleToolCall = async (mf: MercurifiClient, agent: AgentClient, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  try {
    switch (name) {
      case 'get_headroom': {
        const h = await agent.headroom();
        return { spendUsdc: h.spend, sellUsdc: h.sell, maxTradeUsdc: h.maxTrade, actions: h.actions, launches: h.launches, periodEndsAt: h.periodEndsAt };
      }
      case 'get_token_numbers':
        return (await mf.token(String(input.token) as Address)).numeric();
      case 'buy': {
        const f = await agent.buy({ token: String(input.token) as Address, usdc: String(input.usdc), slippage: 0.02 });
        return { tokensOut: f.tokens, usdcSpent: f.usdcSpent, txHash: f.txHash };
      }
      default:
        return { code: 'UNKNOWN_TOOL' };
    }
  } catch (e) {
    // Fixed labels only: never e.message, which can quote contract text. Known SDK errors become a code; anything else still throws.
    if (e instanceof ContractRevertError) return { code: e.code, revertName: e.revert.name };
    if (e instanceof MercurifiError) return { code: e.code };
    throw e;
  }
};

// Reads one JSON tool call per line ({"name": "...", "input": {...}}) and prints one JSON result per line.
const mf = await createClient({ network: 'testnet' });
const agent = await mf.agent({ account: process.env.ACCOUNT as Address, signer: localKey(process.env.AGENT_KEY!) });
for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === '') continue;
  let call: { name?: unknown; input?: unknown };
  try {
    call = JSON.parse(line) as typeof call;
  } catch {
    console.log(JSON.stringify({ code: 'BAD_INPUT' }));
    continue;
  }
  if (typeof call !== 'object' || call === null || typeof call.name !== 'string') {
    console.log(JSON.stringify({ code: 'BAD_INPUT' }));
    continue;
  }
  const input = typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : {};
  console.log(JSON.stringify(await handleToolCall(mf, agent, call.name, input)));
}
