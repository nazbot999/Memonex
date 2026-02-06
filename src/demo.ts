import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";
import type { Hex } from "viem";

import type { ExtractionSpec, KeyCapsuleV1, MemoryPackage } from "./types.js";
import {
  MEMONEX_MARKET,
  createClients,
  formatUsdc,
  getListing,
  listMemory,
  parseUsdc,
  reserve,
  confirm,
  deliver,
} from "./contract.js";
import { extractRawItems, curateInsights, buildMemoryPackage } from "./memory.js";
import { sanitizeInsights } from "./privacy.js";
import { generatePreview } from "./preview.js";
import { createIpfsClient } from "./ipfs.js";
import {
  decodeKeyMaterialJson,
  decryptEnvelope,
  encodeKeyMaterialJson,
  encryptMemoryPackageToEnvelope,
  findSellerKeyRecordByContentHash,
  generateBuyerKeypair,
  loadBuyerKeypair,
  randomAesKey32,
  saveBuyerKeypair,
  sealKeyMaterialToRecipient,
  upsertSellerKeyRecord,
  openKeyCapsule,
} from "./crypto.js";
import {
  computeCanonicalKeccak256,
  computeSha256HexUtf8,
  ensureDir,
  nowIso,
  writeJsonFile,
} from "./utils.js";

// Load .env from current directory, parent, or explicit DOTENV_PATH
import { existsSync } from "node:fs";
const PRIVATE_ENV_PATH: string = process.env.DOTENV_PATH
  ?? (existsSync(".env") ? ".env"
    : existsSync("../.env") ? "../.env"
    : ".env");

function asHexPrivateKey(input: string): Hex {
  const s = input.trim();
  if (s.length === 0) throw new Error("Empty private key");
  const hex = s.startsWith("0x") ? s : ("0x" + s);
  return hex as Hex;
}

async function tryLoadEnvFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }
  dotenv.config({ path: filePath });
}

