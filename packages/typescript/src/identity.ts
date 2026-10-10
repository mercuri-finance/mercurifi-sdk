/**
 * Optional ERC-8004 identity helpers: a registration file that links an agent account, calldata for the caller's own
 * wallet to register it, and reads of the IdentityRegistry. Nothing here signs or sends.
 *
 * Who signs: an EOA, normally the owner wallet. An agent account cannot register itself (it only calls allowlisted
 * Mercurifi targets), and it cannot prove control by signature (`isValidSignature` always fails), so it can never be
 * the registry's verified `agentWallet`. The account is linked only through the registration file.
 */
import {
  BaseError, ContractFunctionRevertedError, decodeEventLog, encodeFunctionData, getAddress, isAddress, isAddressEqual, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem';

import { metadataUriProblem } from './agent.js';
import { InvalidInputError, MercurifiError, NetworkMismatchError, NotDeployedError } from './errors.js';
import { NETWORKS } from './networks.js';
import { rpcError } from './redact.js';

/** The ERC-8004 registries on one Arc network (all three are upgradeable proxies). */
export interface Erc8004Book {
  chainId: number;
  identityRegistry: Address;
  reputationRegistry: Address;
  validationRegistry: Address;
}

export type IdentityNetwork = 'testnet' | 'mainnet';

/** Checked with eth_getCode on each network. Mainnet is listed but refused until Agent Accounts are recorded there. */
export const ERC8004_REGISTRIES: Readonly<Record<IdentityNetwork, Erc8004Book>> = Object.freeze({
  testnet: Object.freeze({
    chainId: 5042002,
    identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    validationRegistry: '0x8004Cb1BF31DAf7788923b405b754f57acEB4272',
  }),
  mainnet: Object.freeze({
    chainId: 5042,
    identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    validationRegistry: '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58',
  }),
});

/** The registration-file `type` of the ERC-8004 version deployed on Arc (IdentityRegistry `getVersion()` 2.0.0). */
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
/** The service entry that links the agent account, as `eip155:<chainId>:<account>`. Callers cannot add another. */
export const AGENT_ACCOUNT_SERVICE = 'MercurifiAgentAccount';
export const TRUST_MODELS = Object.freeze(['reputation', 'crypto-economic', 'tee-attestation'] as const);
export type TrustModel = (typeof TRUST_MODELS)[number];
const DATA_PREFIX = 'data:application/json;base64,';
const MAX_DATA_URI_BYTES = 16_384;
const MAX_SERVICES = 16;

/**
 * The IdentityRegistry functions and events this module uses, written by hand from the ERC-8004 text and checked
 * against the deployed implementation's bytecode (every selector and event topic is present).
 */
export const identityRegistryAbi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
  {
    type: 'function', name: 'setAgentURI', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'newURI', type: 'string' }], outputs: [],
  },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'getAgentWallet', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  {
    type: 'event', name: 'Registered', anonymous: false,
    inputs: [{ name: 'agentId', type: 'uint256', indexed: true }, { name: 'agentURI', type: 'string', indexed: false }, { name: 'owner', type: 'address', indexed: true }],
  },
  {
    type: 'event', name: 'Transfer', anonymous: false,
    inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'tokenId', type: 'uint256', indexed: true }],
  },
] as const;

/**
 * The registry for a network. Like every other agent feature, a network without a recorded Agent Accounts deployment
 * in this SDK (mainnet today) is refused with `NotDeployedError`.
 */
export const erc8004Registries = (network: IdentityNetwork): Erc8004Book => {
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new InvalidInputError('network', 'ERC-8004 helpers support network "testnet" (and "mainnet" once Agent Accounts are deployed there).');
  }
  if (NETWORKS[network].agents === null) throw new NotDeployedError(network);
  return ERC8004_REGISTRIES[network];
};

