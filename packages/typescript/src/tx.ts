import { hexToNumber, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';

import { MercurifiError, NetworkMismatchError, TxDroppedError } from './errors.js';
import { feesWithFloor, gasLimitFor, GRADUATION_GAS_LIMIT } from './gas.js';
import type { NonceManager } from './nonce.js';
import { redactUrlsIn, rpcError } from './redact.js';
import { ContractRevertError, decodeRevert, extractRevertData, TxRevertedError } from './revert.js';
import type { Signer } from './signers.js';

export interface WriteRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  /** A buy that may complete the curve: preflight and send with at least GRADUATION_GAS_LIMIT. */
  mayGraduate?: boolean;
  label: string;
}

export interface SentTx { hash: Hex; receipt: TransactionReceipt; preflightData: Hex }

export interface SenderDeps {
  client: PublicClient;
  /** The chain ID of the verified address book; carried into every signed transaction. */
  chainId: number;
  nonces: NonceManager;
  receiptTimeoutMs: number;
  pollMs: number;
  maxFeePerGasCap: bigint | undefined;
  /** Ceiling on maxPriorityFeePerGas (wei per gas). */
  maxPriorityFeePerGas: bigint;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PRIORITY = 1_000_000_000n;

/** True when the node answered with a JSON-RPC error (a revert or execution failure), not when the transport failed. */
const isNodeAnswer = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; current !== null && typeof current === 'object' && depth < 16; depth += 1) {
    const c = current as { code?: unknown; name?: unknown };
    // UnknownRpcError (code -1) is viem's wrapper for failures that were not a JSON-RPC answer (socket errors, bad bodies).
    if (typeof c.code === 'number' && c.name !== 'UnknownRpcError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
};

/**
 * build → chain check → preflight → estimate → fees → chain check → sign → send → wait.
 * Everything from the first chain check to the receipt runs inside the per-key lock, so a queued send is
 * preflighted against the state its predecessor left behind. Every non-revert failure leaves as a credential-free
 * `RPC_ERROR` (see `rpcError`); raw viem errors embed the RPC URL, which often carries a key.
 */
export class TxSender {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SenderDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Re-checks that the RPC still serves the verified chain. One uncached `eth_chainId` per call: an RPC that was
   * swapped or repointed after start-up must not receive a signed transaction.
   *
   * @throws {NetworkMismatchError} before anything is signed
   */
  private async assertChain(): Promise<void> {
    const raw = (await this.deps.client.request({ method: 'eth_chainId' })) as Hex;
    const served = hexToNumber(raw);
    if (served !== this.deps.chainId) {
      throw new NetworkMismatchError(`The RPC now serves chain ${served}, but this client was verified for chain ${this.deps.chainId}. Nothing was signed.`);
    }
  }

  /** eth_call from `from`; a revert becomes ContractRevertError('preflight') with a readable message. */
  async preflight(from: Address, req: WriteRequest): Promise<Hex> {
    try {
      return await this.preflightRaw(from, req);
    } catch (error) {
      throw rpcError(error);
    }
  }

  private async preflightRaw(from: Address, req: WriteRequest): Promise<Hex> {
    try {
      const { data } = await this.deps.client.call({
        account: from, to: req.to, data: req.data, value: req.value,
        gas: req.mayGraduate === true ? GRADUATION_GAS_LIMIT : undefined,
      });
      return data ?? '0x';
    } catch (error) {
      const data = extractRevertData(error);
      if (data !== undefined) throw new ContractRevertError(decodeRevert(data), 'preflight');
      throw error;
    }
  }

  async send(signer: Signer, req: WriteRequest): Promise<SentTx> {
    let outcome: { hash: Hex; receipt: TransactionReceipt; preflightData: Hex };
    try {
      outcome = await this.deps.nonces.withNonce(signer.address, (nonce) => this.attempt(signer, req, nonce));
    } catch (error) {
      throw rpcError(error);
    }
    const { hash, receipt, preflightData } = outcome;
    if (receipt.status !== 'success') throw new TxRevertedError(hash, await this.replay(signer.address, req, receipt.blockNumber));
    return { hash, receipt, preflightData };
  }

  private async attempt(signer: Signer, req: WriteRequest, nonce: number) {
    await this.assertChain();
    const preflightData = await this.preflightRaw(signer.address, req);
    const estimate = await this.estimate(signer.address, req);
    const gas = estimate === null ? GRADUATION_GAS_LIMIT : gasLimitFor(estimate, req.mayGraduate === true);
    const [block, quoted] = await Promise.all([
      this.deps.client.getBlock({ blockTag: 'latest' }),
      this.deps.client.estimateMaxPriorityFeePerGas().catch(() => DEFAULT_PRIORITY),
    ]);
    const priority = quoted > this.deps.maxPriorityFeePerGas ? this.deps.maxPriorityFeePerGas : quoted;
    const fees = feesWithFloor(block.baseFeePerGas ?? 0n, priority, this.deps.maxFeePerGasCap);
    await this.assertChain();
    let raw: Hex;
    try {
      raw = await signer.signTransaction({
        type: 'eip1559', chainId: this.deps.chainId, nonce, to: req.to, data: req.data, value: req.value ?? 0n, gas, ...fees,
      });
    } catch (error) {
      if (error instanceof MercurifiError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new MercurifiError('SIGNER_ERROR', `The signer failed: ${redactUrlsIn(reason).split('\n')[0]}`);
    }
    const hash = await this.deps.client.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await this.waitForReceipt(hash);
    if (receipt === null) throw new TxDroppedError(hash, Math.round(this.deps.receiptTimeoutMs / 1000));
    return { hash, receipt, preflightData };
  }

  /** A revert is reported as such; the 1.8M fallback applies only when the node itself failed to estimate, never to transport errors. */
  private async estimate(from: Address, req: WriteRequest): Promise<bigint | null> {
    try {
      return await this.deps.client.estimateGas({ account: from, to: req.to, data: req.data, value: req.value });
    } catch (error) {
      const data = extractRevertData(error);
      if (data !== undefined) throw new ContractRevertError(decodeRevert(data), 'preflight');
      if (req.mayGraduate === true && isNodeAnswer(error)) return null;
      throw error;
    }
  }

  /** Polls for a receipt; null after the budget, measured in wall time (Arc can drop a transaction without one). */
  private async waitForReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    const deadline = performance.now() + this.deps.receiptTimeoutMs;
    for (;;) {
      try {
        return await this.deps.client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.deps.pollMs, Math.ceil(remaining)));
    }
  }

  /**
   * Re-runs the call on the state before the inclusion block (`blockNumber - 1`, i.e. without this transaction's own
   * effects) to recover a revert reason; null if it does not reproduce.
   */
  private async replay(from: Address, req: WriteRequest, blockNumber: bigint) {
    try {
      await this.deps.client.call({ account: from, to: req.to, data: req.data, value: req.value, blockNumber: blockNumber - 1n });
      return null;
    } catch (error) {
      const data = extractRevertData(error);
      return data === undefined ? null : decodeRevert(data);
    }
  }
}
