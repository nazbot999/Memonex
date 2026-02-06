import type { MemoryPackage, PreviewPackage } from "./types.js";

export type FearGreedIndex = {
  value: number;
  classification: string;
  fetchedAt: string;
  source: "alternative.me";
};

export type MarketRegime = {
  regime: "bull" | "bear" | "range" | "crisis";
  btc30dChangePct: number;
  eth30dChangePct: number;
  volatility30dPct: number;
  fetchedAt: string;
  source: "coingecko";
};

export type KeyEvent = {
  id: string;
  title: string;
  category: "macro" | "crypto" | "protocol";
  url?: string;
  timestamp: string;
  source: "cryptopanic" | "cryptocompare" | "manual";
};

export type AcquiredDuring = {
  start: string;
  end?: string;
  label?: string;
  source: "seller" | "auto";
};

export type ContextAwarePricing = {
  acquiredDuring: AcquiredDuring;
  macroContext: {
    fearGreed?: FearGreedIndex;
    marketRegime?: MarketRegime;
    keyEvents?: KeyEvent[];
  };
  decay: {
    model: "linear";
    decayDays: number;
    floorPct: number;
  };
};

export type PreviewPackageV2 = PreviewPackage & {
  schema: "memonex.preview.v2";
  contextAwarePricing?: ContextAwarePricing;
};

type FearGreedApiResponse = {
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
};

type CoinGeckoMarketChart = {
  prices: Array<[number, number]>;
};

type CryptoPanicResponse = {
  results: Array<{
    id: number | string;
    title: string;
    url?: string;
    published_at: string;
    kind?: string;
  }>;
};

type CryptoCompareResponse = {
  Data?: Array<{
    id: string;
    title: string;
    url?: string;
    published_on?: number;
    categories?: string;
  }>;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed (${url}): ${res.status} ${res.statusText} ${text}`.trim());
  }
  return (await res.json()) as T;
}

async function fetchFearGreed(): Promise<FearGreedIndex> {
  const url = "https://api.alternative.me/fng/?limit=1&format=json";
  const json = await fetchJson<FearGreedApiResponse>(url);
  const item = json.data?.[0];
  if (!item) throw new Error(`Fear & Greed API returned no data (${url})`);
  return {
    value: Number(item.value),
    classification: item.value_classification,
    fetchedAt: new Date().toISOString(),
    source: "alternative.me",
  };
}

function extractRecentPrices(prices: Array<[number, number]>, days: number): number[] {
  if (prices.length === 0) return [];
  const slice = prices.slice(-(days + 1));
  return slice.map((p) => p[1]);
}

function computeStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computePctChange(prices: number[]): number {
  if (prices.length < 2) return 0;
  const start = prices[0];
  const end = prices[prices.length - 1];
  if (start === 0) return 0;
  return ((end - start) / start) * 100;
}

function computeVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }
  const stdev = computeStdDev(returns);
  return stdev * Math.sqrt(365) * 100;
}

async function fetchMarketRegime(): Promise<MarketRegime> {
  const btcUrl = "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90";
  const ethUrl = "https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=90";

  const [btc, eth] = await Promise.all([
    fetchJson<CoinGeckoMarketChart>(btcUrl),
    fetchJson<CoinGeckoMarketChart>(ethUrl),
  ]);

  const btcPrices = extractRecentPrices(btc.prices ?? [], 30);
  const ethPrices = extractRecentPrices(eth.prices ?? [], 30);

  const btc30dChangePct = computePctChange(btcPrices);
  const eth30dChangePct = computePctChange(ethPrices);
  const volatility30dPct = computeVolatility(btcPrices);

  let regime: MarketRegime["regime"] = "range";
  if (btc30dChangePct <= -35 || volatility30dPct >= 120) regime = "crisis";
  else if (btc30dChangePct >= 20) regime = "bull";
  else if (btc30dChangePct <= -20) regime = "bear";

  return {
    regime,
    btc30dChangePct,
    eth30dChangePct,
    volatility30dPct,
    fetchedAt: new Date().toISOString(),
    source: "coingecko",
  };
}

function normalizeKeyEventCategory(raw?: string): "macro" | "crypto" | "protocol" {
  if (!raw) return "crypto";
  const lower = raw.toLowerCase();
  if (lower.includes("macro") || lower.includes("regulation")) return "macro";
  if (lower.includes("protocol") || lower.includes("defi")) return "protocol";
  return "crypto";
}

async function fetchKeyEvents(): Promise<KeyEvent[]> {
  const cryptopanicKey = process.env.CRYPTOPANIC_API_KEY?.trim();
  if (cryptopanicKey) {
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${cryptopanicKey}&public=true&currencies=BTC,ETH`;
    try {
      const json = await fetchJson<CryptoPanicResponse>(url);
      return (json.results ?? []).slice(0, 10).map((item) => ({
        id: String(item.id),
        title: item.title,
        category: normalizeKeyEventCategory(item.kind),
        url: item.url,
        timestamp: item.published_at,
        source: "cryptopanic",
      }));
    } catch {
      // fall through to CryptoCompare
    }
  }

  const fallbackUrl = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN";
  try {
    const json = await fetchJson<CryptoCompareResponse>(fallbackUrl);
    return (json.Data ?? []).slice(0, 10).map((item) => ({
      id: item.id,
      title: item.title,
      category: normalizeKeyEventCategory(item.categories),
      url: item.url,
      timestamp: item.published_on
        ? new Date(item.published_on * 1000).toISOString()
        : new Date().toISOString(),
      source: "cryptocompare",
    }));
  } catch {
    return [];
  }
}

