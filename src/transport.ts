import { fallback, http, type Transport } from "viem";
import type { MemonexChainConfig, MemonexNetwork } from "./config.js";

function parseRpcUrls(env?: string): string[] {
  if (!env) return [];
  return env
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function alchemyUrl(network: MemonexNetwork, apiKey: string): string {
  return network === "base"
    ? `https://base-mainnet.g.alchemy.com/v2/${apiKey}`
    : `https://base-sepolia.g.alchemy.com/v2/${apiKey}`;
}

function quicknodeUrl(network: MemonexNetwork): string | undefined {
  const raw =
    network === "base"
      ? process.env.QUICKNODE_BASE_URL
      : process.env.QUICKNODE_BASE_SEPOLIA_URL;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function publicRpcUrl(network: MemonexNetwork): string {
  return network === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org";
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function getRpcUrls(config: MemonexChainConfig): string[] {
  const urls: string[] = [];

  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  if (alchemyKey) {
    urls.push(alchemyUrl(config.network, alchemyKey));
  }

  const quicknode = quicknodeUrl(config.network);
  if (quicknode) urls.push(quicknode);

  const envRpcUrls =
    parseRpcUrls(process.env.MEMONEX_RPC_URLS)
    .concat(parseRpcUrls(process.env.RPC_URLS))
    .concat(process.env.RPC_URL ? [process.env.RPC_URL.trim()].filter(Boolean) : []);
  if (envRpcUrls.length) urls.push(...envRpcUrls);

  if (config.rpcUrls?.length) urls.push(...config.rpcUrls);

  urls.push(publicRpcUrl(config.network));

  return dedupe(urls);
}

export function createFallbackTransport(config: MemonexChainConfig): Transport {
  const urls = getRpcUrls(config);
  const transports = urls.map((u) => http(u, { timeout: 15_000 }));

  return fallback(transports, {
    rank: true,
    retryCount: 3,
    retryDelay: 500,
  });
}
