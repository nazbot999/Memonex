import type { Address } from "viem";

import { resolveMemonexConfig } from "./config.js";
import { clamp01 } from "./utils.js";
import type { SellerStatsV2 } from "./types.js";
import { computeAverageRating, getSellerStats, type Clients } from "./contract.js";

export type SellerAttestation = {
  uid: string;
  schema: string;
  recipient: Address;
  attester: Address;
  timeCreated: number;
  refUID?: string;
  data: string;
};

export type SellerPredicate = {
  minRating?: number;
  minSales?: number;
  maxRefundRate?: number;
  maxCancelRate?: number;
};

export type SellerIdentity = {
  stats: SellerStatsV2;
  attestations: SellerAttestation[];
};

export type SellerProfile = {
  seller: Address;
  stats: SellerStatsV2;
  avgRating: number;
  trustScore: number;
  refundRate: number;
  cancelRate: number;
};

type EasGraphqlResponse = {
  data?: {
    attestations?: Array<{
      id?: string;
      uid?: string;
      schema: string;
      recipient: string;
      attester: string;
      timeCreated: number | string;
      refUID?: string | null;
      data: string;
    }>;
  };
  errors?: Array<{ message: string }>;
};

async function fetchAttestations(params: {
  recipient: Address;
  schemas: string[];
  easGraphqlUrl: string;
}): Promise<SellerAttestation[]> {
  if (params.schemas.length === 0) return [];

  const query = `
    query Attestations($recipient: String!, $schemas: [String!]) {
      attestations(
        where: { recipient: { equals: $recipient }, schema: { in: $schemas } }
        orderBy: { timeCreated: desc }
      ) {
        id
        uid
        schema
        recipient
        attester
        timeCreated
        refUID
        data
      }
    }
  `;

  const res = await fetch(params.easGraphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { recipient: params.recipient, schemas: params.schemas },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`EAS GraphQL request failed (${params.easGraphqlUrl}): ${res.status} ${res.statusText} ${text}`.trim());
  }

  const json = (await res.json()) as EasGraphqlResponse;
  if (json.errors?.length) {
    throw new Error(`EAS GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const items = json.data?.attestations ?? [];
  return items.map((att) => ({
    uid: att.uid ?? att.id ?? "",
    schema: att.schema,
    recipient: att.recipient as Address,
    attester: att.attester as Address,
    timeCreated: typeof att.timeCreated === "string" ? Number(att.timeCreated) : att.timeCreated,
    refUID: att.refUID ?? undefined,
    data: att.data,
  }));
}

export async function getSellerIdentity(params: {
  clients: Clients;
  seller: Address;
  easGraphqlUrl?: string;
}): Promise<SellerIdentity> {
  const config = resolveMemonexConfig();
  const stats = await getSellerStats({ clients: params.clients, seller: params.seller });

  const schemas = ([
    config.addresses.settlementSchemaUid,
    config.addresses.ratingSchemaUid,
  ] as Array<string | undefined>).filter((v): v is string => typeof v === "string" && v.length > 0);

  const easGraphqlUrl = params.easGraphqlUrl ?? "https://base.easscan.org/graphql";
  const attestations = await fetchAttestations({
    recipient: params.seller,
    schemas,
    easGraphqlUrl,
  });

  return { stats, attestations };
}

function computeRates(stats: SellerStatsV2): { refundRate: number; cancelRate: number } {
  const totalSales = Math.max(1, Number(stats.totalSales));
  return {
    refundRate: Number(stats.refundCount) / totalSales,
    cancelRate: Number(stats.cancelCount) / totalSales,
  };
}

export function computeTrustScore(stats: SellerStatsV2): number {
  const avgRating = computeAverageRating(stats);

  const ratingScore = avgRating / 5;
  const salesScore = clamp01(Math.log10(Number(stats.totalSales) + 1) / Math.log10(50));
  const volumeUsdc = Number(stats.totalVolume) / 1_000_000;
  const volumeScore = clamp01(Math.log10(volumeUsdc + 1) / Math.log10(100_000));

  const { refundRate, cancelRate } = computeRates(stats);
  const refundScore = clamp01(1 - refundRate);
  const cancelScore = clamp01(1 - cancelRate);

  const deliveryHours = Number(stats.avgDeliveryTime) / 3600;
  const deliveryScore = clamp01(1 - deliveryHours / 72);

  const trustScore = Math.round(
    100 * (
      0.45 * ratingScore +
      0.2 * salesScore +
      0.1 * volumeScore +
      0.15 * deliveryScore +
      0.05 * refundScore +
      0.05 * cancelScore
    )
  );

  return trustScore;
}

export async function getSellerProfile(params: {
  clients: Clients;
  seller: Address;
}): Promise<SellerProfile> {
  const stats = await getSellerStats({ clients: params.clients, seller: params.seller });
  const avgRating = computeAverageRating(stats);
  const trustScore = computeTrustScore(stats);
  const { refundRate, cancelRate } = computeRates(stats);

  return {
    seller: params.seller,
    stats,
    avgRating,
    trustScore,
    refundRate,
    cancelRate,
  };
}

export function sellerMeetsPredicate(stats: SellerStatsV2, pred: SellerPredicate): boolean {
  const avgRating = computeAverageRating(stats);
  const { refundRate, cancelRate } = computeRates(stats);

  if (pred.minRating != null && avgRating < pred.minRating) return false;
  if (pred.minSales != null && Number(stats.totalSales) < pred.minSales) return false;
  if (pred.maxRefundRate != null && refundRate > pred.maxRefundRate) return false;
  if (pred.maxCancelRate != null && cancelRate > pred.maxCancelRate) return false;

  return true;
}

export function filterSellersByPredicate<T extends { stats: SellerStatsV2 }>(
  sellers: T[],
  pred: SellerPredicate
): T[] {
  return sellers.filter((seller) => sellerMeetsPredicate(seller.stats, pred));
}