export interface RegistrationService { name: string; endpoint: string; version?: string }
export interface RegistrationFileParams {
  network: IdentityNetwork;
  /** The agent account to link. Listed as a service entry; it is never the registry's `agentWallet`. */
  account: Address;
  name: string;
  description?: string;
  /** https:// or ipfs://. */
  image?: string;
  /** Extra endpoints (A2A, MCP, web, ENS, DID…), after the account entry. */
  services?: readonly RegistrationService[];
  /** Known after registering: adds the `registrations` entry the standard asks for. Set it with a second `setAgentURI`. */
  agentId?: bigint;
  x402Support?: boolean;
  active?: boolean;
  supportedTrust?: readonly TrustModel[];
}
export interface RegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: { name: string; endpoint: string; version?: string }[];
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: number; agentRegistry: string }[];
  supportedTrust?: TrustModel[];
}

const utf8Length = (v: string): number => new TextEncoder().encode(v).length;
/** Control, format and lone-surrogate characters; `allowNewline` keeps `\n` (descriptions). */
const hasControl = (v: string, allowNewline = false): boolean => /[\p{Cc}\p{Cf}\p{Cs}]/u.test(allowNewline ? v.replace(/\n/g, '') : v);

const text = (field: string, v: unknown, max: number, opts: { min?: number; allowNewline?: boolean; noSpace?: boolean } = {}): string => {
  const min = opts.min ?? 0;
  const size = min > 0 ? `${field} must be ${min}-${max} bytes (UTF-8)` : `${field} must be a string of at most ${max} bytes (UTF-8)`;
  if (typeof v !== 'string') throw new InvalidInputError(field, size);
  // Characters first, then length, so a lone surrogate is reported the same way in Python (which cannot encode it).
  if (hasControl(v, opts.allowNewline)) throw new InvalidInputError(field, `${field} contains control or format characters`);
  if (opts.noSpace && /\s/.test(v)) throw new InvalidInputError(field, `${field} contains whitespace`);
  if (utf8Length(v) < min || utf8Length(v) > max) throw new InvalidInputError(field, size);
  return v;
};

const accountAddress = (v: unknown): Address => {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new InvalidInputError('account', 'account must be a 20-byte hex address');
  if (isAddressEqual(v, zeroAddress)) throw new InvalidInputError('account', 'account cannot be the zero address');
  return getAddress(v);
};

const agentIdOf = (v: unknown, max: bigint = (1n << 256n) - 1n): bigint => {
  if (typeof v !== 'bigint' || v < 0n || v > max) throw new InvalidInputError('agentId', `agentId must be a bigint in 0..${max}`);
  return v;
};

const services = (v: unknown): RegistrationService[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new InvalidInputError('services', 'services must be a list of { name, endpoint, version? }');
  if (v.length > MAX_SERVICES) throw new InvalidInputError('services', `services can hold at most ${MAX_SERVICES} entries`);
  return v.map((s: unknown, i) => {
    if (typeof s !== 'object' || s === null) throw new InvalidInputError('services', `services[${i}] must be { name, endpoint, version? }`);
    const { name, endpoint, version } = s as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (!['name', 'endpoint', 'version'].includes(key)) throw new InvalidInputError('services', `services[${i}] has an unknown field ${key}`);
    }
    const n = text('services', name, 64, { min: 1, noSpace: true });
    if (n.toLowerCase() === AGENT_ACCOUNT_SERVICE.toLowerCase()) throw new InvalidInputError('services', `services[${i}]: the name ${AGENT_ACCOUNT_SERVICE} is reserved for the account entry`);
    const out: RegistrationService = { name: n, endpoint: text('services', endpoint, 512, { min: 1, noSpace: true }) };
    if (version !== undefined) out.version = text('services', version, 32, { min: 1, noSpace: true });
    return out;
  });
};

/**
 * Builds the ERC-8004 registration file for an agent account (pure; no network access). Keys are in a fixed order so
 * `registrationFileJson` gives the same bytes in TypeScript and Python. The account appears as the
 * `MercurifiAgentAccount` service with endpoint `eip155:<chainId>:<account>`.
 */
