import type { Address, PublicClient, WalletClient } from "viem";
import { createPublicClient, http } from "viem";

import { getConfig, type MemonexNetwork } from "./config.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Known ERC-8004 registry addresses per network.
 *
 * NOTE: Base Sepolia addresses are placeholders until official deployments are confirmed.
 */
export const ERC8004_REGISTRIES = {
  "base-sepolia": {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  },
  base: {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  },
} as const satisfies Record<MemonexNetwork, RegistryAddresses>;

const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

// Minimal ABI for ERC-8004 identity registry interactions.
const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "agentIdOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// Minimal ABI for marketplace ERC-8004 helpers.
const MEMONEX_MARKET_ABI = [
  {
    type: "function",
    name: "getSellerAgentId",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "registerSeller",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "identityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * ERC-8004 agent registration JSON payload.
 */
export interface AgentRegistrationFile {
  type: string;
  name: string;
  description: string;
  image?: string;
  services: AgentService[];
  x402Support: boolean;
  active: boolean;
  registrations: AgentRegistration[];
  supportedTrust: string[];
}

/**
 * Service entry exposed by an agent registration file.
 */
export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}

/**
 * On-chain registry reference for the agent.
 */
export interface AgentRegistration {
  agentId: number;
  agentRegistry: string;
}

/**
 * ERC-8004 registry addresses for a chain.
 */
export type RegistryAddresses = {
  identityRegistry: Address;
  reputationRegistry: Address;
  validationRegistry: Address;
};

/**
 * Build an ERC-8004 registration file for a Memonex agent.
 */
export function buildAgentRegistrationFile(params: {
  name: string;
  description: string;
  sellerAddress: string;
  marketplaceUrl?: string;
  mcpEndpoint?: string;
  a2aEndpoint?: string;
}): AgentRegistrationFile {
  const services: AgentService[] = [];

  const marketplaceEndpoint =
    params.marketplaceUrl ?? `https://memonex.ai/seller/${params.sellerAddress}`;
  services.push({ name: "MemonexMarketplace", endpoint: marketplaceEndpoint });

  if (params.mcpEndpoint) {
    services.push({ name: "MCP", endpoint: params.mcpEndpoint });
  }

  if (params.a2aEndpoint) {
    services.push({ name: "A2A", endpoint: params.a2aEndpoint });
  }

  return {
    type: REGISTRATION_TYPE,
    name: params.name,
    description: params.description,
    services,
    x402Support: false,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"],
  };
}

/**
 * Look up a seller's ERC-8004 agentId via the marketplace contract.
 */
export async function getSellerAgentId(
  client: PublicClient,
  sellerAddress: Address
): Promise<bigint> {
  const config = getConfig(client.chain?.id);
  return (await client.readContract({
    address: config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerAgentId",
    args: [sellerAddress],
  })) as bigint;
}

/**
 * Register an agent directly in the ERC-8004 identity registry.
 */
export async function registerAgent(
  walletClient: WalletClient,
  agentURI: string
): Promise<bigint> {
  const config = getConfig(walletClient.chain?.id);
  const registry = resolveRegistryAddresses(config.network);

  if (registry.identityRegistry === ZERO_ADDRESS) {
    throw new Error("ERC-8004 identity registry address is not configured.");
  }

  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrls[0]),
  });

  const account = walletClient.account?.address;
  if (!account) {
    throw new Error("walletClient.account is required to register an agent.");
  }

  const sim = await publicClient.simulateContract({
    address: registry.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "register",
    args: [agentURI],
    account,
  });

  const { account: _account, ...request } = sim.request;
  const hash = await walletClient.writeContract({
    ...(request as any),
    chain: config.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return sim.result as bigint;
}

/**
 * Register the caller as an ERC-8004 agent via the marketplace contract.
 * Calls `marketplace.registerSeller(agentURI)` which mints an identity NFT
 * and caches the agentId in the marketplace.
 */
export async function registerSellerOnMarket(
  walletClient: WalletClient,
  agentURI: string,
): Promise<bigint> {
  const config = getConfig(walletClient.chain?.id);
  const publicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrls[0]),
  });

  const account = walletClient.account?.address;
  if (!account) {
    throw new Error("walletClient.account is required to register as a seller.");
  }

  const sim = await publicClient.simulateContract({
    address: config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "registerSeller",
    args: [agentURI],
    account,
  });

  const { account: _account2, ...request2 } = sim.request;
  const hash = await walletClient.writeContract({
    ...(request2 as any),
    chain: config.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return sim.result as bigint;
}

/**
 * Fetch and parse an agent's ERC-8004 registration file from the identity registry.
 */
export async function getAgentRegistrationFile(
  client: PublicClient,
  agentId: bigint
): Promise<AgentRegistrationFile | null> {
  const config = getConfig(client.chain?.id);
  let identityRegistry = resolveRegistryAddresses(config.network).identityRegistry;

  // Prefer the registry configured on-chain in the marketplace if available.
  try {
    const marketIdentity = (await client.readContract({
      address: config.addresses.market,
      abi: MEMONEX_MARKET_ABI,
      functionName: "identityRegistry",
      args: [],
    })) as Address;
    if (marketIdentity && marketIdentity !== ZERO_ADDRESS) {
      identityRegistry = marketIdentity;
    }
  } catch {
    // ignore and fall back to the local config
  }

  if (!identityRegistry || identityRegistry === ZERO_ADDRESS) return null;

  let tokenUri: string;
  try {
    tokenUri = (await client.readContract({
      address: identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "tokenURI",
      args: [agentId],
    })) as string;
  } catch {
    return null;
  }

  const gateway = config.defaultIpfsGateways[0] ?? "https://ipfs.io/ipfs/";
  const url = resolveTokenUri(tokenUri, gateway);

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as AgentRegistrationFile;
    return json;
  } catch {
    return null;
  }
}

function resolveRegistryAddresses(network: MemonexNetwork): RegistryAddresses {
  const base = ERC8004_REGISTRIES[network] ?? {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  };

  const envIdentity = readEnvAddress("MEMONEX_IDENTITY_REGISTRY")
    ?? readEnvAddress("IDENTITY_REGISTRY");
  const envReputation = readEnvAddress("MEMONEX_REPUTATION_REGISTRY")
    ?? readEnvAddress("REPUTATION_REGISTRY");
  const envValidation = readEnvAddress("MEMONEX_VALIDATION_REGISTRY")
    ?? readEnvAddress("VALIDATION_REGISTRY");

  return {
    identityRegistry: envIdentity ?? base.identityRegistry,
    reputationRegistry: envReputation ?? base.reputationRegistry,
    validationRegistry: envValidation ?? base.validationRegistry,
  };
}

function readEnvAddress(key: string): Address | undefined {
  const value = process.env[key]?.trim();
  if (!value) return undefined;
  return value as Address;
}

function resolveTokenUri(uri: string, gatewayBase: string): string {
  if (uri.startsWith("ipfs://")) {
    let cid = uri.slice("ipfs://".length);
    if (cid.startsWith("ipfs/")) cid = cid.slice("ipfs/".length);

    let base = gatewayBase.trim();
    if (!base) base = "https://ipfs.io/ipfs/";
    if (!base.endsWith("/")) base += "/";
    if (!base.includes("/ipfs/")) base = base.replace(/\/$/, "") + "/ipfs/";

    return `${base}${cid}`;
  }
  return uri;
}
