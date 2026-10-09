import { hexToNumber, TransactionReceiptNotFoundError, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';

import { NetworkMismatchError, TxDroppedError } from './errors.js';
import { feesWithFloor, gasLimitFor, GRADUATION_GAS_LIMIT } from './gas.js';
import type { NonceManager } from './nonce.js';
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
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PRIORITY = 1_000_000_000n;

/** build → chain check → preflight → estimate → fees → chain check → sign → send → wait. */
export class TxSender {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: SenderDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Re-checks that the RPC still serves the verified chain. One uncached `eth_chainId` per send: an RPC that was
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
    await this.assertChain();
    const preflightData = await this.preflight(signer.address, req);
    const estimate = await this.estimate(signer.address, req);
    const gas = gasLimitFor(estimate, req.mayGraduate === true);
    const [block, priority] = await Promise.all([
      this.deps.client.getBlock({ blockTag: 'latest' }),
      this.deps.client.estimateMaxPriorityFeePerGas().catch(() => DEFAULT_PRIORITY),
    ]);
    const fees = feesWithFloor(block.baseFeePerGas ?? 0n, priority, this.deps.maxFeePerGasCap);

    const { hash, receipt } = await this.deps.nonces.withNonce(signer.address, async (nonce) => {
      await this.assertChain();
      const raw = await signer.signTransaction({
        type: 'eip1559', chainId: this.deps.chainId, nonce, to: req.to, data: req.data, value: req.value ?? 0n, gas, ...fees,
      });
      const sentHash = await this.deps.client.sendRawTransaction({ serializedTransaction: raw });
      const included = await this.waitForReceipt(sentHash);
      if (included === null) throw new TxDroppedError(sentHash, Math.round(this.deps.receiptTimeoutMs / 1000));
      return { hash: sentHash, receipt: included };
    });

    if (receipt.status !== 'success') throw new TxRevertedError(hash, await this.replay(signer.address, req, receipt.blockNumber));
    return { hash, receipt, preflightData };
  }

  private async estimate(from: Address, req: WriteRequest): Promise<bigint> {
    try {
      return await this.deps.client.estimateGas({ account: from, to: req.to, data: req.data, value: req.value });
    } catch (error) {
      const data = extractRevertData(error);
      if (data !== undefined) throw new ContractRevertError(decodeRevert(data), 'preflight');
      if (req.mayGraduate === true) return GRADUATION_GAS_LIMIT;
      throw error;
    }
  }

  /** Polls for a receipt; null after the budget (Arc can drop a transaction without one). */
  private async waitForReceipt(hash: Hex): Promise<TransactionReceipt | null> {
    let waited = 0;
    for (;;) {
      try {
        return await this.deps.client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
      if (waited >= this.deps.receiptTimeoutMs) return null;
      const step = Math.min(this.deps.pollMs, this.deps.receiptTimeoutMs - waited);
      await this.sleep(step);
      waited += step;
    }
  }

  /** Re-runs the call on the state before the inclusion block to recover a revert reason; null if it does not reproduce. */
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