export const buildRegistrationFile = (p: RegistrationFileParams): RegistrationFile => {
  const book = erc8004Registries(p.network);
  const account = accountAddress(p.account);
  const name = text('name', p.name, 64, { min: 1 });
  const description = p.description === undefined ? '' : text('description', p.description, 2000, { allowNewline: true });
  if (p.image !== undefined) {
    const problem = metadataUriProblem(p.image);
    if (problem !== null) throw new InvalidInputError('image', `image cannot be used: ${problem}`);
  }
  const extra = services(p.services);
  if (p.x402Support !== undefined && typeof p.x402Support !== 'boolean') throw new InvalidInputError('x402Support', 'x402Support must be a boolean');
  if (p.active !== undefined && typeof p.active !== 'boolean') throw new InvalidInputError('active', 'active must be a boolean');
  let trust: TrustModel[] | undefined;
  if (p.supportedTrust !== undefined) {
    if (!Array.isArray(p.supportedTrust) || p.supportedTrust.some((t) => !(TRUST_MODELS as readonly unknown[]).includes(t))) {
      throw new InvalidInputError('supportedTrust', `supportedTrust entries must be ${TRUST_MODELS.join(', ')}`);
    }
    trust = [...new Set(p.supportedTrust)];
  }
  // A JSON number: ids above 2^53 - 1 would lose precision in readers.
  const agentId = p.agentId === undefined ? undefined : Number(agentIdOf(p.agentId, BigInt(Number.MAX_SAFE_INTEGER)));
  const file: RegistrationFile = {
    type: REGISTRATION_TYPE,
    name,
    description,
    ...(p.image !== undefined ? { image: p.image } : {}),
    services: [{ name: AGENT_ACCOUNT_SERVICE, endpoint: `eip155:${book.chainId}:${account}` }, ...extra],
    x402Support: p.x402Support ?? false,
    active: p.active ?? true,
    registrations: agentId === undefined ? [] : [{ agentId, agentRegistry: `eip155:${book.chainId}:${book.identityRegistry}` }],
    ...(trust !== undefined && trust.length > 0 ? { supportedTrust: trust } : {}),
  };
  return file;
};

/** The compact JSON to publish (https:// or ipfs://) or to embed with `registrationDataUri`. */
export const registrationFileJson = (file: RegistrationFile): string => JSON.stringify(file);

/** A fully on-chain agent URI: `data:application/json;base64,…` of the compact JSON (UTF-8). */
export const registrationDataUri = (file: RegistrationFile): string => {
  const bytes = new TextEncoder().encode(registrationFileJson(file));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `${DATA_PREFIX}${btoa(binary)}`;
};

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Why an agent URI cannot be used, or null: https:// or ipfs:// under the metadata URI rules (at most 256 bytes), or
 * `data:application/json;base64,` with canonical base64 and at most 16,384 bytes in all. The value is never echoed.
 */
export const agentUriProblem = (uri: unknown): string | null => {
  if (typeof uri !== 'string' || uri === '') return 'it is empty or not a string';
  if (uri.startsWith(DATA_PREFIX)) {
    const payload = uri.slice(DATA_PREFIX.length);
    if (payload === '' || !CANONICAL_BASE64.test(payload)) return 'its base64 payload is empty or not canonical base64';
    if (uri.length > MAX_DATA_URI_BYTES) return `it is longer than ${MAX_DATA_URI_BYTES} bytes`;
    return null;
  }
  const problem = metadataUriProblem(uri);
  if (problem === 'it must start with https:// or ipfs://') return 'it must start with https://, ipfs:// or data:application/json;base64,';
  return problem;
};

const checkedUri = (uri: unknown): string => {
  const problem = agentUriProblem(uri);
  if (problem !== null) throw new InvalidInputError('agentURI', `agentURI cannot be used: ${problem}`);
  return uri as string;
};

/** An unsigned call for the caller's own wallet to send (an EOA; see the module note). */
export interface IdentityCall { chainId: number; to: Address; data: Hex; value: 0n }

/** `register(agentURI)` calldata. The sender becomes the agent's owner and its initial `agentWallet`. */
export const encodeRegister = (p: { network: IdentityNetwork; agentURI: string }): IdentityCall => {
  const book = erc8004Registries(p.network);
  const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: 'register', args: [checkedUri(p.agentURI)] });
  return { chainId: book.chainId, to: book.identityRegistry, data, value: 0n };
};

/** `setAgentURI(agentId, agentURI)` calldata, for the agent's owner or an approved operator. */
export const encodeSetAgentURI = (p: { network: IdentityNetwork; agentId: bigint; agentURI: string }): IdentityCall => {
  const book = erc8004Registries(p.network);
  const data = encodeFunctionData({ abi: identityRegistryAbi, functionName: 'setAgentURI', args: [agentIdOf(p.agentId), checkedUri(p.agentURI)] });
  return { chainId: book.chainId, to: book.identityRegistry, data, value: 0n };
};

