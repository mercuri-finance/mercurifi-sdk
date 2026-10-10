import type { Address } from 'viem';

/**
 * One in-flight transaction per key, nonces counted locally after the first read. Any failure inside `fn`
 * (a drop, a send error, a timeout) forgets the local value, so the next send re-reads the pending count from
 * the chain. The docs say "one agent key per process"; the account allows up to 8 keys for parallelism.
 */
export class NonceManager {
  private readonly next = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly fetchPending: (address: Address) => Promise<number>) {}

  async withNonce<T>(address: Address, fn: (nonce: number) => Promise<T>): Promise<T> {
    const key = address.toLowerCase();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      const nonce = this.next.get(key) ?? (await this.fetchPending(address));
      try {
        const result = await fn(nonce);
        this.next.set(key, nonce + 1);
        return result;
      } catch (error) {
        this.next.delete(key);
        throw error;
      }
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  reset(address: Address): void {
    this.next.delete(address.toLowerCase());
  }
}
