/**
 * seed.ts — Create 5 diverse demo listings on Base Sepolia so the explore page has content.
 *
 * Usage:
 *   npx tsx src/seed.ts
 *
 * Requires: MEMONEX_PRIVATE_KEY (or PRIVATE_KEY / DEPLOYER_PRIVATE_KEY) in .env
 */

import dotenv from "dotenv";
import type { Hex } from "viem";

import {
  MEMONEX_MARKET,
  createClients,
  formatUsdc,
  listMemory,
  parseUsdc,
} from "./contract.js";
import { computeCanonicalKeccak256, nowIso } from "./utils.js";
import { createIpfsClient } from "./ipfs.js";

dotenv.config();

function asHexPrivateKey(input: string): Hex {
  const s = input.trim();
  if (s.length === 0) throw new Error("Empty private key");
  const hex = s.startsWith("0x") ? s : ("0x" + s);
  return hex as Hex;
}

const SEED_LISTINGS = [
  {
    title: "DeFi liquidation playbook for volatile markets",
    description: "Strategies and heuristics for identifying liquidation opportunities in volatile DeFi markets, including MEV-aware execution and risk management.",
    topics: ["DeFi", "Risk", "Execution"],
    priceUsdc: "5",
    evalFeeUsdc: "0",
    deliveryHours: 24,
  },
  {
    title: "Infra scaling lessons from multi-agent pipelines",
    description: "Practical lessons learned from scaling multi-agent systems in production, covering orchestration, state management, and failure recovery.",
    topics: ["Infra", "Agents", "Scaling"],
    priceUsdc: "25",
    evalFeeUsdc: "0",
    deliveryHours: 12,
  },
  {
    title: "Prompt testing matrix for retrieval quality",
    description: "A comprehensive testing framework for evaluating RAG pipeline quality, including prompt templates, scoring rubrics, and benchmark datasets.",
    topics: ["RAG", "Evaluation"],
    priceUsdc: "100",
    evalFeeUsdc: "0",
    deliveryHours: 48,
  },
  {
    title: "On-chain go-to-market for AI SaaS founders",
    description: "GTM playbook for launching AI SaaS products with on-chain components, covering distribution, pricing, and community-driven growth.",
    topics: ["GTM", "Founders"],
    priceUsdc: "240",
    evalFeeUsdc: "0",
    deliveryHours: 72,
  },
  {
    title: "Agent memory architecture patterns",
    description: "Design patterns for agent memory systems including hierarchical memory, episodic recall, and knowledge graph integration.",
    topics: ["Memory", "Architecture"],
    priceUsdc: "500",
    evalFeeUsdc: "0",
    deliveryHours: 24,
  },
];

async function main(): Promise<void> {
  const pkRaw =
    process.env.MEMONEX_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY;

  if (!pkRaw) {
    throw new Error(
      "Missing private key. Set MEMONEX_PRIVATE_KEY (preferred) or PRIVATE_KEY / DEPLOYER_PRIVATE_KEY (fallback)."
    );
  }

  const clients = createClients(asHexPrivateKey(pkRaw));
  const ipfs = createIpfsClient();

  console.log("Memonex seed — creating demo listings");
  console.log("  market:", MEMONEX_MARKET);
  console.log("  seller:", clients.address);
  console.log("");

  for (const seed of SEED_LISTINGS) {
    const priceUSDC = parseUsdc(seed.priceUsdc);
    const evalFeeUSDC = parseUsdc(seed.evalFeeUsdc);
    const deliveryWindowSec = seed.deliveryHours * 3600;

    const contentObj = {
      title: seed.title,
      description: seed.description,
      topics: seed.topics,
      ts: nowIso(),
    };
    const contentHash = computeCanonicalKeccak256(contentObj);

    const publicPreview = {
      schema: "memonex.publicpreview.v1" as const,
      title: seed.title,
      description: seed.description,
      topics: seed.topics,
      audience: "agent" as const,
      price: seed.priceUsdc,
      evalFeePct: 0,
      deliveryWindowSec: deliveryWindowSec,
      seller: {
        address: clients.address,
      },
      stats: {
        insightCount: 0,
        createdAt: nowIso(),
      },
      integrity: {
        contentHash,
      },
    };
    const previewUp = await ipfs.uploadJSON(publicPreview, `seed-preview-${Date.now()}.json`);
    const envelopeUp = await ipfs.uploadJSON(
      { placeholder: true, title: seed.title },
      `seed-envelope-${Date.now()}.json`
    );

    console.log(`Listing: "${seed.title}" — ${seed.priceUsdc} USDC`);

    const listed = await listMemory({
      clients,
      contentHash,
      previewCID: previewUp.cid,
      encryptedCID: envelopeUp.cid,
      priceUSDC,
      evalFeeUSDC,
      deliveryWindowSec,
      prevListingId: 0n,
      discountBps: 0,
    });

    console.log(`  listingId: ${listed.listingId.toString()}  tx: ${listed.txHash}`);

    // Brief pause between listings to avoid nonce issues
    await new Promise((r) => setTimeout(r, 3000));
  }

  console.log("");
  console.log("Seed complete — 5 listings created.");
}

main().catch((err) => {
  console.error("Seed failed:");
  console.error(err);
  process.exitCode = 1;
});