export interface RegisteredAgent { agentId: bigint; owner: Address; agentURI: string | null }
export interface IdentityReceiptLike {
  transactionHash: Hex;
  status?: 'success' | 'reverted';
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

/**
 * The agent a `register` transaction created, from the registry's `Registered` log (or, without one, its mint
 * `Transfer`; `agentURI` is then null). Exactly one registration from this network's registry must be present.
 */
export const agentIdFromReceipt = (p: { network: IdentityNetwork; receipt: IdentityReceiptLike }): RegisteredAgent => {
  const book = erc8004Registries(p.network);
  const r = p.receipt;
  if (r.status === 'reverted') throw new MercurifiError('TX_REVERTED', `${r.transactionHash} reverted; no agent was registered.`);
  const own = r.logs.filter((l) => isAddressEqual(l.address, book.identityRegistry));
  const decoded = own.flatMap((l) => {
    try {
      return [decodeEventLog({ abi: identityRegistryAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true })];
    } catch {
      return [];
    }
  });
  const registered = decoded.filter((e) => e.eventName === 'Registered');
  if (registered.length > 1) throw new MercurifiError('MISSING_EVENT', `${r.transactionHash} registered ${registered.length} agents; read each Registered log yourself.`);
  const reg = registered[0];
  if (reg !== undefined && reg.eventName === 'Registered') return { agentId: reg.args.agentId, owner: getAddress(reg.args.owner), agentURI: reg.args.agentURI };
  const mints = decoded.flatMap((e) => (e.eventName === 'Transfer' && isAddressEqual(e.args.from, zeroAddress) ? [e.args] : []));
  if (mints.length !== 1 || mints[0] === undefined) {
    throw new MercurifiError('MISSING_EVENT', `${r.transactionHash} has ${mints.length === 0 ? 'no' : mints.length} agent registration event${mints.length === 1 ? '' : 's'} from the ${p.network} IdentityRegistry.`);
  }
  return { agentId: mints[0].tokenId, owner: getAddress(mints[0].to), agentURI: null };
};

export interface AgentIdentity {
  agentId: bigint;
  owner: Address;
  /** The agent URI as stored; untrusted text written by the agent's owner. */
  agentURI: string;
  /** The registry's verified payment wallet: the registering EOA by default, zero after a transfer. Never an agent account. */
  agentWallet: Address;
}

/**
 * Reads one agent from the network's IdentityRegistry. The client must be on that network (`NetworkMismatchError`
 * otherwise); an unknown id fails with `AGENT_NOT_FOUND`. RPC failures are reported without the RPC URL.
 */
export const getAgent = async (client: PublicClient, p: { network: IdentityNetwork; agentId: bigint }): Promise<AgentIdentity> => {
  const book = erc8004Registries(p.network);
  const agentId = agentIdOf(p.agentId);
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw rpcError(error);
  }
  if (chainId !== book.chainId) throw new NetworkMismatchError(`The RPC is on chain ${chainId}, not ${p.network} (${book.chainId}).`);
  const read = <T>(functionName: 'ownerOf' | 'tokenURI' | 'getAgentWallet'): Promise<T> =>
    client.readContract({ address: book.identityRegistry, abi: identityRegistryAbi, functionName, args: [agentId] }) as Promise<T>;
  let owner: Address;
  try {
    owner = await read<Address>('ownerOf');
  } catch (error) {
    // A revert (ERC721NonexistentToken) means no such agent; a transport failure is an RPC error.
    if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError) !== null) {
      throw new MercurifiError('AGENT_NOT_FOUND', `There is no agent ${agentId} in the ${p.network} IdentityRegistry.`);
    }
    throw rpcError(error);
  }
  try {
    const [agentURI, agentWallet] = await Promise.all([read<string>('tokenURI'), read<Address>('getAgentWallet')]);
    return { agentId, owner: getAddress(owner), agentURI, agentWallet: getAddress(agentWallet) };
  } catch (error) {
    throw rpcError(error);
  }
};
