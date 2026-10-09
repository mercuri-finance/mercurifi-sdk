import { bytesToHex, encodeFunctionData, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem';

import type { BuiltTx } from './api/types.js';
import { BuildMismatchError } from './errors.js';
import { snapshotExpectation, verifyBuiltTx, type BuildExpectation } from './api/verifyBuild.js';
import type { ImageUpload } from './api/types.js';
import { agentAccountAbi, bondingCurveAbi, launchFactoryAbi, launchTokenAbi } from './abi/index.js';
import { curveSellValue6, poolSellValue6, readBasis, recordedSellValue6 } from './basis.js';
import type { MercurifiClient } from './client.js';
import { buyImpactBps, mayGraduateBuy, PHASE, quoteFreshBuy, sellImpactBps, type LaunchConfigValue } from './curve.js';
import { InvalidInputError, MercurifiError } from './errors.js';
import { fillFromReceipt, type Fill } from './fills.js';
import type { AgentBook } from './networks.js';
import { estimatePoolImpactBps, quoteExactIn, readPoolKey, UINT128_MAX } from './pool.js';
import { PERMISSIONS, type Permission } from './permissions.js';
import type { ChainPolicy } from './policy.js';
import { latestTimestamp, readAgent, readPaused, readPolicy, readRegistry, type AgentInfo } from './reads.js';
import { localRevert } from './revert.js';
import type { Signer } from './signers.js';
import { chainDeadline } from './time.js';
import {
  applySlippageFloor, formatUsdc6, resolveTokenAmount, resolveUsdc6, SCALE, slippageToBps, usdc6ToWei, weiToUsdc6Ceil, weiToUsdc6Floor,
} from './units.js';

export interface BuyParams { token: Address; usdc?: string; usdc6?: bigint; slippage?: number; minTokensOut?: bigint }
export interface SellParams { token: Address; amount?: string; amountWei?: bigint; slippage?: number; minUsdcOut6?: bigint }
export interface LaunchParams {
  name: string;
  symbol: string;
  description?: string;
  links?: Record<string, string>;
  image?: ImageUpload;
  /** An already-stored metadata URI (chain-only launches); cannot be combined with description, links or image. */
  metadataURI?: string;
  initialBuyUsdc?: string;
  initialBuyUsdc6?: bigint;
  salt?: Hex;
}
export interface SwapParams { token: Address; side: 'buy' | 'sell'; usdc?: string; usdc6?: bigint; amount?: string; amountWei?: bigint; slippage?: number }
export interface SweepParams { token?: Address; usdc?: string; usdc6?: bigint; all?: boolean; amount?: string; amountWei?: bigint }

const utf8Length = (v: string): number => new TextEncoder().encode(v).length;

/** Why a metadata URI cannot be used, or null: https:// or ipfs://, no whitespace, control or format characters, at most 256 bytes. The value is never echoed. */
export const metadataUriProblem = (uri: unknown): string | null => {
  if (typeof uri !== 'string' || uri === '') return 'it is empty or not a string';
  if (!/^(https|ipfs):\/\/./.test(uri)) return 'it must start with https:// or ipfs://';
  if (/[\s\p{Cc}\p{Cf}]/u.test(uri)) return 'it contains whitespace or control characters';
  // Credentials in a URI would be published on chain and sent to every reader's browser.
  if (/^(?:https|ipfs):\/\/[^/?#]*@/.test(uri)) return 'it contains embedded credentials';
  if (utf8Length(uri) > 256) return 'it is longer than 256 bytes';
  return null;
};

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

const BUILT_PERMISSION: Partial<Record<string, Permission>> = { buy: 'buy', sell: 'sell', launch: 'launch', swapExactIn: 'swap', claimFees: 'claim', sweepToOwner: 'sweep' };
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
    // One block for all four reads, so the numbers describe the same moment.
    const at = (await client.getBlock({ blockTag: 'latest' })).number;
    const [room, usage, policy, periodSeconds] = await Promise.all([
      readRegistry<readonly [bigint, bigint, number, number]>(client, registry, 'headroom', [this.account], at),
      readRegistry<readonly [bigint, bigint, bigint, number, number]>(client, registry, 'usage', [this.account], at),
      this.policy(at),
      readRegistry<number>(client, registry, 'periodSeconds', [this.account], at),
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
    const client = this.mf.publicClient;
    // Everything below reads one block, in the account's order: pause and agent checks first, then the token.
    const { at, block, policy, room } = await this.gate('buy');
    const curve = await this.curveOf(p.token, at);
    const [tokenSpent, phase, launchBlock, snipe] = await Promise.all([
      readRegistry<bigint>(client, this.agents.registry, 'tokenSpent', [this.account, p.token], at),
      this.curveRead<number>(curve, 'phase', undefined, at),
      this.curveRead<bigint>(curve, 'launchBlock', undefined, at),
      this.curveRead<bigint>(curve, 'currentSnipeBps', undefined, at),
    ]);
    if (Number(phase) !== PHASE.Trading) throw localRevert('NotTrading');
    if (policy.allowlistOnly) {
      const allowed = await readRegistry<boolean>(client, this.agents.registry, 'tokenAllowed', [this.account, p.token], at);
      if (!allowed) throw localRevert('TokenNotAllowed');
    }
    // The transaction lands in a later block than `latest`, so its age is at least one block more.
    if (block.number + 1n - BigInt(launchBlock) < BigInt(policy.minTokenAgeBlocks)) throw localRevert('TokenTooNew');
    if (BigInt(snipe) > BigInt(policy.maxSnipeBps)) throw localRevert('SnipeTaxTooHigh', [BigInt(snipe)]);
    if (usdc6 > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    if (usdc6 > MAX_UINT256 / SCALE) throw localRevert('AmountTooLarge');
    const valueWei = usdc6ToWei(usdc6);
    const [sold, curveSupply, price, quote] = await Promise.all([
      this.curveRead<bigint>(curve, 'sold', undefined, at),
      this.curveRead<bigint>(curve, 'curveSupply', undefined, at),
      this.curveRead<bigint>(curve, 'price', undefined, at),
      this.curveRead<readonly [bigint, bigint, bigint, bigint]>(curve, 'quoteBuy', [valueWei], at),
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
    const mayGraduate = mayGraduateBuy({ usdcIn: valueWei, usdcUsed, tokensOut, tokensRemaining: curveSupply - sold });
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
    const client = this.mf.publicClient;
    const { at, policy, room } = await this.gate('sell');
    const curve = await this.curveOf(p.token, at);
    const balance = await this.balanceOf(p.token, at);
    const tokensIn = amount === 'all' ? balance : amount;
    if (tokensIn === 0n) throw new InvalidInputError('amount', amount === 'all' ? 'The account holds none of this token.' : 'The sell amount must be above zero.');
    if (tokensIn > balance) throw new InvalidInputError('amount', 'The account holds less of this token than the amount to sell.');
    const [phase, price, quote, basis] = await Promise.all([
      this.curveRead<number>(curve, 'phase', undefined, at),
      this.curveRead<bigint>(curve, 'price', undefined, at),
      this.curveRead<readonly [bigint, bigint]>(curve, 'quoteSell', [tokensIn], at),
      readBasis(client, this.account, p.token, at),
    ]);
    if (Number(phase) === PHASE.Graduated) throw localRevert('NotTrading');
    if (p.minUsdcOut6 !== undefined && p.minUsdcOut6 > MAX_UINT256 / SCALE) throw localRevert('AmountTooLarge');
    const { recorded } = recordedSellValue6(basis, tokensIn);
    const excessOutWei = tokensIn > recorded ? (await this.curveRead<readonly [bigint, bigint]>(curve, 'quoteSell', [tokensIn - recorded], at))[0] : 0n;
    const basisValue = curveSellValue6(basis, tokensIn, excessOutWei);
    if (basisValue > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    const [out, fee] = quote;
    if (out === 0n) throw localRevert('ZeroOutput');
    // The account takes the floor in usdc6; proceeds under one micro-USDC cannot carry a non-zero minimum.
    if (out < SCALE) throw new InvalidInputError('amount', 'The sell proceeds are below 1 micro-USDC; sell a larger amount.');
    const impact = sellImpactBps(out + fee, tokensIn, price);
    if (impact > BigInt(policy.maxPriceImpactBps)) throw localRevert('PriceImpactTooHigh', [impact]);
    if (basisValue > BigInt(room[1])) throw localRevert('PeriodSellExceeded', [BigInt(room[1])]);
    // out >= 1e12 here, so a slippage floor that rounds to zero is raised to the smallest valid minimum.
    const minUsdcOut6 = maxOf(maxOf(weiToUsdc6Floor(applySlippageFloor(out, bps)), 1n), p.minUsdcOut6 ?? 0n);
    const deadline = await chainDeadline(client, policy.maxDeadlineSeconds, this.deadlineSeconds);
    return this.send(this.encode('sell', [p.token, tokensIn, minUsdcOut6, deadline]), false, 'sell');
  }

  /**
   * Launches a token whose creator is the account. Metadata goes through the API unless `metadataURI` is given. The launch
   * checks run in the account's order (pause, agent, trade limit), then the factory's cap on the initial buy, then the
   * period caps; the request carries a chain-time deadline like a trade. The fill reports the new token and curve.
   */
  async launch(p: LaunchParams): Promise<Fill> {
    if (typeof p.name !== 'string' || utf8Length(p.name) < 1 || utf8Length(p.name) > 32) throw new InvalidInputError('name', 'name must be 1–32 bytes (UTF-8)');
    if (typeof p.symbol !== 'string' || utf8Length(p.symbol) < 1 || utf8Length(p.symbol) > 10) throw new InvalidInputError('symbol', 'symbol must be 1–10 bytes (UTF-8)');
    const hasMetadata = p.description !== undefined || p.links !== undefined || p.image !== undefined;
    if (p.metadataURI !== undefined && hasMetadata) throw new InvalidInputError('metadataURI', 'pass either metadataURI or description, links and image, not both');
    if (p.metadataURI === '') {
      this.mf.warn('metadataURI is empty: the launch is valid, but tokens without Mercurifi-hosted metadata are hidden from the Mercurifi board.');
    }
    if (p.metadataURI !== undefined && p.metadataURI !== '') {
      const problem = metadataUriProblem(p.metadataURI);
      if (problem !== null) throw new InvalidInputError('metadataURI', `metadataURI is not usable: ${problem}`);
    }
    if (p.metadataURI === undefined && hasMetadata && this.mf.api === null) {
      throw new InvalidInputError('metadataURI', 'Uploading a description, links or an image needs the Mercurifi API; pass metadataURI to launch chain-only.');
    }
    const firstBuy6 = p.initialBuyUsdc === undefined && p.initialBuyUsdc6 === undefined ? 0n : resolveUsdc6({ usdc: p.initialBuyUsdc, usdc6: p.initialBuyUsdc6 }, 'initialBuyUsdc');
    const client = this.mf.publicClient;
    const factory = this.mf.network.launch.factory;
    const { at, policy, room } = await this.gate('launch');
    const pin = { blockNumber: at };
    const [raw, configHash, launchPaused] = await Promise.all([
      client.readContract({ address: factory, abi: launchFactoryAbi, functionName: 'config', ...pin } as never) as Promise<LaunchConfigValue>,
      client.readContract({ address: factory, abi: launchFactoryAbi, functionName: 'configHash', ...pin } as never) as Promise<Hex>,
      client.readContract({ address: factory, abi: launchFactoryAbi, functionName: 'paused', ...pin } as never) as Promise<boolean>,
    ]);
    const config: LaunchConfigValue = {
      ...raw, tradeFeeBps: Number(raw.tradeFeeBps), creatorShareBps: Number(raw.creatorShareBps), referrerShareBps: Number(raw.referrerShareBps),
      snipeStartBps: Number(raw.snipeStartBps), snipeBlocks: Number(raw.snipeBlocks),
    };
    // The account's own test: the initial buy and the launch fee (usdc6, rounded up) must both fit in maxTradeUsdc.
    const feeUsdc6 = weiToUsdc6Ceil(config.launchFee);
    if (firstBuy6 > policy.maxTradeUsdc || feeUsdc6 > policy.maxTradeUsdc - firstBuy6) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    if (firstBuy6 > MAX_UINT256 / SCALE) throw localRevert('AmountTooLarge');
    const firstBuyWei = usdc6ToWei(firstBuy6);
    if (launchPaused) throw localRevert('EnforcedPause');
    // The initial buy runs tax-exempt in the launch block, before any other trade, so this quote is exact.
    const quote = firstBuy6 === 0n ? null : quoteFreshBuy(config, firstBuyWei);
    if (quote !== null && quote.tokensOut === 0n) throw localRevert('ZeroOutput');
    if (quote !== null && quote.tokensOut > config.maxInitialBuyTokens) throw localRevert('InitialBuyTooLarge');
    // What the account records: the fee plus what the initial buy really uses (a surplus is refunded), rounded up.
    const spend6 = weiToUsdc6Ceil(config.launchFee + (quote?.usdcUsed ?? 0n));
    if (spend6 > BigInt(room[0])) throw localRevert('PeriodSpendExceeded', [BigInt(room[0])]);
    if (spend6 > policy.perTokenPeriodCap) throw localRevert('TokenCapExceeded', [policy.perTokenPeriodCap]);
    if (Number(room[3]) === 0) throw localRevert('LaunchLimit');

    let metadataURI = p.metadataURI ?? '';
    if (p.metadataURI === undefined && hasMetadata) {
      const meta = { ...(p.description !== undefined ? { description: p.description } : {}), ...(p.links !== undefined ? { links: p.links } : {}) };
      metadataURI = (await this.mf.api!.uploadLaunchMetadata(meta, p.image)).metadataURI;
      const problem = metadataUriProblem(metadataURI);
      if (problem !== null) throw new MercurifiError('API_BAD_RESPONSE', `The API returned a metadata URI that cannot be used (${problem}); nothing was signed.`);
    }
    // After the upload, so a slow upload cannot use up the deadline window.
    const deadline = await chainDeadline(client, policy.maxDeadlineSeconds, this.deadlineSeconds);
    const request = {
      name: p.name, symbol: p.symbol, metadataURI, salt: p.salt ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
      expectedConfigHash: configHash, initialBuyUsdc: firstBuy6, minTokensOut: quote?.tokensOut ?? 0n, deadline,
    };
    return this.send(this.encode('launch', [request]), false, 'launch');
  }

  /**
   * Exact-in swap on a graduated Launch pool. `side: 'buy'` spends usdc6 (the pool's 6-decimal USDC view); `side: 'sell'`
   * spends tokens ('all' allowed) for a usdc6 minimum. The pool is derived, never supplied. Buys above maxTradeUsdc and
   * sells valued above it (recorded part at the higher of average and high-water cost, the rest at its share of the quoted
   * proceeds) are refused locally. A quoted price impact above the policy only warns: the account measures the real one.
   */
  async swapExactIn(p: SwapParams): Promise<Fill> {
    if (p.side !== 'buy' && p.side !== 'sell') throw new InvalidInputError('side', "side must be 'buy' or 'sell'");
    const buyToken = p.side === 'buy';
    if (buyToken && (p.amount !== undefined || p.amountWei !== undefined)) throw new InvalidInputError('amount', 'a pool buy spends USDC: pass usdc or usdc6');
    if (!buyToken && (p.usdc !== undefined || p.usdc6 !== undefined)) throw new InvalidInputError('usdc', 'a pool sell spends tokens: pass amount or amountWei');
    const bps = this.bps(p.slippage);
    const wanted = buyToken ? resolveUsdc6(p) : resolveTokenAmount(p);
    const client = this.mf.publicClient;
    const book = this.mf.network;
    const { at, policy, room } = await this.gate('swap');
    const curve = await this.curveOf(p.token, at);
    if (Number(await this.curveRead<number>(curve, 'phase', undefined, at)) !== PHASE.Graduated) throw localRevert('NotGraduated');
    const balance = buyToken ? 0n : await this.balanceOf(p.token, at);
    const amountIn = wanted === 'all' ? balance : wanted;
    if (amountIn === 0n) throw new InvalidInputError(buyToken ? 'usdc' : 'amount', wanted === 'all' ? 'The account holds none of this token.' : 'The swap amount must be above zero.');
    if (amountIn > UINT128_MAX) throw localRevert('AmountTooLarge');
    const key = await readPoolKey(client, book, p.token, at);

    let basis = null as Awaited<ReturnType<typeof readBasis>> | null;
    if (buyToken) {
      if (policy.allowlistOnly && !(await readRegistry<boolean>(client, this.agents.registry, 'tokenAllowed', [this.account, p.token], at))) {
        throw localRevert('TokenNotAllowed');
      }
      if (amountIn > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    } else {
      if (amountIn > balance) throw new InvalidInputError('amount', 'The account holds less of this token than the amount to sell.');
      basis = await readBasis(client, this.account, p.token, at);
      // Before the swap the account values only the recorded part; the excess is added once the proceeds are known.
      if (recordedSellValue6(basis, amountIn).value6 > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
    }

    const zeroForOne = isAddressEqual(buyToken ? book.launch.usdc : p.token, key.currency0);
    const out = await quoteExactIn(client, book, key, zeroForOne, amountIn, this.account, at);
    if (out === 0n) {
      if (buyToken) throw localRevert('ZeroOutput');
      throw new InvalidInputError('amount', 'The sell proceeds are below 1 micro-USDC; sell a larger amount.');
    }
    if (buyToken) {
      // An exact-in buy spends the whole amount.
      if (amountIn > BigInt(room[0])) throw localRevert('PeriodSpendExceeded', [BigInt(room[0])]);
      const spent = await readRegistry<bigint>(client, this.agents.registry, 'tokenSpent', [this.account, p.token], at);
      const tokenLeft = policy.perTokenPeriodCap > BigInt(spent) ? policy.perTokenPeriodCap - BigInt(spent) : 0n;
      if (amountIn > tokenLeft) throw localRevert('TokenCapExceeded', [tokenLeft]);
    } else {
      const value = poolSellValue6(basis!, amountIn, out * SCALE);
      if (value > policy.maxTradeUsdc) throw localRevert('TradeTooLarge', [policy.maxTradeUsdc]);
      if (value > BigInt(room[1])) throw localRevert('PeriodSellExceeded', [BigInt(room[1])]);
    }
    const impact = await estimatePoolImpactBps(client, book, key, zeroForOne, amountIn, out, this.account, at);
    if (impact !== null && impact > BigInt(policy.maxPriceImpactBps)) {
      this.mf.warn(`This swap may move the pool price by about ${impact} bps (approximate), above the account limit of ${policy.maxPriceImpactBps} bps. The account's own check enforces the real limit and refuses the swap if it is exceeded; try a smaller amount.`);
    }
    // Slippage floor on the quote; never zero. (A sell's output is usdc6, a buy's is token wei.)
    const minAmountOut = maxOf(applySlippageFloor(out, bps), 1n);
    const deadline = await chainDeadline(client, policy.maxDeadlineSeconds, this.deadlineSeconds);
    return this.send(this.encode('swapExactIn', [p.token, buyToken, amountIn, minAmountOut, deadline]), false, buyToken ? 'poolBuy' : 'poolSell');
  }

  /** Claims the account's creator and referral fees into the account itself. No deadline. */
  async claimFees(): Promise<Fill> {
    await this.gate('claim');
    return this.send(this.encode('claimFees', []), false, 'claim');
  }

  /**
   * Moves native USDC (wei; `usdc`/`usdc6`, or everything with `all`) or a registered Launch token (`amount`/`amountWei`,
   * or everything with `all` or amount 'all') to the owner. No deadline.
   */
  async sweepToOwner(p: SweepParams): Promise<Fill> {
    const native = p.token === undefined || isAddressEqual(p.token, zeroAddress);
    const given = [p.usdc, p.usdc6, p.amount, p.amountWei].filter((v) => v !== undefined).length;
    if (p.all === true && given > 0) throw new InvalidInputError('all', 'all cannot be combined with an amount');
    if (native && (p.amount !== undefined || p.amountWei !== undefined) && p.amount !== 'all') {
      throw new InvalidInputError('amount', 'a native sweep is in USDC: pass usdc or usdc6 (or all)');
    }
    if (!native && (p.usdc !== undefined || p.usdc6 !== undefined)) throw new InvalidInputError('usdc', 'a token sweep is in token units: pass amount or amountWei (or all)');
    const { at } = await this.gate('sweep');
    let token: Address = zeroAddress;
    let amount: bigint;
    if (native) {
      const everything = p.all === true || p.amount === 'all';
      const balance = await this.mf.publicClient.getBalance({ address: this.account, blockNumber: at });
      amount = everything ? balance : usdc6ToWei(resolveUsdc6(p));
      if (amount > balance) throw new InvalidInputError('usdc', `The account holds ${formatUsdc6(balance / SCALE)} USDC, less than the amount to sweep.`);
    } else {
      token = p.token!;
      await this.curveOf(token, at); // TokenNotRegistered: only Launch tokens can be swept
      const wanted = p.all === true ? 'all' : resolveTokenAmount(p);
      const balance = await this.balanceOf(token, at);
      amount = wanted === 'all' ? balance : wanted;
      if (amount > balance) throw new InvalidInputError('amount', 'The account holds less of this token than the amount to sweep.');
    }
    if (amount === 0n) throw new InvalidInputError('amount', 'Nothing to sweep.');
    return this.send(this.encode('sweepToOwner', [token, amount]), false, 'sweep');
  }

  /**
   * The registry's authorize() preamble against one pinned block: Paused first (the account owner's pause or the platform
   * pause), then the agent, then the policy and headroom. Every later read of the same action uses `at`.
   */
  protected async gate(permission: Permission): Promise<{ at: bigint; block: { number: bigint; timestamp: bigint }; policy: ChainPolicy; room: readonly [bigint, bigint, number, number] }> {
    const client = this.mf.publicClient;
    const block = await client.getBlock({ blockTag: 'latest' });
    const at = block.number;
    const [paused, agent, policy, room] = await Promise.all([
      readPaused(client, this.agents, this.account, at),
      readAgent(client, this.agents, this.account, this.signer.address, block.timestamp, at),
      this.policy(at),
      readRegistry<readonly [bigint, bigint, number, number]>(client, this.agents.registry, 'headroom', [this.account], at),
    ]);
    if (paused) throw localRevert('Paused');
    this.checkAgent(agent, permission, room, block.timestamp);
    return { at, block, policy, room };
  }

  /** The registry's authorize() preamble: active, unexpired, permitted, and an action left in the period. */
  protected checkAgent(agent: AgentInfo, permission: Permission, room: readonly [bigint, bigint, number, number], now: bigint): void {
    if (!agent.active) throw localRevert('NotAgent');
    // The transaction lands at least one block-time after `latest`, so a key expiring that soon cannot succeed.
    if (now + 1n >= BigInt(agent.expiresAt)) throw localRevert('AgentExpired');
    if ((agent.permissionBits & PERMISSIONS[permission]) === 0) throw localRevert('MissingPermission');
    if (Number(room[2]) === 0) throw localRevert('ActionLimit');
  }

  protected encode(functionName: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: agentAccountAbi, functionName, args } as never);
  }

  /**
   * Verifies API-built calldata against your expectation, then signs and sends it. Refuses on any mismatch.
   *
   * Build the expectation from your own request, never from the build response (that would compare the answer with itself).
   * It must cover every argument (see verifyBuiltTx): buy, sell and swapExactIn need every token, amount and
   * flag in `exact`, the `min…Out` in `atLeast` (or `exact`); sweepToOwner needs `token` and `amount`; claimFees nothing. A launch needs
   * all eight request fields; its `expectedConfigHash` must be the factory's current `configHash()`, which is read here
   * (omit it), and its deadline is checked against a window computed here from the latest block and the policy.
   * Your own `deadline` window is intersected with that window, never widened. The local permission, pause and cap
   * checks run first, and a buy always gets the graduation gas floor.
   */
  async sendBuilt(built: BuiltTx, expectation: Omit<BuildExpectation, 'chainId' | 'account'>): Promise<Fill> {
    const e = { functionName: expectation.functionName, ...snapshotExpectation(expectation) };
    const permission = Object.hasOwn(BUILT_PERMISSION, e.functionName) ? BUILT_PERMISSION[e.functionName] : undefined;
    if (permission === undefined) throw new InvalidInputError('functionName', `${String(e.functionName)} is not an agent trade function`);
    const { at, block, policy } = await this.gate(permission);
    const ownSeconds = Math.min(this.deadlineSeconds, policy.maxDeadlineSeconds);
    if (!Number.isInteger(ownSeconds) || ownSeconds < 1) throw new InvalidInputError('deadlineSeconds', 'the deadline window must be at least 1 second (check deadlineSeconds and the policy maxDeadlineSeconds)');
    const own = BigInt(ownSeconds);
    const window = { min: e.deadline?.min !== undefined && e.deadline.min > block.timestamp ? e.deadline.min : block.timestamp, max: block.timestamp + own };
    if (e.deadline !== undefined && e.deadline.max < window.max) window.max = e.deadline.max;
    let exact = e.exact;
    if (e.functionName === 'launch') {
      const configHash = (await this.mf.publicClient.readContract({
        address: this.mf.network.launch.factory, abi: launchFactoryAbi, functionName: 'configHash', blockNumber: at,
      } as never)) as Hex;
      if (exact?.expectedConfigHash !== undefined && String(exact.expectedConfigHash).toLowerCase() !== configHash.toLowerCase()) {
        throw new BuildMismatchError('expectedConfigHash is not the factory\'s current configHash');
      }
      exact = { ...exact, expectedConfigHash: configHash };
    }
    verifyBuiltTx(built, {
      ...e, ...(exact === undefined ? {} : { exact }), chainId: this.mf.network.chainId, account: this.account,
      ...(e.functionName === 'claimFees' || e.functionName === 'sweepToOwner' ? {} : { deadline: window }),
    });
    // A decoded buy cannot be proven to stay off the graduation path, so it always gets the graduation gas floor.
    return this.send(built.data, e.functionName === 'buy', e.functionName);
  }

  protected async send(data: Hex, mayGraduate: boolean, label: string): Promise<Fill> {
    const sent = await this.mf.sender.send(this.signer, { to: this.account, data, mayGraduate, label });
    return fillFromReceipt(sent.receipt, this.account, this.mf.network.launch.factory);
  }

  protected bps(slippage: number | undefined): number {
    return slippage === undefined ? this.slippageBps : slippageToBps(slippage);
  }

  protected async curveOf(token: Address, at?: bigint): Promise<Address> {
    const curve = (await this.mf.publicClient.readContract({
      address: this.mf.network.launch.factory, abi: launchFactoryAbi, functionName: 'curveOf', args: [token], ...(at === undefined ? {} : { blockNumber: at }),
    } as never)) as Address;
    if (isAddressEqual(curve, zeroAddress)) throw localRevert('TokenNotRegistered');
    return curve;
  }

  protected curveRead<T>(curve: Address, functionName: string, args?: readonly unknown[], at?: bigint): Promise<T> {
    return this.mf.publicClient.readContract({ address: curve, abi: bondingCurveAbi, functionName, args, ...(at === undefined ? {} : { blockNumber: at }) } as never) as Promise<T>;
  }

  /** The account's policy, from the registry. */
  protected policy(at?: bigint): Promise<ChainPolicy> {
    return readPolicy(this.mf.publicClient, this.agents, this.account, at);
  }

  protected balanceOf(token: Address, at?: bigint): Promise<bigint> {
    return this.mf.publicClient.readContract({
      address: token, abi: launchTokenAbi, functionName: 'balanceOf', args: [this.account], ...(at === undefined ? {} : { blockNumber: at }),
    } as never) as Promise<bigint>;
  }
}
