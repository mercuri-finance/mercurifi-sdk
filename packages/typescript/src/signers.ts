import {
  hashMessage,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  recoverMessageAddress,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { InvalidInputError, MercurifiError } from './errors.js';

/** Signs Arc transactions, and (optionally) the SDK's own sign-in text. The SDK never sees more of a signer than this. */
export interface Signer {
  readonly address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
  /**
   * Signs a sign-in message as an EIP-191 personal message. The SDK only ever passes text it built and
   * checked itself (see `signin.ts`). Optional: a signer without it still trades.
   */
  signSignIn?(message: string): Promise<Hex>;
}

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
/** secp256k1 group order, and half of it: a larger s is the malleable twin, which nodes reject. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N / 2n;

const redacted = (signer: Signer, kind: string): Signer => {
  Object.defineProperty(signer, 'toJSON', {
    value: () => ({ type: kind, address: signer.address }),
    enumerable: false,
  });
  Object.defineProperty(signer, INSPECT, {
    value: () => `${kind}(${signer.address})`,
    enumerable: false,
  });
  return Object.freeze(signer);
};

/**
 * A signer over a private key held in this process. The key lives only in a closure: it is not a property,
 * not serialised and not part of any error message.
 *
 * @throws {InvalidInputError} for non-string input or anything but a valid 32-byte hex key
 */
export const localKey = (privateKey: string): Signer => {
  if (typeof privateKey !== 'string')
    throw new InvalidInputError('privateKey', 'expected a 32-byte hex private key as a string');
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!KEY_PATTERN.test(key))
    throw new InvalidInputError('privateKey', 'expected a 32-byte hex private key');
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    // Deliberately drop the cause: viem's message must never be able to carry key material.
    throw new InvalidInputError(
      'privateKey',
      'the value is not a valid secp256k1 private key (32-byte hex, non-zero, below the curve order)',
    );
  }
  return redacted(
    {
      address: account.address,
      signTransaction: (tx) => account.signTransaction(tx),
      signSignIn: (message) => account.signMessage({ message }),
    },
    'LocalKeySigner',
  );
};

/**
 * A freshly generated agent key. `privateKey` is a non-enumerable getter and the object redacts itself in
 * `JSON.stringify` and `util.inspect`; read the secret on purpose with `exportPrivateKey()` and store it on your server only.
 */
export interface AgentKey {
  readonly address: Address;
  readonly privateKey: Hex;
  exportPrivateKey(): Hex;
}

/** A new agent key from the platform CSPRNG. The SDK keeps no copy. */
export const generateAgentKey = (): AgentKey => {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const out = { address } as { address: Address };
  Object.defineProperty(out, 'privateKey', { get: () => privateKey, enumerable: false });
  Object.defineProperty(out, 'exportPrivateKey', { value: () => privateKey, enumerable: false });
  Object.defineProperty(out, 'toJSON', {
    value: () => ({ type: 'AgentKey', address }),
    enumerable: false,
  });
  Object.defineProperty(out, INSPECT, { value: () => `AgentKey(${address})`, enumerable: false });
  return Object.freeze(out) as AgentKey;
};

/**
 * A remote signer (AWS KMS, GCP KMS, HSM) reduced to "sign this 32-byte digest". A high s is normalised by the SDK.
 * `yParity` may be omitted (most KMS APIs return only DER r and s); the SDK then tries both parities.
 */
export interface KmsAdapter {
  readonly address: Address;
  signDigest(digest: Hex): Promise<{ r: Hex; s: Hex; yParity?: 0 | 1 }>;
}

const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;
const mismatch = (message: string): MercurifiError =>
  new MercurifiError('KMS_SIGNATURE_MISMATCH', message);

/**
 * Validates a KMS r and s, folds a high s to its low twin and tries the parity (given, or both). `attempt`
 * builds the final output for one parity and reports the address it recovers to; the first that matches wins.
 */
const resolveKmsSignature = async <T>(
  signature: { r: Hex; s: Hex; yParity?: 0 | 1 },
  address: Address,
  attempt: (
    r: bigint,
    s: bigint,
    yParity: 0 | 1,
  ) => Promise<{ value: T; recovered: Address | undefined }>,
): Promise<T> => {
  let r: bigint;
  let s: bigint;
  try {
    r = hexToBigInt(signature.r);
    s = hexToBigInt(signature.s);
  } catch {
    throw mismatch('The KMS signature has a malformed r or s.');
  }
  if (r <= 0n || r >= N || s <= 0n || s >= N)
    throw mismatch('The KMS signature has an r or s outside 1..n-1.');
  let given: 0 | 1 | undefined = signature.yParity;
  if (given !== undefined && given !== 0 && given !== 1)
    throw mismatch('The KMS signature has an invalid yParity.');
  if (s > HALF_N) {
    s = N - s;
    if (given !== undefined) given = given === 0 ? 1 : 0;
  }
  for (const parity of given === undefined ? ([0, 1] as const) : ([given] as const)) {
    const { value, recovered } = await attempt(r, s, parity);
    if (recovered !== undefined && isAddressEqual(recovered, address)) return value;
  }
  throw mismatch(
    'The KMS signature does not recover to the configured address (wrong key or wrong digest).',
  );
};

/** Wraps a KmsAdapter; every signature is recovered and checked against the adapter's address. */
export const kmsSigner = (adapter: KmsAdapter): Signer => {
  const address = adapter.address;
  return redacted(
    {
      address,
      async signTransaction(tx) {
        const signature = await adapter.signDigest(keccak256(serializeTransaction(tx)));
        return resolveKmsSignature(signature, address, async (r, s, yParity) => {
          const raw = serializeTransaction(tx, { r: word(r), s: word(s), yParity });
          const recovered = await recoverTransactionAddress({
            serializedTransaction: raw as never,
          }).catch(() => undefined);
          return { value: raw, recovered };
        });
      },
      async signSignIn(message) {
        const signature = await adapter.signDigest(hashMessage(message));
        return resolveKmsSignature(signature, address, async (r, s, yParity) => {
          const sig = `${word(r)}${word(s).slice(2)}${yParity === 0 ? '1b' : '1c'}` as Hex;
          const recovered = await recoverMessageAddress({ message, signature: sig }).catch(
            () => undefined,
          );
          return { value: sig, recovered };
        });
      },
    },
    'KmsSigner',
  );
};
