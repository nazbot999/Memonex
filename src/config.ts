import type { Address, Chain, Hex } from "viem";
import { base, baseSepolia } from "viem/chains";

export type MemonexNetwork = "base-sepolia" | "base";

export type MemonexAddresses = {
  market: Address;
  usdc: Address;
  eas: Address;
  settlementSchemaUid?: Hex;
  ratingSchemaUid?: Hex;
};

export type MemonexChainConfig = {
  network: MemonexNetwork;
  chain: Chain;
  chainId: number;
  rpcUrls: string[];
  explorerBaseUrl: string;
  addresses: MemonexAddresses;
  defaultIpfsGateways: string[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const DEFAULT_CONFIGS: Record<MemonexNetwork, MemonexChainConfig> = {
  "base-sepolia": {
    network: "base-sepolia",
    chain: baseSepolia,
    chainId: 84532,
    rpcUrls: ["https://sepolia.base.org"],
    explorerBaseUrl: "https://sepolia.basescan.org",
    addresses: {
      market: "0x4507789a434d51480a22900D789CDcef43509603",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      eas: "0x4200000000000000000000000000000000000021",
    },
    defaultIpfsGateways: [
      "https://cloudflare-ipfs.com/ipfs/",
      "https://gateway.pinata.cloud/ipfs/",
      "https://ipfs.io/ipfs/",
    ],
  },
  base: {
    network: "base",
    chain: base,
    chainId: 8453,
    rpcUrls: ["https://mainnet.base.org"],
    explorerBaseUrl: "https://basescan.org",
    addresses: {
      market: "0x0000000000000000000000000000000000000000",
      usdc: "0x0000000000000000000000000000000000000000",
      eas: "0x4200000000000000000000000000000000000021",
    },
    defaultIpfsGateways: [
      "https://cloudflare-ipfs.com/ipfs/",
      "https://gateway.pinata.cloud/ipfs/",
      "https://ipfs.io/ipfs/",
    ],
  },
};

function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function parseChainId(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseAddress(value?: string): Address | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed as Address;
}

function parseHex(value?: string): Hex | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed as Hex;
}

function resolveNetworkFromChainId(chainId?: number): MemonexNetwork | undefined {
  if (chainId === 84532) return "base-sepolia";
  if (chainId === 8453) return "base";
  return undefined;
}

function getEnvNetwork(): MemonexNetwork | undefined {
  const env = process.env.MEMONEX_NETWORK?.trim();
  if (env === "base" || env === "base-sepolia") return env;
  return undefined;
}

function getEnvOverrides(): Partial<MemonexChainConfig> {
  const rpcUrls =
    parseCsv(process.env.MEMONEX_RPC_URLS)
    ?? parseCsv(process.env.RPC_URLS)
    ?? (process.env.RPC_URL ? [process.env.RPC_URL.trim()].filter(Boolean) : undefined);

  const defaultIpfsGateways =
    parseCsv(process.env.MEMONEX_IPFS_GATEWAYS)
    ?? parseCsv(process.env.IPFS_GATEWAYS);

  const chainId =
    parseChainId(process.env.MEMONEX_CHAIN_ID)
    ?? parseChainId(process.env.CHAIN_ID);

  const market =
    parseAddress(process.env.MEMONEX_MARKET_ADDRESS)
    ?? parseAddress(process.env.CONTRACT_ADDRESS)
    ?? parseAddress(process.env.MEMONEX_CONTRACT_ADDRESS);

  const usdc =
    parseAddress(process.env.MEMONEX_USDC_ADDRESS)
    ?? parseAddress(process.env.USDC_ADDRESS);

  const eas =
    parseAddress(process.env.MEMONEX_EAS_ADDRESS)
    ?? parseAddress(process.env.EAS_ADDRESS);

  const settlementSchemaUid =
    parseHex(process.env.MEMONEX_SETTLEMENT_SCHEMA_UID)
    ?? parseHex(process.env.SETTLEMENT_SCHEMA_UID);

  const ratingSchemaUid =
    parseHex(process.env.MEMONEX_RATING_SCHEMA_UID)
    ?? parseHex(process.env.RATING_SCHEMA_UID);

  const addresses: Partial<MemonexAddresses> = {};
  if (market) addresses.market = market;
  if (usdc) addresses.usdc = usdc;
  if (eas) addresses.eas = eas;
  if (settlementSchemaUid) addresses.settlementSchemaUid = settlementSchemaUid;
  if (ratingSchemaUid) addresses.ratingSchemaUid = ratingSchemaUid;

  return {
    chainId,
    rpcUrls,
    defaultIpfsGateways,
    addresses: Object.keys(addresses).length > 0 ? addresses as Partial<MemonexAddresses> : undefined,
  } as Partial<MemonexChainConfig>;
}

function mergeAddresses(
  base: MemonexAddresses,
  env?: Partial<MemonexAddresses>,
  override?: Partial<MemonexAddresses>
): MemonexAddresses {
  return {
    ...base,
    ...(env ?? {}),
    ...(override ?? {}),
  };
}

function validateRequiredAddresses(addresses: MemonexAddresses): void {
  const required: Array<[string, Address]> = [
    ["market", addresses.market],
    ["usdc", addresses.usdc],
    ["eas", addresses.eas],
  ];
  for (const [name, addr] of required) {
    if (addr === ZERO_ADDRESS) {
      throw new ConfigError(`Missing required address for ${name}`);
    }
  }
}

export function resolveMemonexConfig(partial?: Partial<MemonexChainConfig>): MemonexChainConfig {
  const envNetwork = getEnvNetwork();
  const envChainId = parseChainId(process.env.MEMONEX_CHAIN_ID) ?? parseChainId(process.env.CHAIN_ID);

  const networkFromPartialChain = resolveNetworkFromChainId(partial?.chainId);
  const baseNetwork = partial?.network ?? envNetwork ?? networkFromPartialChain ?? "base-sepolia";
  const baseConfig = DEFAULT_CONFIGS[baseNetwork];

  if (envNetwork && envChainId && envChainId !== baseConfig.chainId) {
    throw new ConfigError(`MEMONEX_CHAIN_ID ${envChainId} does not match ${envNetwork}`);
  }

  if (partial?.chainId) {
    const inferred = resolveNetworkFromChainId(partial.chainId);
    if (inferred && inferred !== baseNetwork) {
      throw new ConfigError(`chainId ${partial.chainId} does not match network ${baseNetwork}`);
    }
  }

  const envOverrides = getEnvOverrides();

  const merged: MemonexChainConfig = {
    ...baseConfig,
    ...envOverrides,
    ...partial,
    network: baseNetwork,
    chain: partial?.chain ?? baseConfig.chain,
    chainId: partial?.chainId ?? envOverrides.chainId ?? baseConfig.chainId,
    rpcUrls: partial?.rpcUrls ?? envOverrides.rpcUrls ?? baseConfig.rpcUrls,
    explorerBaseUrl: partial?.explorerBaseUrl ?? envOverrides.explorerBaseUrl ?? baseConfig.explorerBaseUrl,
    defaultIpfsGateways:
      partial?.defaultIpfsGateways
      ?? envOverrides.defaultIpfsGateways
      ?? baseConfig.defaultIpfsGateways,
    addresses: mergeAddresses(baseConfig.addresses, envOverrides.addresses, partial?.addresses),
  };

  validateRequiredAddresses(merged.addresses);
  return merged;
}

export function getConfig(chainId?: number): MemonexChainConfig {
  if (chainId != null) {
    const network = resolveNetworkFromChainId(chainId);
    if (!network) throw new ConfigError(`Unsupported chainId ${chainId}`);
    return resolveMemonexConfig({ network, chainId });
  }
  return resolveMemonexConfig();
}
