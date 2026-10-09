import {
  custom, decodeFunctionData, encodeFunctionResult, keccak256, toFunctionSelector, toHex, getAbiItem,
  type Abi, type AbiFunction, type Address, type Hex, type Transport,
} from 'viem';

export interface RpcLog { address: Address; topics: Hex[]; data: Hex }
type Result = unknown | ((args: readonly unknown[]) => unknown);
type TopicFilter = (Hex | Hex[] | null)[];

const callKey = (to: string, data: string): string => `${to.toLowerCase()}:${data.slice(0, 10).toLowerCase()}`;

/** eth_getLogs topic matching: null is a wildcard, an array is "any of", comparison ignores case. */
const topicsMatch = (filter: TopicFilter | undefined, topics: Hex[]): boolean =>
  (filter ?? []).every((want, i) => {
    if (want === null || want === undefined) return true;
    const have = topics[i]?.toLowerCase();
    return (Array.isArray(want) ? want : [want]).some((w) => w.toLowerCase() === have);
  });

/** A scriptable JSON-RPC endpoint for viem's custom transport. Unmocked methods and calls throw loudly. */
export class MockRpc {
  readonly calls: { method: string; params: unknown[] }[] = [];
  readonly sent: Hex[] = [];
  block = { number: 1_000n, timestamp: 1_700_000_000n, baseFeePerGas: 20_000_000_000n };
  codes = new Map<string, Hex>();
  balances = new Map<string, bigint>();
  logs: RpcLog[] = [];
  nonce = 7;
  receiptMode: 'success' | 'reverted' | 'none' = 'success';
  receiptLogs: RpcLog[] = [];
  gasEstimate = 150_000n;
  private readonly handlers = new Map<string, (params: unknown[]) => unknown>();
  private readonly reads = new Map<string, (data: Hex) => Hex>();
  private readonly reverts = new Map<string, Hex>();
  private readonly receipts = new Map<Hex, { status: 'success' | 'reverted'; logs: RpcLog[] }>();

  constructor(readonly chainId: number) {
    this.on('eth_chainId', () => toHex(this.chainId));
    this.on('eth_blockNumber', () => toHex(this.block.number));
    this.on('eth_getBlockByNumber', () => ({
      number: toHex(this.block.number), hash: keccak256(toHex(this.block.number)), parentHash: `0x${'00'.repeat(32)}`,
      timestamp: toHex(this.block.timestamp), baseFeePerGas: toHex(this.block.baseFeePerGas),
      gasLimit: toHex(30_000_000n), gasUsed: '0x0', transactions: [],
    }));
    this.on('eth_getCode', ([address]) => this.codes.get(String(address).toLowerCase()) ?? '0x');
    this.on('eth_getBalance', ([address]) => toHex(this.balances.get(String(address).toLowerCase()) ?? 0n));
    this.on('eth_getTransactionCount', () => toHex(this.nonce));
    this.on('eth_maxPriorityFeePerGas', () => toHex(1_000_000_000n));
    this.on('eth_estimateGas', ([tx]) => { this.handleCall(tx as { to: Address; data: Hex }); return toHex(this.gasEstimate); });
    this.on('eth_call', ([tx]) => this.handleCall(tx as { to: Address; data: Hex }));
    this.on('eth_sendRawTransaction', ([raw]) => {
      const hash = keccak256(raw as Hex);
      this.sent.push(raw as Hex);
      if (this.receiptMode !== 'none') this.receipts.set(hash, { status: this.receiptMode, logs: this.receiptLogs });
      return hash;
    });
    this.on('eth_getTransactionReceipt', ([hash]) => {
      const r = this.receipts.get(hash as Hex);
      return r === undefined ? null : this.rpcReceipt(hash as Hex, r);
    });
    this.on('eth_getLogs', ([filter]) => {
      const f = filter as { address?: string; fromBlock?: Hex; toBlock?: Hex; topics?: TopicFilter };
      return this.logs
        .filter((l) => f.address === undefined || l.address.toLowerCase() === f.address.toLowerCase())
        .filter((l) => topicsMatch(f.topics, l.topics))
        .map((l, i) => ({ ...l, blockNumber: toHex(this.block.number), blockHash: keccak256(toHex(this.block.number)), transactionHash: keccak256(toHex(i)), transactionIndex: '0x0', logIndex: toHex(i), removed: false }));
    });
  }

  on(method: string, fn: (params: unknown[]) => unknown): this {
    this.handlers.set(method, fn);
    return this;
  }

  /** Answers `eth_call` to `address` for `functionName`; `result` may be a function of the decoded args. */
  read(address: Address, abi: Abi, functionName: string, result: Result): this {
    const item = getAbiItem({ abi, name: functionName }) as AbiFunction;
    this.reads.set(callKey(address, toFunctionSelector(item)), (data) => {
      const { args } = decodeFunctionData({ abi: [item], data });
      const value = typeof result === 'function' ? (result as (a: readonly unknown[]) => unknown)(args ?? []) : result;
      return encodeFunctionResult({ abi: [item], functionName, result: value } as never);
    });
    this.reverts.delete(callKey(address, toFunctionSelector(item)));
    return this;
  }

  /** Makes `eth_call`/`eth_estimateGas` to `address`.`functionName` revert with `data`. */
  revert(address: Address, abi: Abi, functionName: string, data: Hex): this {
    const item = getAbiItem({ abi, name: functionName }) as AbiFunction;
    this.reverts.set(callKey(address, toFunctionSelector(item)), data);
    return this;
  }

  methods(name: string): unknown[][] {
    return this.calls.filter((c) => c.method === name).map((c) => c.params);
  }

  transport(): Transport {
    return custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const p = (params ?? []) as unknown[];
        this.calls.push({ method, params: p });
        const handler = this.handlers.get(method);
        if (handler === undefined) throw new Error(`unmocked RPC method ${method}`);
        return handler(p);
      },
    });
  }

  private handleCall(tx: { to: Address; data: Hex }): Hex {
    const key = callKey(tx.to, tx.data ?? '0x');
    const revert = this.reverts.get(key);
    if (revert !== undefined) throw Object.assign(new Error('execution reverted'), { code: 3, data: revert });
    const read = this.reads.get(key);
    if (read === undefined) throw new Error(`unmocked eth_call ${key}`);
    return read(tx.data);
  }

  private rpcReceipt(hash: Hex, r: { status: 'success' | 'reverted'; logs: RpcLog[] }) {
    const blockNumber = toHex(this.block.number + 1n);
    const blockHash = keccak256(blockNumber);
    return {
      transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber, from: `0x${'11'.repeat(20)}`, to: `0x${'22'.repeat(20)}`,
      cumulativeGasUsed: toHex(120_000n), gasUsed: toHex(120_000n), effectiveGasPrice: toHex(21_000_000_000n),
      contractAddress: null, logsBloom: `0x${'00'.repeat(256)}`, status: r.status === 'success' ? '0x1' : '0x0', type: '0x2',
      logs: r.logs.map((log, i) => ({
        ...log, blockHash, blockNumber, transactionHash: hash, transactionIndex: '0x0', logIndex: toHex(i), removed: false,
      })),
    };
  }
}
