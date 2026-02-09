import type { Address, PublicClient, WalletClient } from "viem";
import { createPublicClient, http } from "viem";

import { getConfig, type MemonexNetwork } from "./config.js";
import type { AgentTrustScore, ReputationSummary, ValidationSummary } from "./types.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Known ERC-8004 registry addresses per network.
 *
 * Base Sepolia: live nuwa-protocol/nuwa-8004 registries (CREATE2 deterministic).
 * Monad: not yet deployed — graceful degradation via zero addresses.
 */
export const ERC8004_REGISTRIES = {
  "base-sepolia": {
    identityRegistry: "0x7177a6867296406881E20d6647232314736Dd09A" as Address,
    reputationRegistry: "0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322" as Address,
    validationRegistry: "0x662b40A526cb4017d947e71eAF6753BF3eeE66d8" as Address,
  },
  base: {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  },
  monad: {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  },
  "monad-testnet": {
    identityRegistry: ZERO_ADDRESS,
    reputationRegistry: ZERO_ADDRESS,
    validationRegistry: ZERO_ADDRESS,
  },
} as const satisfies Record<MemonexNetwork, RegistryAddresses>;

const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

// Spec-compliant ABI for ERC-8004 identity registry.
const IDENTITY_REGISTRY_ABI = [
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
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getMetadata",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
  {
    type: "function",
    name: "setMetadata",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
      { name: "value", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "setAgentWallet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "wallet", type: "address" },
    ],
    outputs: [],
  },
] as const;

// Spec-compliant ABI for ERC-8004 reputation registry.
const REPUTATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddresses", type: "address[]" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "summaryValue", type: "int256" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "readFeedback",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
      { name: "feedbackIndex", type: "uint256" },
    ],
    outputs: [
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
      { name: "revoked", type: "bool" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "revokeFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "feedbackIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getClients",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "client", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Spec-compliant ABI for ERC-8004 validation registry.
const VALIDATION_REGISTRY_ABI = [
  {
    type: "function",
    name: "validationRequest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "requestURI", type: "string" },
      { name: "requestHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "validationResponse",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestHash", type: "bytes32" },
      { name: "response", type: "uint8" },
      { name: "responseURI", type: "string" },
      { name: "responseHash", type: "bytes32" },
      { name: "tag", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getValidationStatus",
    stateMutability: "view",
    inputs: [{ name: "requestHash", type: "bytes32" }],
    outputs: [
      { name: "requestor", type: "address" },
      { name: "validator", type: "address" },
      { name: "agentId", type: "uint256" },
      { name: "response", type: "uint8" },
      { name: "tag", type: "string" },
      { name: "responded", type: "bool" },
      { name: "requestedAt", type: "uint256" },
      { name: "respondedAt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "validators", type: "address[]" },
      { name: "tag", type: "string" },
    ],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "averageResponse", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getAgentValidations",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32[]" }],
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
  {
    type: "function",
    name: "getSellerReputation",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "summaryValue", type: "int256" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getSellerValidationSummary",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "averageResponse", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getValidationRequestHash",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
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

/**
 * Get aggregated reputation summary for an agent from the reputation registry.
 */
export async function getAgentReputationSummary(
  client: PublicClient,
  agentId: bigint,
  tag1: string = "",
  tag2: string = "",
): Promise<ReputationSummary> {
  const config = getConfig(client.chain?.id);
  const registry = resolveRegistryAddresses(config.network);

  if (registry.reputationRegistry === ZERO_ADDRESS) {
    return { count: 0n, summaryValue: 0n, summaryValueDecimals: 0 };
  }

  try {
    const result = await client.readContract({
      address: registry.reputationRegistry,
      abi: REPUTATION_REGISTRY_ABI,
      functionName: "getSummary",
      args: [agentId, [], tag1, tag2],
    });
    const [count, summaryValue, summaryValueDecimals] = result as [bigint, bigint, number];
    return { count, summaryValue, summaryValueDecimals };
  } catch {
    return { count: 0n, summaryValue: 0n, summaryValueDecimals: 0 };
  }
}

/**
 * Get aggregated validation summary for an agent from the validation registry.
 */
export async function getAgentValidationSummary(
  client: PublicClient,
  agentId: bigint,
  validators: Address[] = [],
  tag: string = "",
): Promise<ValidationSummary> {
  const config = getConfig(client.chain?.id);
  const registry = resolveRegistryAddresses(config.network);

  if (registry.validationRegistry === ZERO_ADDRESS) {
    return { count: 0n, averageResponse: 0n };
  }

  try {
    const result = await client.readContract({
      address: registry.validationRegistry,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: "getSummary",
      args: [agentId, validators, tag],
    });
    const [count, averageResponse] = result as [bigint, bigint];
    return { count, averageResponse };
  } catch {
    return { count: 0n, averageResponse: 0n };
  }
}

/**
 * Get a metadata value for an agent from the identity registry.
 */
export async function getAgentMetadata(
  client: PublicClient,
  agentId: bigint,
  key: string,
): Promise<`0x${string}` | null> {
  const config = getConfig(client.chain?.id);
  const registry = resolveRegistryAddresses(config.network);

  if (registry.identityRegistry === ZERO_ADDRESS) return null;

  try {
    const result = await client.readContract({
      address: registry.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getMetadata",
      args: [agentId, key],
    });
    return result as `0x${string}`;
  } catch {
    return null;
  }
}

/**
 * Set a metadata key/value for an agent on the identity registry.
 */
export async function setAgentMetadata(
  walletClient: WalletClient,
  agentId: bigint,
  key: string,
  value: `0x${string}`,
): Promise<void> {
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
    throw new Error("walletClient.account is required.");
  }

  const sim = await publicClient.simulateContract({
    address: registry.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "setMetadata",
    args: [agentId, key, value],
    account,
  });

  const { account: _account, ...request } = sim.request;
  const hash = await walletClient.writeContract({
    ...(request as any),
    chain: config.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

/**
 * Composite trust score combining reputation and validation data.
 */
export async function getAgentTrustScore(
  client: PublicClient,
  agentId: bigint,
): Promise<AgentTrustScore> {
  const [rep, val] = await Promise.all([
    getAgentReputationSummary(client, agentId, "memonex", "memory-trade"),
    getAgentValidationSummary(client, agentId),
  ]);

  const averageRating = rep.count > 0n
    ? Number(rep.summaryValue) / Number(rep.count)
    : 0;

  const validationPassRate = val.count > 0n
    ? Number(val.averageResponse)
    : 0;

  // Composite: 60% reputation + 40% validation (normalized to 0-1 scale)
  const normalizedRating = averageRating / 5; // ratings are 1-5
  const compositeScore = rep.count > 0n || val.count > 0n
    ? normalizedRating * 0.6 + validationPassRate * 0.4
    : 0;

  return {
    reputationCount: rep.count,
    averageRating,
    validationCount: val.count,
    validationPassRate,
    compositeScore,
  };
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
