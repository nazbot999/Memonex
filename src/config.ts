import type { Address, Chain, Hex } from "viem";
import { defineChain } from "viem";
import { base, baseSepolia } from "viem/chains";

export type MemonexNetwork = "base-sepolia" | "base" | "monad" | "monad-testnet";

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://monadscan.com" } },
});

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" } },
  testnet: true,
});

export type MemonexAddresses = {
  market: Address;
  usdc: Address;
  eas: Address;
  settlementSchemaUid?: Hex;
  ratingSchemaUid?: Hex;
  identityRegistry?: Address;
  reputationRegistry?: Address;
  validationRegistry?: Address;
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
      market: "0xc774bD9d2C043a09f4eE4b76fE308E986aFf0aD9",
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      eas: "0x4200000000000000000000000000000000000021",
      identityRegistry: "0x7177a6867296406881E20d6647232314736Dd09A",
      reputationRegistry: "0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322",
      validationRegistry: "0x662b40A526cb4017d947e71eAF6753BF3eeE66d8",
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
  monad: {
    network: "monad",
    chain: monad,
    chainId: 143,
    rpcUrls: ["https://rpc.monad.xyz"],
    explorerBaseUrl: "https://monadscan.com",
    addresses: {
      market: "0x0000000000000000000000000000000000000000",
      usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      eas: "0x0000000000000000000000000000000000000000",
    },
    defaultIpfsGateways: [
      "https://cloudflare-ipfs.com/ipfs/",
      "https://gateway.pinata.cloud/ipfs/",
      "https://ipfs.io/ipfs/",
    ],
  },
  "monad-testnet": {
    network: "monad-testnet",
    chain: monadTestnet,
    chainId: 10143,
    rpcUrls: ["https://testnet-rpc.monad.xyz"],
    explorerBaseUrl: "https://testnet.monadexplorer.com",
    addresses: {
      market: "0x0000000000000000000000000000000000000000",
      usdc: "0x0000000000000000000000000000000000000000",
      eas: "0x0000000000000000000000000000000000000000",
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
  if (chainId === 143) return "monad";
  if (chainId === 10143) return "monad-testnet";
  return undefined;
}

function getEnvNetwork(): MemonexNetwork | undefined {
  const env = process.env.MEMONEX_NETWORK?.trim();
  if (env === "base" || env === "base-sepolia" || env === "monad" || env === "monad-testnet") return env;
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

  const identityRegistry =
    parseAddress(process.env.MEMONEX_IDENTITY_REGISTRY)
    ?? parseAddress(process.env.IDENTITY_REGISTRY);

  const reputationRegistry =
    parseAddress(process.env.MEMONEX_REPUTATION_REGISTRY)
    ?? parseAddress(process.env.REPUTATION_REGISTRY);

  const validationRegistry =
    parseAddress(process.env.MEMONEX_VALIDATION_REGISTRY)
    ?? parseAddress(process.env.VALIDATION_REGISTRY);

  const addresses: Partial<MemonexAddresses> = {};
  if (market) addresses.market = market;
  if (usdc) addresses.usdc = usdc;
  if (eas) addresses.eas = eas;
  if (settlementSchemaUid) addresses.settlementSchemaUid = settlementSchemaUid;
  if (ratingSchemaUid) addresses.ratingSchemaUid = ratingSchemaUid;
  if (identityRegistry) addresses.identityRegistry = identityRegistry;
  if (reputationRegistry) addresses.reputationRegistry = reputationRegistry;
  if (validationRegistry) addresses.validationRegistry = validationRegistry;

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