function resolveAcquiredDuring(memoryPackage: MemoryPackage): AcquiredDuring {
  const range = memoryPackage.extraction?.spec?.timeRange;
  if (range?.since || range?.until) {
    return {
      start: range.since ?? memoryPackage.createdAt,
      end: range.until,
      source: "seller",
    };
  }

  return {
    start: memoryPackage.createdAt,
    source: "auto",
  };
}

export async function buildContextAwarePricing(params: {
  memoryPackage: MemoryPackage;
  decayDays?: number;
  floorPct?: number;
}): Promise<ContextAwarePricing> {
  const decayDays = params.decayDays ?? 90;
  const floorPct = params.floorPct ?? 0.4;

  const [fearGreed, marketRegime] = await Promise.all([
    fetchFearGreed(),
    fetchMarketRegime(),
  ]);

  const keyEvents = await fetchKeyEvents();

  return {
    acquiredDuring: resolveAcquiredDuring(params.memoryPackage),
    macroContext: {
      fearGreed,
      marketRegime,
      keyEvents: keyEvents.length ? keyEvents : undefined,
    },
    decay: {
      model: "linear",
      decayDays,
      floorPct,
    },
  };
}

export function computeDecayedPrice(params: {
  basePrice: bigint;
  context: ContextAwarePricing;
  now?: Date;
}): { price: bigint; pctOff: number; ageDays: number } {
  const now = params.now ?? new Date();
  const startAtStr = params.context.acquiredDuring.end ?? params.context.acquiredDuring.start;
  const startAt = new Date(startAtStr);
  const ageMs = Math.max(0, now.getTime() - startAt.getTime());
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const decayDays = Math.max(1, params.context.decay.decayDays);
  const floorPct = Math.min(1, Math.max(0, params.context.decay.floorPct));

  const linearFactor = 1 - Math.min(1, ageDays / decayDays);
  const factor = floorPct + (1 - floorPct) * linearFactor;
  const factorBps = Math.round(factor * 10_000);

  const price = (params.basePrice * BigInt(factorBps)) / 10_000n;
  const pctOff = Math.round((1 - factor) * 100);

  return { price, pctOff, ageDays: Math.floor(ageDays) };
}

export function formatDecayedPriceBadge(params: {
  pctOff: number;
  ageDays: number;
}): string {
  const sign = params.pctOff > 0 ? "-" : "";
  return `${sign}${Math.abs(params.pctOff)}% (aged ${params.ageDays}d)`;
}
