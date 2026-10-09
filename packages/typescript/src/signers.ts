import {
  hexToBigInt, isAddressEqual, keccak256, recoverTransactionAddress, serializeTransaction,
  type Address, type Hex, type TransactionSerializableEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { InvalidInputError, MercurifiError } from './errors.js';

/** Signs Arc transactions. The SDK never sees more of a signer than this. */
export interface Signer {
  readonly address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
/** secp256k1 group order / 2: a larger s is the malleable twin, which nodes reject. */
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

const redacted = (signer: Signer, kind: string): Signer => {
  Object.defineProperty(signer, 'toJSON', { value: () => ({ type: kind, address: signer.address }), enumerable: false });
  Object.defineProperty(signer, INSPECT, { value: () => `${kind}(${signer.address})`, enumerable: false });
  return Object.freeze(signer);
};

/**
 * A signer over a private key held in this process. The key lives only in a closure: it is not a property,
 * not serialised and not part of any error message.
 */
export const localKey = (privateKey: string): Signer => {
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!KEY_PATTERN.test(key)) throw new InvalidInputError('privateKey', 'expected a 32-byte hex private key');
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    // Deliberately drop the cause: viem's message must never be able to carry key material.
    throw new InvalidInputError('privateKey', 'the value is not a valid secp256k1 private key (32-byte hex, non-zero, below the curve order)');
  }
  return redacted({ address: account.address, signTransaction: (tx) => account.signTransaction(tx) }, 'LocalKeySigner');
};

/** A new agent key from the platform CSPRNG. Store `privateKey` on your server only; the SDK keeps no copy. */
export const generateAgentKey = (): { address: Address; privateKey: Hex } => {
  const privateKey = generatePrivateKey();
  return { address: privateKeyToAccount(privateKey).address, privateKey };
};

/** A remote signer (AWS KMS, GCP KMS, HSM) reduced to "sign this 32-byte digest". Low-s normalisation is the adapter's job. */
export interface KmsAdapter {
  readonly address: Address;
  signDigest(digest: Hex): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }>;
}

/** Wraps a KmsAdapter; every signature is recovered and checked against the adapter's address. */
export const kmsSigner = (adapter: KmsAdapter): Signer => {
  const address = adapter.address;
  return redacted(
    {
      address,
      async signTransaction(tx) {
        const digest = keccak256(serializeTransaction(tx));
        const signature = await adapter.signDigest(digest);
        if (hexToBigInt(signature.s) > HALF_N) {
          throw new MercurifiError('KMS_SIGNATURE_MISMATCH', 'The KMS signature has a high s value; the adapter must normalise s to the lower half of the curve order.');
        }
        const raw = serializeTransaction(tx, signature);
        const recovered = await recoverTransactionAddress({ serializedTransaction: raw as never });
        if (!isAddressEqual(recovered, address)) {
          throw new MercurifiError('KMS_SIGNATURE_MISMATCH', 'The KMS signature does not recover to the configured address (wrong key, or s not normalised).');
        }
        return raw;
      },
    },
    'KmsSigner',
  );
};
