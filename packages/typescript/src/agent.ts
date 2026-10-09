import { encodeFunctionData, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';

import { agentAccountAbi, bondingCurveAbi, launchFactoryAbi, launchTokenAbi } from './abi/index.js';
import { curveSellValue6, readBasis, recordedSellValue6 } from './basis.js';
import type { MercurifiClient } from './client.js';
import { buyImpactBps, isSellOutQuote, PHASE, sellImpactBps } from './curve.js';
import { InvalidInputError } from './errors.js';
import { fillFromReceipt, type Fill } from './fills.js';
import type { AgentBook } from './networks.js';
import { PERMISSIONS, type Permission } from './permissions.js';
import type { ChainPolicy } from './policy.js';
import { latestTimestamp, readAgent, readPolicy, readRegistry, type AgentInfo } from './reads.js';
import { localRevert } from './revert.js';
import type { Signer } from './signers.js';
import { chainDeadline } from './time.js';
import {
  applySlippageFloor, formatUsdc6, resolveTokenAmount, resolveUsdc6, SCALE, slippageToBps, usdc6ToWei, weiToUsdc6Ceil, weiToUsdc6Floor,
} from './units.js';

export interface BuyParams { token: Address; usdc?: string; usdc6?: bigint; slippage?: number; minTokensOut?: bigint }
export interface SellParams { token: Address; amount?: string; amountWei?: bigint; slippage?: number; minUsdcOut6?: bigint }
export interface Headroom {
  spendUsdc6: bigint;
  sellUsdc6: bigint;
  actions: number;
  launches: number;
  maxTradeUsdc6: bigint;
  spend: string;
  sell: string;
  maxTrade: string;
  periodId: bigint;
  /** Unix seconds when the current fixed period ends and the caps reset. */
  periodEndsAt: number;
}
export interface Position {
  balanceWei: bigint;
  /** Recorded cost of `basisTokens`, usdc6. */
  costUsdc6: bigint;
  basisTokens: bigint;
  /** High-water average cost, usdc6 per token unit × 1e36; sells are valued at no less than this. */
  highWater: bigint;
  spentThisPeriod6: bigint;
}

const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const MAX_UINT256 = (1n << 256n) - 1n;

/** Agent-side client: typed calls to the account, each previewed, preflighted, signed locally and returned as a final fill. */
export class AgentClient {
  constructor(
    protected readonly mf: MercurifiClient,
    protected readonly agents: AgentBook,
    readonly account: Address,
    readonly signer: Signer,
    protected readonly slippageBps: number,
    protected readonly deadlineSeconds: number,
  ) {}

  async status(): Promise<AgentInfo> {
    return readAgent(this.mf.publicClient, this.agents, this.account, this.signer.address, await latestTimestamp(this.mf.publicClient));
  }

  /** Period limits left, read from the policy registry (authoritative; no API needed). */
  async headroom(): Promise<Headroom> {
    const client = this.mf.publicClient;
    const registry = this.agents.registry;
    const [room, usage, policy, periodSeconds] = await Promise.all([
      readRegistry<readonly [bigint, bigint, number, number]>(client, registry, 'headroom', [this.account]),
      readRegistry<readonly [bigint, bigint, bigint, number, number]>(client, registry, 'usage', [this.account]),
      this.policy(),
      readRegistry<number>(client, registry, 'periodSeconds', [this.account]),
    ]);
    const [spend, sell, actions, launches] = room;
    const periodId = BigInt(usage[0]);
    return {
      spendUsdc6: BigInt(spend), sellUsdc6: BigInt(sell), actions: Number(actions), launches: Number(launches), maxTradeUsdc6: policy.maxTradeUsdc,
      spend: formatUsdc6(BigInt(spend)), sell: formatUsdc6(BigInt(sell)), maxTrade: formatUsdc6(policy.maxTradeUsdc),
      periodId, periodEndsAt: Number((periodId + 1n) * BigInt(periodSeconds)),
    };
  }

  async position(token: Address): Promise<Position> {
    const client = this.mf.publicClient;
    const [balanceWei, basis, spent] = await Promise.all([
      this.balanceOf(token),
      readBasis(client, this.account, token),
      readRegistry<bigint>(client, this.agents.registry, 'tokenSpent', [this.account, token]),
    ]);
    return { balanceWei, costUsdc6: basis.costUsdc6, basisTokens: basis.tokens, highWater: basis.highWater, spentThisPeriod6: BigInt(spent) };
  }

  /**
   * Buys on the curve. Every check the account makes is repeated here first, in the account's order and with its error
   * names, so a doomed buy is refused before anything is signed. Returns the measured fill, never the quote.
   */
  async buy(p: BuyParams): Promise<Fill> {
    const usdc6 = resolveUsdc6(p);
    if (usdc6 === 0n) throw new InvalidInputError('usdc', 'The buy amount must be above zero.');
    const bps = this.bps(p.slippage);
    const curve = await this.curveOf(p.token);
    const client = this.mf.publicClient;
    const [policy, agent, room, tokenSpent, block, phase, launchBlock, snipe] = await Promise.all([
      this.policy(),
      this.status(),
      readRegistry<readonly [bigint, bigint, number, number]>(client, this.agents.registry, 'headroom', [this.account]),
      readRegistry<bigint>(client, this.agents.registry, 'tokenSpent', [this.account, p.token]),
      client.getBlock({ blockTag: 'latest' }),
      this.curveRead<number>(curve, 'phase'),
      this.curveRead<bigint>(curve, 'launchBlock'),
      this.curveRead<bigint>(curve, 'currentSnipeBps'),
    ]);
    this.checkAgent(agent, 'buy', room, block.timestamp);
    if (Number(phase) !== PHASE.Trading) throw localRevert('NotTrading');
    if (policy.allowlistOnly) {
      const allowed = await readRegistry<boolean>(client, this.agents.registry, 'tokenAllowed', [this.account, p.token]);
      if (!allowed) throw localRevert('TokenNotAllowed');
    }
    if (block.number - BigInt(launchBlock) < BigInt(policy.minTokenAgeBlocks)) throw localRevert('TokenTooNew');
    if (BigInt(snipe) > BigInt(policy.maxSnipeBps)) throw localRevert('SnipeTaxTooHigh', [BigInt(snipe)]);
    if (usdc6 > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    if (usdc6 > MAX_UINT256 / SCALE) throw localRevert('AmountTooLarge');
    const valueWei = usdc6ToWei(usdc6);
    const [sold, curveSupply, price, quote] = await Promise.all([
      this.curveRead<bigint>(curve, 'sold'),
      this.curveRead<bigint>(curve, 'curveSupply'),
      this.curveRead<bigint>(curve, 'price'),
      this.curveRead<readonly [bigint, bigint, bigint, bigint]>(curve, 'quoteBuy', [valueWei]),
    ]);
    const [tokensOut, usdcUsed, fee, tax] = quote;
    if (tokensOut === 0n) throw localRevert('ZeroOutput');
    const impact = buyImpactBps(usdcUsed - fee - tax, tokensOut, price);
    if (impact > BigInt(policy.maxPriceImpactBps)) throw localRevert('PriceImpactTooHigh', [impact]);
    // The account records what it actually spends (a final buy refunds the surplus), rounded up to usdc6.
    const spend6 = weiToUsdc6Ceil(usdcUsed);
    if (spend6 > BigInt(room[0])) throw localRevert('PeriodSpendExceeded', [BigInt(room[0])]);
    const tokenLeft = policy.perTokenPeriodCap > BigInt(tokenSpent) ? policy.perTokenPeriodCap - BigInt(tokenSpent) : 0n;
    if (spend6 > tokenLeft) throw localRevert('TokenCapExceeded', [tokenLeft]);
    const minTokensOut = maxOf(maxOf(applySlippageFloor(tokensOut, bps), p.minTokensOut ?? 0n), 1n);
    const mayGraduate = isSellOutQuote({ usdcIn: valueWei, usdcUsed, tokensOut, tokensRemaining: curveSupply - sold });
    const deadline = await chainDeadline(client, policy.maxDeadlineSeconds, this.deadlineSeconds);
    return this.send(this.encode('buy', [p.token, usdc6, minTokensOut, deadline]), mayGraduate, 'buy');
  }

  /**
   * Sells on the curve. The sell is valued like the account values it (recorded part at the higher of the average and
   * high-water cost, excess at its quote) and refused locally when that value is above maxTradeUsdc or above the sell
   * headroom left in the period.
   */
  async sell(p: SellParams): Promise<Fill> {
    const amount = resolveTokenAmount(p);
    const bps = this.bps(p.slippage);
    const curve = await this.curveOf(p.token);
    const client = this.mf.publicClient;
    const balance = await this.balanceOf(p.token);
    const tokensIn = amount === 'all' ? balance : amount;
    if (tokensIn === 0n) throw new InvalidInputError('amount', amount === 'all' ? 'The account holds none of this token.' : 'The sell amount must be above zero.');
    if (tokensIn > balance) throw new InvalidInputError('amount', 'The account holds less of this token than the amount to sell.');
    const [policy, agent, room, block, phase, price, quote, basis] = await Promise.all([
      this.policy(),
      this.status(),
      readRegistry<readonly [bigint, bigint, number, number]>(client, this.agents.registry, 'headroom', [this.account]),
      client.getBlock({ blockTag: 'latest' }),
      this.curveRead<number>(curve, 'phase'),
      this.curveRead<bigint>(curve, 'price'),
      this.curveRead<readonly [bigint, bigint]>(curve, 'quoteSell', [tokensIn]),
      readBasis(client, this.account, p.token),
    ]);
    this.checkAgent(agent, 'sell', room, block.timestamp);
    if (Number(phase) === PHASE.Graduated) throw localRevert('NotTrading');
    if (p.minUsdcOut6 !== undefined && p.minUsdcOut6 > MAX_UINT256 / SCALE) throw localRevert('AmountTooLarge');
    const { recorded } = recordedSellValue6(basis, tokensIn);
    const excessOutWei = tokensIn > recorded ? (await this.curveRead<readonly [bigint, bigint]>(curve, 'quoteSell', [tokensIn - recorded]))[0] : 0n;
    const basisValue = curveSellValue6(basis, tokensIn, excessOutWei);
    if (basisValue > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    const [out, fee] = quote;
    if (out === 0n) throw localRevert('ZeroOutput');
    const impact = sellImpactBps(out + fee, tokensIn, price);
    if (impact > BigInt(policy.maxPriceImpactBps)) throw localRevert('PriceImpactTooHigh', [impact]);
    if (basisValue > BigInt(room[1])) throw localRevert('PeriodSellExceeded', [BigInt(room[1])]);
    const minUsdcOut6 = maxOf(weiToUsdc6Floor(applySlippageFloor(out, bps)), p.minUsdcOut6 ?? 0n);
    if (minUsdcOut6 === 0n) throw localRevert('ZeroMinOut');
    const deadline = await chainDeadline(client, policy.maxDeadlineSeconds, this.deadlineSeconds);
    return this.send(this.encode('sell', [p.token, tokensIn, minUsdcOut6, deadline]), false, 'sell');
  }

  /** The registry's authorize() preamble: active, unexpired, permitted, and an action left in the period. */
  protected checkAgent(agent: AgentInfo, permission: Permission, room: readonly [bigint, bigint, number, number], now: bigint): void {
    if (!agent.active) throw localRevert('NotAgent');
    if (now >= BigInt(agent.expiresAt)) throw localRevert('AgentExpired');
    if ((agent.permissionBits & PERMISSIONS[permission]) === 0) throw localRevert('MissingPermission');
    if (Number(room[2]) === 0) throw localRevert('ActionLimit');
  }

  protected encode(functionName: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: agentAccountAbi, functionName, args } as never);
  }

  protected async send(data: Hex, mayGraduate: boolean, label: string): Promise<Fill> {
    const sent = await this.mf.sender.send(this.signer, { to: this.account, data, mayGraduate, label });
    return fillFromReceipt(sent.receipt, this.account, this.mf.network.launch.factory);
  }

  protected bps(slippage: number | undefined): number {
    return slippage === undefined ? this.slippageBps : slippageToBps(slippage);
  }

  protected async curveOf(token: Address): Promise<Address> {
    const curve = (await this.mf.publicClient.readContract({
      address: this.mf.network.launch.factory, abi: launchFactoryAbi, functionName: 'curveOf', args: [token],
    } as never)) as Address;
    if (isAddressEqual(curve, zeroAddress)) throw localRevert('TokenNotRegistered');
    return curve;
  }

  protected curveRead<T>(curve: Address, functionName: string, args?: readonly unknown[]): Promise<T> {
    return this.mf.publicClient.readContract({ address: curve, abi: bondingCurveAbi, functionName, args } as never) as Promise<T>;
  }

  /** The account's policy, from the registry. */
  protected policy(): Promise<ChainPolicy> {
    return readPolicy(this.mf.publicClient, this.agents, this.account);
  }

  protected balanceOf(token: Address): Promise<bigint> {
    return this.mf.publicClient.readContract({ address: token, abi: launchTokenAbi, functionName: 'balanceOf', args: [this.account] } as never) as Promise<bigint>;
  }
}
