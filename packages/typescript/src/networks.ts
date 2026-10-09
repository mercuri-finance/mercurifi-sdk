import type { Address, Hex } from 'viem';

import { NetworkMismatchError } from './errors.js';

export interface LaunchBook {
  factory: Address;
  feeManager: Address;
  graduationManager: Address;
  launchHook: Address;
  poolManager: Address;
  permit2: Address;
  universalRouter: Address;
  v4Quoter: Address;
  usdc: Address;
}

/**
 * One Agent Accounts deployment: the factory, the account implementation its clones run, and the singleton
 * AgentPolicyRegistry the factory deployed in its constructor (owner functions, configuration and usage live there).
 */
export interface AgentBook {
  factory: Address;
  implementation: Address;
  registry: Address;
  factoryCodeHash: Hex;
  implementationCodeHash: Hex;
  registryCodeHash: Hex;
  deployBlock: bigint;
}

export interface NetworkBook {
  name: 'mainnet' | 'testnet' | 'local';
  chainId: number;
  defaultRpcUrl: string | null;
  apiBaseUrl: string | null;
  apiKeyPrefix: 'mfk_live_' | 'mfk_test_' | null;
  launch: LaunchBook;
  /** null until an owner-approved factory deployment is recorded in this package. */
  agents: AgentBook | null;
}

const USDC: Address = '0x3600000000000000000000000000000000000000';
const SHARED = {
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  universalRouter: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
  v4Quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94',
  usdc: USDC,
} as const;

/** Arc mainnet. Launch addresses from deployments/5042.json in the Mercurifi Launch contracts repository (github.com/mercuri-finance/mercuri-launch-contracts). */
export const MAINNET: NetworkBook = Object.freeze({
  name: 'mainnet',
  chainId: 5042,
  defaultRpcUrl: null,
  apiBaseUrl: 'https://launch-api.mercuri.finance',
  apiKeyPrefix: 'mfk_live_',
  launch: Object.freeze({
    factory: '0x8f5DfA0c48E14cCD03AE01795B8a95759BA859EB',
    feeManager: '0x31D1bfe59B783f4c077F853f962D1355AfB52580',
    graduationManager: '0x5E82a03a30a1627Cb0Fa860dBe708e262e5124e4',
    launchHook: '0xe6D50A6e12f3883605A4456dCDEe50EE05fAE0Cc',
    ...SHARED,
  }),
  agents: null,
});

/** Arc testnet. Launch addresses from deployments/5042002.json in the Mercurifi Launch contracts repository (github.com/mercuri-finance/mercuri-launch-contracts). */
export const TESTNET: NetworkBook = Object.freeze({
  name: 'testnet',
  chainId: 5042002,
  defaultRpcUrl: 'https://rpc.testnet.arc.io',
  apiBaseUrl: 'https://testnet-launch-api.mercuri.finance',
  apiKeyPrefix: 'mfk_test_',
  launch: Object.freeze({
    factory: '0x08D8CDDA59b5ce9216F7eD9B34E1F0391C80cC0E',
    feeManager: '0xcE1260DF73dEEbD71A869CC4E9A2006994f3E5E2',
    graduationManager: '0x3A17cD90e34EBae71D92013f763FD01bAef1efdc',
    launchHook: '0x87e6BaBAc4598F99f4A0717ad294934455Fe60cc',
    ...SHARED,
  }),
  agents: null,
});

export const NETWORKS = Object.freeze({ mainnet: MAINNET, testnet: TESTNET });
export const LOCAL_CHAIN_ID = 31337;

export interface LocalBookJson {
  chainId: number;
  launchFactory: Address;
  feeManager: Address;
  graduationManager: Address;
  launchHook: Address;
  poolManager: Address;
  permit2: Address;
  universalRouter: Address;
  v4Quoter: Address;
  usdc: Address;
  agentFactory: Address;
  agentImplementation: Address;
  agentRegistry: Address;
  agentFactoryCodeHash: Hex;
  agentImplementationCodeHash: Hex;
  agentRegistryCodeHash: Hex;
  deployBlock: number;
}

/** A book for the loopback Anvil deployment written by scripts/local-chain.sh. Only chain 31337 is accepted. */
export const localNetwork = (json: LocalBookJson): NetworkBook => {
  if (json.chainId !== LOCAL_CHAIN_ID) throw new NetworkMismatchError(`a local address book must be for chain ${LOCAL_CHAIN_ID} (Anvil), not ${json.chainId}`);
  return {
    name: 'local',
    chainId: LOCAL_CHAIN_ID,
    defaultRpcUrl: 'http://127.0.0.1:8545',
    apiBaseUrl: null,
    apiKeyPrefix: null,
    launch: {
      factory: json.launchFactory, feeManager: json.feeManager, graduationManager: json.graduationManager, launchHook: json.launchHook,
      poolManager: json.poolManager, permit2: json.permit2, universalRouter: json.universalRouter, v4Quoter: json.v4Quoter, usdc: json.usdc,
    },
    agents: {
      factory: json.agentFactory, implementation: json.agentImplementation, registry: json.agentRegistry,
      factoryCodeHash: json.agentFactoryCodeHash, implementationCodeHash: json.agentImplementationCodeHash,
      registryCodeHash: json.agentRegistryCodeHash, deployBlock: BigInt(json.deployBlock),
    },
  };
};

export const isLoopbackUrl = (url: string): boolean => {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
};
