import dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";
import path from "node:path";
import {
  createClientsFromEnv,
  createIpfsClient,
  getBuyerPurchases,
  getListing,
  loadBuyerKeypair,
  openKeyCapsule,
  decodeKeyMaterialJson,
  decryptEnvelope,
  computeContentHash,
  scanForThreatsV2,
  importMemoryPackage,
  nowIso,
  formatUsdc,
  getMemonexHome,
  getImportRegistryPath,
  type KeyCapsuleV1,
  type EncryptedEnvelopeV1,
  type MemoryPackage,
} from "./src/index.js";

// Log helper
const logDir = path.join(getMemonexHome(), "packages", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "auto-receive.log");
function log(msg: string) {
  const line = `[${nowIso()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  console.log(msg);
}

// Check import registry to skip already-imported listings
function isAlreadyImported(listingId: string): boolean {
  try {
    const registry = JSON.parse(fs.readFileSync(getImportRegistryPath(), "utf8"));
    return registry.records?.some((r: any) => r.listingId === listingId) ?? false;
  } catch { return false; }
}

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();

const purchaseIds = await getBuyerPurchases({ clients, buyer: clients.address });
const deliveredPending = [];

for (const id of purchaseIds) {
  const listing = await getListing({ clients, listingId: id });
  // Status 3 = COMPLETED (delivered), must have deliveryRef, not yet imported
  if (listing.status === 3 && listing.deliveryRef && !isAlreadyImported(id.toString())) {
    deliveredPending.push({ id, listing });
  }
}

if (deliveredPending.length === 0) {
  log("No pending deliveries to receive.");
  process.exit(0);
}

log(`Found ${deliveredPending.length} delivery(ies) to receive.`);

const buyerKeypair = await loadBuyerKeypair();
if (!buyerKeypair) {
  log("ERROR: Buyer keypair not found — cannot decrypt deliveries.");
  process.exit(1);
}

for (const { id, listing } of deliveredPending) {
  try {
    // Fetch and open key capsule
    const capsule = (await ipfs.fetchJSON(listing.deliveryRef)) as KeyCapsuleV1;
    const keyMaterialPt = openKeyCapsule({
      capsule,
      recipientSecretKey: buyerKeypair.secretKey,
    });
    const { aesKey32, contentHash } = decodeKeyMaterialJson(keyMaterialPt);

    // Verify content hash
    if (contentHash !== listing.contentHash) {
      log(`Listing ${id}: content hash mismatch — skipping`);
      continue;
    }

    // Decrypt
    const envelope = (await ipfs.fetchJSON(listing.encryptedCID)) as EncryptedEnvelopeV1;
    const decryptedJson = decryptEnvelope({ envelope, aesKey32 });
    const pkg = JSON.parse(decryptedJson) as MemoryPackage;

    if (!pkg.insights || pkg.insights.length === 0) {
      log(`Listing ${id}: empty package — skipping`);
      continue;
    }

    // Safety scan
    const scanResult = scanForThreatsV2(pkg);
    if (!scanResult.safeToImport || scanResult.threatScore >= 0.4) {
      log(`Listing ${id}: safety check failed (score: ${scanResult.threatScore}) — skipping`);
      continue;
    }

    // Import
    const result = await importMemoryPackage(pkg, {
      listingId: id,
      purchasePrice: formatUsdc(listing.salePrice),
      sellerAddress: listing.seller,
      skipSafetyScan: true, // already scanned above
    });

    log(`Listing ${id}: imported "${pkg.title}" — ${result.insightsImported} insights`);
  } catch (err: any) {
    log(`Listing ${id}: ERROR — ${err?.message ?? String(err)}`);
  }
}
