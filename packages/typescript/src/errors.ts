import type { Hex } from 'viem';

/** Base class of every error the SDK throws on purpose. `code` is stable; messages may improve. */
export class MercurifiError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MercurifiError';
    this.code = code;
  }
}

/** A caller-supplied value is malformed or out of range. Never echoes key material. */
export class InvalidInputError extends MercurifiError {
  readonly field: string;

  constructor(field: string, message: string) {
    super('INVALID_INPUT', message);
    this.name = 'InvalidInputError';
    this.field = field;
  }
}

/** The RPC, address book, API key or account belongs to another network, or a pinned code hash differs. */
export class NetworkMismatchError extends MercurifiError {
  constructor(message: string) {
    super('NETWORK_MISMATCH', message);
    this.name = 'NetworkMismatchError';
  }
}

/** Agent Accounts have no recorded deployment on this network in this SDK build. */
export class NotDeployedError extends MercurifiError {
  constructor(network: string) {
    super(
      'NOT_DEPLOYED',
      `Mercurifi Agent Accounts are not deployed on ${network} in this SDK version.`,
    );
    this.name = 'NotDeployedError';
  }
}

/** The signer is not the account's owner. */
export class NotOwnerError extends MercurifiError {
  constructor(message: string) {
    super('NOT_OWNER', message);
    this.name = 'NotOwnerError';
  }
}

/** The current fee would exceed the caller's `maxFeePerGasCap`. */
export class GasPriceTooHighError extends MercurifiError {
  readonly requiredWei: bigint;
  readonly capWei: bigint;

  constructor(requiredWei: bigint, capWei: bigint) {
    super(
      'GAS_PRICE_TOO_HIGH',
      `The network needs at least ${requiredWei} wei per gas, above your cap of ${capWei}.`,
    );
    this.name = 'GasPriceTooHighError';
    this.requiredWei = requiredWei;
    this.capWei = capWei;
  }
}

/** No receipt within the wait budget. Arc drops some transactions without a receipt. */
export class TxDroppedError extends MercurifiError {
  readonly hash: Hex;

  constructor(hash: Hex, seconds: number) {
    super(
      'TX_DROPPED',
      `No receipt for ${hash} after ${seconds} s. Arc drops transactions priced under 20 gwei or sent from a blocklisted address without a receipt. The nonce is re-read before the next send.`,
    );
    this.name = 'TxDroppedError';
    this.hash = hash;
  }
}

/** The Mercurifi API answered with an error status. API keys never authorise funds. */
export class ApiError extends MercurifiError {
  readonly status: number;
  readonly apiCode: string;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, apiCode: string, message: string, retryAfterSeconds: number | null) {
    super('API_ERROR', message);
    this.name = 'ApiError';
    this.status = status;
    this.apiCode = apiCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Calldata built by the API does not match what was asked for; nothing was signed. */
export class BuildMismatchError extends MercurifiError {
  readonly reason: string;

  constructor(reason: string) {
    super('BUILD_MISMATCH', `Refusing API-built transaction: ${reason}. Nothing was signed.`);
    this.name = 'BuildMismatchError';
    this.reason = reason;
  }
}

/** The event stream failed in a way a reconnect cannot fix (for example an unknown topic). */
export class StreamError extends MercurifiError {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super('STREAM_ERROR', message);
    this.name = 'StreamError';
    this.status = status;
  }
}

/** The chain returned a value this SDK version does not understand (for example a new curve phase). Upgrade the SDK. */
export class UnexpectedChainStateError extends MercurifiError {
  constructor(message: string) {
    super('UNEXPECTED_CHAIN_STATE', message);
    this.name = 'UnexpectedChainStateError';
  }
}

/** The signer cannot do what this call needs (for example a custom signer without `signSignIn`). */
export class SignerCapabilityError extends MercurifiError {
  readonly method: string;

  constructor(method: string) {
    super(
      'SIGNER_CAPABILITY',
      `This signer has no ${method}(); signals and notes need it. localKey and kmsSigner have it.`,
    );
    this.name = 'SignerCapabilityError';
    this.method = method;
  }
}
