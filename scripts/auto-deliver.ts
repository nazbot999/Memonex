import dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";
import path from "node:path";
import {
  createClientsFromEnv,
  createIpfsClient,
  getSellerListings,
  getListing,
  findSellerKeyRecordByContentHash,
  sealKeyMaterialToRecipient,
  encodeKeyMaterialJson,
  deliver,
  upsertSellerKeyRecord,
  nowIso,
  formatUsdc,
  hexToBytes,
  getMemonexHome,
} from "./src/index.js";

// Log helper — appends to packages/logs/auto-deliver.log
const logDir = path.join(getMemonexHome(), "packages", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "auto-deliver.log");
function log(msg: string) {
  const line = `[${nowIso()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  console.log(msg);
}

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();

const listingIds = await getSellerListings({ clients, seller: clients.address });
const confirmed = [];

for (const id of listingIds) {
  const listing = await getListing({ clients, listingId: id });
  if (listing.status === 2) confirmed.push({ id, listing }); // CONFIRMED
}

if (confirmed.length === 0) {
  log("No buyers waiting for delivery.");
  process.exit(0);
}

log(`Found ${confirmed.length} confirmed listing(s) to deliver.`);

for (const { id, listing } of confirmed) {
  try {
    const keyRecord = await findSellerKeyRecordByContentHash(listing.contentHash);
    if (!keyRecord) { log(`Listing ${id}: key record not found — skipping`); continue; }

    const buyerPubKey = hexToBytes(listing.buyerPubKey);
    const aesKey32 = Buffer.from(keyRecord.aesKeyB64, "base64");
    const capsule = sealKeyMaterialToRecipient({
      recipientPubKey: buyerPubKey,
      plaintext: encodeKeyMaterialJson({ aesKey32, contentHash: listing.contentHash }),
      note: `Auto-delivery for listing ${id.toString()}`,
    });

    const capsuleUp = await ipfs.uploadJSON(capsule, `capsule-${id.toString()}.json`);
    const txHash = await deliver({ clients, listingId: id, deliveryRef: capsuleUp.cid });
    await upsertSellerKeyRecord({
      ...keyRecord,
      listingId: id,
      status: "DELIVERED",
    });

    log(`Listing ${id}: delivered to ${listing.buyer} — tx: ${txHash}`);
  } catch (err: any) {
    log(`Listing ${id}: ERROR — ${err?.message ?? String(err)}`);
  }
}