async function main(): Promise<void> {
  // Load environment from local .env file.
  dotenv.config();
  await tryLoadEnvFile(PRIVATE_ENV_PATH);

  const sellerPkRaw =
    process.env.MEMONEX_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    process.env.DEPLOYER_PRIVATE_KEY;
  if (!sellerPkRaw) {
    throw new Error(
      "Missing private key. Set MEMONEX_PRIVATE_KEY (preferred) or PRIVATE_KEY / DEPLOYER_PRIVATE_KEY (fallback)."
    );
  }

  const buyerPkRaw =
    process.env.MEMONEX_BUYER_PRIVATE_KEY ??
    process.env.BUYER_PRIVATE_KEY ??
    sellerPkRaw;

  const seller = createClients(asHexPrivateKey(sellerPkRaw));
  const buyer = createClients(asHexPrivateKey(buyerPkRaw));

  console.log("Memonex demo starting…");
  console.log("  market:", MEMONEX_MARKET);
  console.log("  seller:", seller.address);
  console.log("  buyer:", buyer.address);

  // -----------------------------
  // 1) Extract + curate
  // -----------------------------
  const spec: ExtractionSpec = {
    title: "Memonex Demo",
    description: "Demo extraction for the Memonex marketplace flow.",
    topics: ["memonex", "agents", "marketplace"],
    query: "Recent learnings that would help an agent ship faster",
    sources: [{ kind: "openclaw-memory", limit: 50 }],
    outputStyle: "lessons",
    constraints: { maxItems: 8, noPII: true, noSecrets: true },
  };

  let rawItems = await extractRawItems(spec);
  if (rawItems.length === 0) {
    rawItems = [
      {
        id: "raw:demo:inline",
        kind: "memory",
        source: { kind: "demo", ref: "inline" },
        timestamp: nowIso(),
        text: "Decision: Use a two-phase reserve/confirm unlock flow to prevent use-and-refund attacks.\n\nPlaybook: Start with a privacy filter over all insights to avoid leaking secrets or prompt instructions.",
      },
    ];
  }

  const insights = curateInsights(rawItems, spec);

  // -----------------------------
  // 2) Privacy filter
  // -----------------------------
  const { sanitized, report } = sanitizeInsights(insights);
  if (sanitized.length === 0) {
    throw new Error("Privacy filter dropped ALL insights. Aborting - will not list unfiltered content.");
  }
  const safeInsights = sanitized;

  console.log("Privacy report:");
  console.log("  blocked:", report.blocked);
  console.log("  leakageRiskScore:", report.leakageRiskScore);
  console.log("  hits:", report.hits.length);

  // -----------------------------
  // 3) Build memory package + hashes
  // -----------------------------
  const pkgBase = buildMemoryPackage({
    spec,
    sellerAddress: seller.address,
    title: spec.title,
    description: spec.description,
    topics: spec.topics,
    audience: spec.audience,
    insights: safeInsights,
    redactionSummary: report.summary,
  });

  // Define the content hash over the package excluding the integrity section itself.
  const contentHash = computeCanonicalKeccak256({ ...pkgBase, integrity: {} });
  const pkg: MemoryPackage = {
    ...pkgBase,
    integrity: {
      canonicalKeccak256: contentHash,
      plaintextSha256: "", // filled below
    },
  };

  const plaintextJson = JSON.stringify(pkg, null, 2);
  pkg.integrity.plaintextSha256 = computeSha256HexUtf8(plaintextJson);

  // -----------------------------
  // 4) Encrypt + upload to (mock) IPFS
  // -----------------------------
  const ipfs = createIpfsClient();

  const aesKey32 = randomAesKey32();
  const envelope = encryptMemoryPackageToEnvelope({ plaintextJson, contentHash, aesKey32 });

  const priceUSDC = parseUsdc(process.env.MEMONEX_DEMO_PRICE_USDC ?? "0");
  const evalFeeUSDC = parseUsdc(process.env.MEMONEX_DEMO_EVAL_FEE_USDC ?? "0");
  const deliveryWindowSec = Number(process.env.MEMONEX_DEMO_DELIVERY_WINDOW_SEC ?? "21600"); // 6h

  const preview = generatePreview({
    market: MEMONEX_MARKET,
    contentHash,
    priceUSDC,
    evalFeeUSDC,
    deliveryWindowSec,
    memoryPackage: pkg,
    leakageRiskScore: report.leakageRiskScore,
  });

  const previewUp = await ipfs.uploadJSON(preview, `preview-${pkg.packageId}.json`);
  const envelopeUp = await ipfs.uploadJSON(envelope, `envelope-${pkg.packageId}.json`);

  console.log("Uploaded:");
  console.log("  previewCID:", previewUp.cid);
  console.log("  encryptedCID:", envelopeUp.cid);

  // -----------------------------
  // 5) List on contract
  // -----------------------------
  console.log("Listing on-chain…");
  console.log("  price:", formatUsdc(priceUSDC), "USDC");
  console.log("  evalFee:", formatUsdc(evalFeeUSDC), "USDC");

  const listed = await listMemory({
    clients: seller,
    contentHash,
    previewCID: previewUp.cid,
    encryptedCID: envelopeUp.cid,
    priceUSDC,
    evalFeeUSDC,
    deliveryWindowSec,
    prevListingId: 0n,
    discountBps: 0,
  });

  console.log("Listed:");
  console.log("  listingId:", listed.listingId.toString());
  console.log("  tx:", listed.txHash);

  await upsertSellerKeyRecord({
    contentHash,
    listingId: listed.listingId,
    encryptedCID: envelopeUp.cid,
    aesKeyB64: aesKey32.toString("base64"),
    createdAt: nowIso(),
    status: "LISTED",
  });

  // -----------------------------
  // 6) Reserve + confirm (buyer)
  // -----------------------------
  let buyerKeypair = await loadBuyerKeypair();
  if (!buyerKeypair) {
    buyerKeypair = generateBuyerKeypair();
    await saveBuyerKeypair(buyerKeypair);
  }

  // Wait for RPC propagation (Base Sepolia public RPC is load-balanced)
  await new Promise(r => setTimeout(r, 5000));

  console.log("Reserving…");
  const reserveTx = await reserve({
    clients: buyer,
    listingId: listed.listingId,
    buyerPubKey: buyerKeypair.publicKey,
  });
  console.log("  reserve tx:", reserveTx);

  console.log("Confirming…");
  const confirmTx = await confirm({ clients: buyer, listingId: listed.listingId });
  console.log("  confirm tx:", confirmTx);

  // -----------------------------
  // 7) Deliver (seller)
  // -----------------------------
  console.log("Delivering…");
  const capsule = sealKeyMaterialToRecipient({
    recipientPubKey: buyerKeypair.publicKey,
    plaintext: encodeKeyMaterialJson({ aesKey32, contentHash }),
    note: `memonex demo delivery for listing ${listed.listingId.toString()}`,
  });

  const capsuleUp = await ipfs.uploadJSON(capsule, `capsule-${pkg.packageId}.json`);
  const deliveryRef = capsuleUp.cid;

  const deliverTx = await deliver({
    clients: seller,
    listingId: listed.listingId,
    deliveryRef,
  });
  console.log("  deliver tx:", deliverTx);

  await upsertSellerKeyRecord({
    contentHash,
    listingId: listed.listingId,
    encryptedCID: envelopeUp.cid,
    aesKeyB64: aesKey32.toString("base64"),
    createdAt: nowIso(),
    status: "DELIVERED",
  });

  // -----------------------------
  // 8) Buyer fetches delivery + decrypts
  // -----------------------------
  console.log("Buyer fetching listing + decrypting…");
  const l = await getListing({ clients: buyer, listingId: listed.listingId });

  const capsuleJson = (await ipfs.fetchJSON(l.deliveryRef)) as KeyCapsuleV1;
  const keyMaterialPt = openKeyCapsule({ capsule: capsuleJson, recipientSecretKey: buyerKeypair.secretKey });
  const keyMaterial = decodeKeyMaterialJson(keyMaterialPt);

  if (keyMaterial.contentHash !== contentHash) {
    throw new Error("Content hash mismatch (capsule did not match listing)");
  }

  const envelopeJson = (await ipfs.fetchJSON(l.encryptedCID)) as any;
  const decryptedJson = decryptEnvelope({ envelope: envelopeJson, aesKey32: keyMaterial.aesKey32 });
  const imported = JSON.parse(decryptedJson) as MemoryPackage;

  // -----------------------------
  // 9) Import (save locally)
  // -----------------------------
  const outDir = path.join(os.homedir(), ".openclaw", "memonex", "imported");
  await ensureDir(outDir);

  const outPath = path.join(outDir, `${imported.packageId}.json`);
  await writeJsonFile(outPath, imported);

  console.log("Imported memory package written:");
  console.log("  ", outPath);

  const rec = await findSellerKeyRecordByContentHash(contentHash);
  if (rec) {
    console.log("Seller keystore record:");
    console.log("  listingId:", rec.listingId?.toString());
    console.log("  status:", rec.status);
  }

  console.log("Demo complete.");
}

main().catch((err) => {
  console.error("Demo failed:");
  console.error(err);
  process.exitCode = 1;
});
