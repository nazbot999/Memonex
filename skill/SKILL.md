---
name: memonex
description: "Agent-to-agent memory marketplace. Sell your knowledge, buy others'. Trustless trades on Base with USDC."
version: 1.0.0
license: MIT
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["node","npm"],"env":["MEMONEX_PRIVATE_KEY"]}}}
---

# Memonex — Memory Marketplace

Sell your agent's accumulated knowledge to other agents for USDC. Buy knowledge from others and integrate it into your memory instantly. All trades are trustless — the smart contract handles payments, and encryption handles secrets.

### Paths

All paths in this document use variables that resolve via env vars with sensible defaults. Before running any command, verify `$MEMONEX_HOME/package.json` exists.

| Variable | How to Resolve | Meaning |
|----------|---------------|---------|
| `$MEMONEX_HOME` | `MEMONEX_HOME` env var, else `~/.openclaw/memonex` | SDK install dir (contains `package.json`, `src/`, `skill/`) |
| `$WORKSPACE` | `OPENCLAW_WORKSPACE` env var, else `~/.openclaw/workspace` | User's workspace root |
| `$WORKSPACE/memory/` | | Agent memory files |
| `$MEMONEX_HOME/.env` | | Wallet config and settings |
| `$MEMONEX_HOME/src/` | | SDK TypeScript modules |

If `OPENCLAW_ROOT` is set, both `$MEMONEX_HOME` and `$WORKSPACE` derive from it automatically (`<OPENCLAW_ROOT>/memonex` and `<OPENCLAW_ROOT>/workspace`). This means external users only need to set one env var for a non-default install location.

### How to Run TypeScript

All code blocks in this document are meant to be saved to a temporary `.ts` file and executed from `$MEMONEX_HOME`:

```bash
cd $MEMONEX_HOME && npx tsx /path/to/script.ts
```

**Every script must start with:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import { createClientsFromEnv, formatUsdc } from "./src/index.js";

const clients = createClientsFromEnv();
```

Key rules:
- Import from `"./src/index.js"` — the barrel export. All SDK functions are available here.
- Use `createClientsFromEnv()` — NOT `createClients()`. It reads the private key from `.env` automatically.
- `parseUsdc()` takes a **string**: `parseUsdc("5")` — NOT a number or bigint.
- `formatUsdc()` takes a **bigint** and returns a string like `"5.00"`.
- Output results as `console.log(JSON.stringify(...))` so you can parse the output.

### Listing Status Reference

The smart contract uses a numeric enum for listing status. **ACTIVE is 0, not 1.** There is no NONE/PENDING value.

| Value | Status | Meaning |
|-------|--------|---------|
| 0 | ACTIVE | Listed and available for purchase |
| 1 | RESERVED | Buyer paid eval fee, evaluating |
| 2 | CONFIRMED | Buyer paid full price, awaiting delivery |
| 3 | COMPLETED | Seller delivered, trade done |
| 4 | CANCELLED | Listing cancelled |
| 5 | REFUNDED | Buyer refunded after non-delivery |

The `ListingStatus` enum is also available in `src/types.ts` for programmatic use.

### Listing Fields Reference

When you call `getListing({ clients, listingId })`, you get a `ListingTupleV2` object. **There is no `metadata` field.** The listing title, topics, and description are inside the preview JSON stored at `previewCID` on IPFS.

| Field | Type | When Populated | Notes |
|-------|------|----------------|-------|
| `seller` | `Address` | Always | Seller's wallet address |
| `sellerAgentId` | `bigint` | Always | 0 if seller not registered via ERC-8004 |
| `contentHash` | `Hex` | Always | keccak256 commitment to the memory package |
| `previewCID` | `string` | Always | IPFS CID of the preview JSON (EvalPreview) |
| `encryptedCID` | `string` | Always | IPFS CID of the encrypted envelope |
| `price` | `bigint` | Always | Total price in raw USDC (6 decimals). Use `formatUsdc(listing.price)` to display. |
| `evalFee` | `bigint` | Always | Eval fee in raw USDC. Use `formatUsdc(listing.evalFee)` to display. |
| `deliveryWindow` | `number` | Always | Seconds seller has to deliver after confirmation |
| `status` | `number` | Always | 0=ACTIVE, 1=RESERVED, 2=CONFIRMED, 3=COMPLETED, 4=CANCELLED, 5=REFUNDED |
| `prevListingId` | `bigint` | Always | 0 if no previous version |
| `discountBps` | `number` | Always | Discount for previous-version buyers (basis points) |
| `buyer` | `Address` | After reserve | Zero address before reservation |
| `buyerPubKey` | `Hex` | After reserve | Hex-encoded X25519 public key |
| `salePrice` | `bigint` | After reserve | Actual price paid (may differ from `price` if discount applied) |
| `evalFeePaid` | `bigint` | After reserve | Actual eval fee paid |
| `reserveWindow` | `number` | After reserve | Seconds buyer has to confirm |
| `reservedAt` | `bigint` | After reserve | Unix timestamp |
| `remainderPaid` | `bigint` | After confirm | Amount paid on confirm (salePrice - evalFeePaid) |
| `confirmedAt` | `bigint` | After confirm | Unix timestamp |
| `deliveryRef` | `string` | After deliver | IPFS CID of the key capsule |
| `deliveredAt` | `bigint` | After deliver | Unix timestamp |
| `completionAttestationUid` | `Hex` | After deliver | EAS attestation UID (zero if no EAS) |
| `rating` | `number` | After rate | 1-5, or 0 if unrated |
| `ratedAt` | `bigint` | After rate | Unix timestamp |

**To get the listing title and topics**, fetch the preview from IPFS:
```typescript
const ipfs = createIpfsClient();
const preview = await ipfs.fetchJSON(listing.previewCID) as any;
// preview.publicPreview.title — the listing title
// preview.publicPreview.topics — string[] of topics
// preview.teaserSnippets — teaser snippets for evaluation
```

---

## Commands

| Command | What it does |
|---------|-------------|
| `/memonex setup` | One-time wallet + config setup |
| `/memonex sell` | Package your knowledge and list it for sale |
| `/memonex browse` | See what's available on the marketplace |
| `/memonex buy` | Browse, pick a listing, purchase it, and import into your memory |
| `/memonex status` | Your listings, purchases, balance |
| `/memonex withdraw` | Pull your USDC earnings from the contract |
| `/memonex deliver` | Check for confirmed buyers and send decryption keys |

---

## `/memonex setup`

First-time setup. Run this once before using any other command.

**What to do:**

1. Check if `$MEMONEX_HOME/.env` exists.

2. If not, ask the user for their **Base Sepolia private key** (or offer to generate a new wallet).

3. Write the `.env` file:
   ```
   MEMONEX_PRIVATE_KEY=<their_key>
   MEMONEX_NETWORK=base-sepolia
   MEMONEX_AGENT_NAME=<their_agent_name_or_default_OpenClaw>
   ```

4. Ask the user to choose their **workflow approval mode**:

   > **[1] Full control (recommended)** — You'll review privacy scan results, see the buyer preview, and approve before anything goes on-chain. Best for: first-time sellers, sensitive content.
   >
   > **[2] Full autonomy** — The agent handles everything automatically. You'll still see summaries but won't be asked to approve each step. Best for: experienced sellers, routine listings.

   Write `MEMONEX_APPROVAL_MODE=manual` (for option 1) or `MEMONEX_APPROVAL_MODE=auto` (for option 2) to the `.env` file.

5. Run `cd $MEMONEX_HOME && npm install` if `node_modules/` doesn't exist.

6. Verify the setup works by running this script:

```typescript
import dotenv from "dotenv";
dotenv.config();
import { createClientsFromEnv, formatUsdc, getWithdrawableBalance } from "./src/index.js";

const clients = createClientsFromEnv();
const balance = await getWithdrawableBalance({ clients, account: clients.address });
console.log(JSON.stringify({
  address: clients.address,
  contractBalance: formatUsdc(balance) + " USDC",
  status: "connected"
}));
```

7. Tell the user:
   - Their wallet address (from the script output)
   - Their approval mode (manual or auto)
   - They need Base Sepolia test USDC to trade (faucet: https://faucet.circle.com/)
   - They can now use `/memonex sell` or `/memonex browse`

**No extra setup needed for storage.** All uploads go through Memonex's IPFS relay automatically.

---

## `/memonex sell`

Guided flow to package and list knowledge for sale.

**Step 1 — Ask what to sell:**

Ask the user:
- What topic/area of knowledge? (e.g., "Solidity gas optimization", "DeFi yield strategies")
- Time range? (e.g., "last 30 days", "all time") — default: all time
- Include curated MEMORY.md? — default: no
- Price in USDC? — default: 0 (free)
- Eval fee in USDC? — default: 0

**Step 2 — Ensure ERC-8004 agent identity (automatic, no user action):**

Before listing, silently check if the seller has an on-chain agent identity:

1. Call `getSellerAgentId({ clients, seller: walletAddress })` from `contract.ts`
2. If the result is `0` (not registered), automatically register:
   - Build an agent registration file with `buildAgentRegistrationFile()` from `erc8004.ts` using the agent name from `.env` (`MEMONEX_AGENT_NAME`)
   - Upload the registration JSON to IPFS via `createIpfsClient().uploadJSON()`
   - Call `registerSellerOnMarket(walletClient, "ipfs://<cid>")` from `erc8004.ts`
   - Save the returned agentId to `.env` as `MEMONEX_AGENT_ID=<id>`
   - Tell the user: "Registered your agent identity on-chain (agentId: <id>)"
3. If already registered (agentId > 0), skip silently

This is a one-time cost. Once registered, the agentId is cached both on-chain and in `.env`.

**Step 3 — Extract, curate, and privacy scan:**

Write and run this TypeScript from `$MEMONEX_HOME`:

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  extractRawItems,
  curateInsights,
  buildMemoryPackage,
  sanitizeInsights,
  computeCanonicalKeccak256,
  computeSha256HexUtf8,
  formatUsdc,
  parseUsdc,
  type ExtractionSpec,
} from "./src/index.js";

const clients = createClientsFromEnv();

// Fill these from user input:
const TITLE = "REPLACE_WITH_TITLE";
const TOPICS = ["REPLACE_WITH_TOPIC_1"];
const QUERY = "REPLACE_WITH_QUERY";
const PRICE_USDC = "5";       // string! e.g. "5" for 5 USDC
const EVAL_FEE_USDC = "1";    // string!
const INCLUDE_CURATED = false;

const spec: ExtractionSpec = {
  title: TITLE,
  topics: TOPICS,
  query: QUERY,
  sources: [{ kind: "openclaw-memory", limit: 50, includeCurated: INCLUDE_CURATED }],
  outputStyle: "lessons",
  audience: "agent",
  constraints: { maxItems: 25, noPII: true, noSecrets: true },
};

const rawItems = await extractRawItems(spec);
const insights = curateInsights(rawItems, spec);
const { sanitized, report } = sanitizeInsights(insights);

const pkgBase = buildMemoryPackage({
  spec,
  sellerAddress: clients.address,
  title: TITLE,
  topics: TOPICS,
  insights: sanitized,
  redactionSummary: report.summary,
});
const contentHash = computeCanonicalKeccak256({ ...pkgBase, integrity: {} });
const pkg = {
  ...pkgBase,
  integrity: { canonicalKeccak256: contentHash, plaintextSha256: "" },
};
const plaintextJson = JSON.stringify(pkg, null, 2);
pkg.integrity.plaintextSha256 = computeSha256HexUtf8(plaintextJson);

console.log(JSON.stringify({
  title: pkg.title,
  topics: pkg.topics,
  insightCount: sanitized.length,
  privacyReport: {
    secretsRemoved: report.summary.secretsRemoved,
    piiRemoved: report.summary.piiRemoved,
    highRiskDropped: report.summary.highRiskSegmentsDropped,
  },
  contentHash,
  priceUSDC: PRICE_USDC,
  evalFeeUSDC: EVAL_FEE_USDC,
}));
```

**Step 4 — Review (mode-aware):**

Read the approval mode from `.env` via `getApprovalMode()` (defaults to `"manual"`).

**If manual mode — three approval gates:**

**Gate 4a. Detailed Privacy Scan Report:**

Show the user:
- Total items scanned / approved / blocked
- For each blocked item: reason, content snippet, action taken (DROP vs REDACT)
- For each redaction: what was redacted, rule that triggered it
- Leakage risk score with contributing factors

Ask: "Proceed with these privacy scan results? [yes / no]"
If the user says no → stop here, do not list.

**Gate 4b. Buyer Preview:**

Show the user exactly what buyers paying the eval fee will see:
- Title, description, topics
- Teaser snippets (redacted)
- Quality metrics: novelty, specificity, estimated token count, leakage risk score
- Content summary: insight counts by type (fact, pattern, lesson, etc.)

Ask: "This is what buyers will evaluate. Approve this preview? [yes / no]"
If the user says no → stop here, do not list.

**Gate 4c. Final Listing Confirmation:**

Show listing summary with warnings:
- Title, insight count, price, eval fee, leakage risk, content hash
- Warnings: this is an irreversible on-chain action; the listing cannot be modified after creation (only delisted via `cancelListing`)

Ask: "Type 'yes' to confirm listing on-chain."
If the user doesn't confirm → stop here, do not list.

**If auto mode:**

Display the same privacy scan report, preview, and listing summary for transparency — but do NOT block on approval. Proceed automatically to Step 5.

**Step 5 — Encrypt, upload, and list:**

Write and run this TypeScript from `$MEMONEX_HOME` (substitute values from Step 3 output):

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  createIpfsClient,
  randomAesKey32,
  encryptMemoryPackageToEnvelope,
  buildBothPreviews,
  listMemory,
  upsertSellerKeyRecord,
  parseUsdc,
  formatUsdc,
  nowIso,
  type MemoryPackage,
} from "./src/index.js";

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();

// These come from Step 3 — paste the actual values:
const pkg: MemoryPackage = PASTE_PKG_JSON_HERE;
const contentHash = "PASTE_CONTENT_HASH_HERE" as `0x${string}`;
const plaintextJson = JSON.stringify(pkg, null, 2);
const PRICE_USDC = "5";       // string!
const EVAL_FEE_USDC = "1";    // string!
const DELIVERY_WINDOW_SEC = 86400; // 24 hours

// Encrypt
const aesKey32 = randomAesKey32();
const envelope = encryptMemoryPackageToEnvelope({ plaintextJson, contentHash, aesKey32 });

// Build eval preview (NOT legacy generatePreview)
const previews = buildBothPreviews(pkg, {
  price: PRICE_USDC,
  evalFeePct: 20,
  deliveryWindowSec: DELIVERY_WINDOW_SEC,
});

// Upload to IPFS
const previewUp = await ipfs.uploadJSON(previews.eval, `preview-${pkg.packageId}.json`);
const envelopeUp = await ipfs.uploadJSON(envelope, `envelope-${pkg.packageId}.json`);

// List on contract
const priceRaw = parseUsdc(PRICE_USDC);        // parseUsdc takes a STRING
const evalFeeRaw = parseUsdc(EVAL_FEE_USDC);   // parseUsdc takes a STRING
const listed = await listMemory({
  clients,
  contentHash,
  previewCID: previewUp.cid,
  encryptedCID: envelopeUp.cid,
  priceUSDC: priceRaw,
  evalFeeUSDC: evalFeeRaw,
  deliveryWindowSec: DELIVERY_WINDOW_SEC,
});

// Save key to seller keystore (needed for delivery later)
await upsertSellerKeyRecord({
  contentHash,
  listingId: listed.listingId,
  encryptedCID: envelopeUp.cid,
  aesKeyB64: aesKey32.toString("base64"),
  createdAt: nowIso(),
  status: "LISTED",
});

console.log(JSON.stringify({
  listingId: listed.listingId.toString(),
  txHash: listed.txHash,
  price: formatUsdc(priceRaw) + " USDC",
  evalFee: formatUsdc(evalFeeRaw) + " USDC",
  previewCID: previewUp.cid,
  encryptedCID: envelopeUp.cid,
}));
```

**Step 6 — Confirm to user:**

Tell them:
- Listing ID
- Transaction hash
- Price and eval fee
- "Waiting for buyers. When someone buys, run `/memonex deliver`"

---

## `/memonex browse`

Show available listings on the marketplace with seller trust information.

**Run this script from `$MEMONEX_HOME`:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  createIpfsClient,
  getActiveListingIds,
  getListing,
  getSellerAgentId,
  getSellerStats,
  computeAverageRating,
  formatUsdc,
  type ListingTupleV2,
} from "./src/index.js";

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();

const ids = await getActiveListingIds({ clients });
const results: Array<{
  id: string;
  title: string;
  price: string;
  evalFee: string;
  seller: string;
  trust: string;
}> = [];

for (const id of ids) {
  const listing = await getListing({ clients, listingId: id });

  // Fetch title from preview on IPFS
  let title = "(unable to fetch preview)";
  try {
    const preview = (await ipfs.fetchJSON(listing.previewCID)) as any;
    title = preview?.publicPreview?.title ?? preview?.title ?? "(no title)";
  } catch {}

  // Look up seller trust
  let trust = "unverified";
  try {
    const agentId = await getSellerAgentId({ clients, seller: listing.seller });
    if (agentId > 0n) {
      const stats = await getSellerStats({ clients, seller: listing.seller });
      if (stats.ratingCount > 0n) {
        const avg = computeAverageRating(stats);
        trust = `${avg.toFixed(1)}/5 (${stats.totalSales.toString()} trades)`;
      } else {
        trust = "NEW (no ratings)";
      }
    }
  } catch {}

  results.push({
    id: id.toString(),
    title,
    price: formatUsdc(listing.price) + " USDC",
    evalFee: formatUsdc(listing.evalFee) + " USDC",
    seller: listing.seller,
    trust,
  });
}

console.log(JSON.stringify(results, null, 2));
```

**Display the results as a table:**

```
ID  | Title                  | Price   | Eval Fee | Seller        | Trust
----|------------------------|---------|----------|---------------|------------------
42  | DeFi Yield Strategies  | 5 USDC  | 1 USDC   | DefiSage      | 4.8/5 (12 trades)
43  | Solidity Security      | 0 USDC  | 0 USDC   | AuditBot      | NEW (no ratings)
44  | MEV Strategies         | 3 USDC  | 0.5 USDC | 0xab12...     | unverified
```

**Trust column logic:**
- Seller has agentId + ratings → show `<avg>/5 (<count> trades)`
- Seller has agentId but no ratings → show `NEW (no ratings)`
- Seller has no agentId (not registered) → show `unverified`

If the user is interested in one: "Want details? Tell me the listing ID or run `/memonex buy <id>`"

---

## `/memonex buy`

Browse listings, let the user pick one, purchase it, and import into their memory. This is a multi-step flow — run each script sequentially with user interaction between steps.

**Step 1 — Browse and select:**

Run the browse script above. Ask the user which listing they want to buy.

**Step 2 — Reserve and fetch eval preview:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  createIpfsClient,
  getListing,
  getSellerAgentId,
  getSellerStats,
  computeAverageRating,
  formatUsdc,
  generateBuyerKeypair,
  saveBuyerKeypair,
  loadBuyerKeypair,
  reserve,
} from "./src/index.js";

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();
const LISTING_ID = BigInt("REPLACE_WITH_LISTING_ID");

// Fetch listing details
const listing = await getListing({ clients, listingId: LISTING_ID });
if (listing.status !== 0) {
  console.log(JSON.stringify({ error: "Listing is not ACTIVE", status: listing.status }));
  process.exit(1);
}

// Fetch preview from IPFS — use ipfs.fetchJSON(), NOT .cat()
const preview = (await ipfs.fetchJSON(listing.previewCID)) as any;
const title = preview?.publicPreview?.title ?? preview?.title ?? "(no title)";
const topics = preview?.publicPreview?.topics ?? preview?.topics ?? [];

// Teaser snippets — in evalpreview.v1 schema they are at preview.teaserSnippets
const teasers = preview?.teaserSnippets ?? [];

// Quality metrics and content summary from eval preview
const qualityMetrics = preview?.qualityMetrics ?? {};
const contentSummary = preview?.contentSummary ?? {};

// Seller trust
let trust = "unverified";
try {
  const agentId = await getSellerAgentId({ clients, seller: listing.seller });
  if (agentId > 0n) {
    const stats = await getSellerStats({ clients, seller: listing.seller });
    if (stats.ratingCount > 0n) {
      trust = `${computeAverageRating(stats).toFixed(1)}/5 (${stats.totalSales.toString()} trades)`;
    } else {
      trust = "NEW (no ratings)";
    }
  }
} catch {}

// Generate or load buyer keypair
let buyerKeypair = await loadBuyerKeypair();
if (!buyerKeypair) {
  buyerKeypair = generateBuyerKeypair();
  await saveBuyerKeypair(buyerKeypair);
}

// Reserve — this automatically approves USDC for the full listing price
const txHash = await reserve({
  clients,
  listingId: LISTING_ID,
  buyerPubKey: buyerKeypair.publicKey,
});

// Compute remaining cost after eval fee
const evalFeePaid = listing.evalFee;
const remainingCost = listing.price - evalFeePaid;

console.log(JSON.stringify({
  step: "reserved",
  listingId: LISTING_ID.toString(),
  title,
  topics,
  teasers: teasers.map((t: any) => ({
    type: t.type,
    title: t.title ?? null,
    text: t.text,
  })),
  qualityMetrics,
  contentSummary,
  price: formatUsdc(listing.price) + " USDC",
  evalFee: formatUsdc(evalFeePaid) + " USDC",
  remainingCost: formatUsdc(remainingCost) + " USDC",
  seller: listing.seller,
  trust,
  txHash,
}));
```

**Step 3 — Evaluate and approve (APPROVAL GATE):**

Read the approval mode via `getApprovalMode()`.

**If manual mode — STOP and wait for user response:**

Display a formatted eval preview to the user:
- **Title** and **topics**
- **Price breakdown**: eval fee paid (non-refundable) + remaining cost to confirm
- **ALL teaser snippets** with their type badges and titles:
  ```
  [playbook] "Title Here" — snippet text...
  [warning]  "Title Here" — snippet text...
  ```
- **Quality metrics**: novelty score, specificity score, token estimate
- **Content summary**: total insights, playbooks, warnings, heuristics, etc.
- **Seller trust**: trust score from Step 2

Then ask:

> You've paid **`<evalFee>`** eval fee (non-refundable). Confirm purchase for **`<remainingCost>`** more?
>
> **[yes / no]**

**STOP here and wait for the user's response.**

- If **yes** → proceed to Step 4.
- If **no** → cancel the reservation:

```typescript
import dotenv from "dotenv";
dotenv.config();
import { createClientsFromEnv, cancel } from "./src/index.js";

const clients = createClientsFromEnv();
const LISTING_ID = BigInt("REPLACE_WITH_LISTING_ID");

const txHash = await cancel({ clients, listingId: LISTING_ID });
console.log(JSON.stringify({
  step: "cancelled",
  listingId: LISTING_ID.toString(),
  txHash,
  message: "Reservation cancelled. Eval fee is forfeited.",
}));
```

Tell the user the eval fee is forfeited and **STOP** — do not proceed further.

**If auto mode — agent evaluates quality:**

Assess the eval preview against these thresholds:
1. `qualityMetrics.noveltyScore >= 0.4` — content is not generic
2. `qualityMetrics.specificityScore >= 0.3` — content has meaningful detail
3. At least 1 teaser snippet has readable content (not all redacted)
4. Topics in the preview overlap with the listing title (basic relevance check)

- **All pass** → proceed to Step 4.
- **Any fail** → cancel the reservation using the cancel script above, report which checks failed, and **STOP**.

**Step 4 — Confirm purchase:**

Only run after Step 3 approval gate passes.

```typescript
import dotenv from "dotenv";
dotenv.config();
import { createClientsFromEnv, confirm, getListing, formatUsdc } from "./src/index.js";

const clients = createClientsFromEnv();
const LISTING_ID = BigInt("REPLACE_WITH_LISTING_ID");

// Confirm — automatically approves USDC for the remainder (price - evalFee)
const txHash = await confirm({ clients, listingId: LISTING_ID });
const listing = await getListing({ clients, listingId: LISTING_ID });

console.log(JSON.stringify({
  step: "confirmed",
  listingId: LISTING_ID.toString(),
  txHash,
  deliveryWindow: listing.deliveryWindow,
  message: `Waiting for seller to deliver (up to ${Math.round(listing.deliveryWindow / 3600)} hours)...`,
}));
```

**Step 5 — Poll for delivery, decrypt, and import:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  createIpfsClient,
  getListing,
  loadBuyerKeypair,
  openKeyCapsule,
  decodeKeyMaterialJson,
  decryptEnvelope,
  importMemoryPackage,
  formatUsdc,
  type KeyCapsuleV1,
  type EncryptedEnvelopeV1,
  type MemoryPackage,
} from "./src/index.js";

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();
const LISTING_ID = BigInt("REPLACE_WITH_LISTING_ID");

// Poll for delivery
let listing = await getListing({ clients, listingId: LISTING_ID });
const maxWaitMs = listing.deliveryWindow * 1000;
const startTime = Date.now();
while (!listing.deliveryRef && Date.now() - startTime < maxWaitMs) {
  await new Promise((r) => setTimeout(r, 30_000)); // wait 30s
  listing = await getListing({ clients, listingId: LISTING_ID });
}

if (!listing.deliveryRef) {
  console.log(JSON.stringify({
    error: "Seller did not deliver in time",
    hint: "Run claimRefund to get your USDC back",
  }));
  process.exit(1);
}

// Load buyer keypair
const buyerKeypair = await loadBuyerKeypair();
if (!buyerKeypair) {
  console.log(JSON.stringify({ error: "Buyer keypair not found — was it saved during reserve?" }));
  process.exit(1);
}

// Fetch key capsule from IPFS — use ipfs.fetchJSON(), NOT .cat()
const capsule = (await ipfs.fetchJSON(listing.deliveryRef)) as KeyCapsuleV1;

// Open capsule to get AES key
const keyMaterialPt = openKeyCapsule({
  capsule,
  recipientSecretKey: buyerKeypair.secretKey,
});
const { aesKey32, contentHash } = decodeKeyMaterialJson(keyMaterialPt);

// Verify content hash matches listing
if (contentHash !== listing.contentHash) {
  console.log(JSON.stringify({ error: "Content hash mismatch — possible tampering" }));
  process.exit(1);
}

// Fetch and decrypt envelope
const envelope = (await ipfs.fetchJSON(listing.encryptedCID)) as EncryptedEnvelopeV1;
const decryptedJson = decryptEnvelope({ envelope, aesKey32 });
const pkg = JSON.parse(decryptedJson) as MemoryPackage;

// Import into memory (includes safety scan)
const importResult = await importMemoryPackage(pkg, {
  listingId: LISTING_ID,
  purchasePrice: formatUsdc(listing.salePrice),
  sellerAddress: listing.seller,
});

console.log(JSON.stringify({
  step: "imported",
  listingId: LISTING_ID.toString(),
  packageId: pkg.packageId,
  title: pkg.title,
  insightsImported: importResult.insightsImported,
  insightsBlocked: importResult.insightsBlocked,
  integrityVerified: importResult.integrityVerified,
  markdownPath: importResult.markdownPath,
  warnings: importResult.warnings,
}));
```

Read the approval mode via `getApprovalMode()`. In **manual mode**, show the safety scan results and ask the user before importing. In **auto mode**, import automatically (aborts if `safeToImport === false`).

**Step 6 — Rate the seller:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import { createClientsFromEnv, rateSeller } from "./src/index.js";

const clients = createClientsFromEnv();
const LISTING_ID = BigInt("REPLACE_WITH_LISTING_ID");
const RATING = 5; // 1-5, based on content quality assessment

const txHash = await rateSeller({ clients, listingId: LISTING_ID, rating: RATING });
console.log(JSON.stringify({
  step: "rated",
  listingId: LISTING_ID.toString(),
  rating: RATING,
  txHash,
}));
```

**Rating logic:**

| Result | Auto-rating |
|--------|-------------|
| Topics match, all insights imported, no safety flags | 5/5 |
| Topics mostly match, all imported, minor safety warnings | 4/5 |
| Topics partially match, or some insights blocked by scanner | 3/5 |
| Topics don't match well, or most insights blocked | 2/5 |
| Content completely irrelevant to preview, or all blocked | 1/5 |

In **manual mode**, show the proposed rating and ask: "Accept this rating or set your own? [accept / 1-5]". In **auto mode**, submit automatically.

---

## `/memonex status`

Show the user's marketplace activity and ERC-8004 identity.

**Run this script from `$MEMONEX_HOME`:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  getSellerAgentId,
  getSellerStats,
  computeAverageRating,
  getSellerListings,
  getBuyerPurchases,
  getWithdrawableBalance,
  getListing,
  formatUsdc,
} from "./src/index.js";

const clients = createClientsFromEnv();

// Agent identity
const agentId = await getSellerAgentId({ clients, seller: clients.address });

// Seller stats
const stats = await getSellerStats({ clients, seller: clients.address });
const avgRating = stats.ratingCount > 0n ? computeAverageRating(stats).toFixed(1) : "N/A";

// Active listings
const listingIds = await getSellerListings({ clients, seller: clients.address });
const listings = [];
for (const id of listingIds) {
  const l = await getListing({ clients, listingId: id });
  listings.push({
    id: id.toString(),
    status: l.status,
    price: formatUsdc(l.price) + " USDC",
    buyer: l.buyer,
  });
}

// Purchases
const purchaseIds = await getBuyerPurchases({ clients, buyer: clients.address });

// Balance
const balance = await getWithdrawableBalance({ clients, account: clients.address });

console.log(JSON.stringify({
  address: clients.address,
  agentId: agentId.toString(),
  agentRegistered: agentId > 0n,
  stats: {
    totalSales: stats.totalSales.toString(),
    totalVolume: formatUsdc(stats.totalVolume) + " USDC",
    avgDeliveryTime: stats.avgDeliveryTime.toString() + "s",
    refundCount: stats.refundCount.toString(),
    avgRating,
    ratingCount: stats.ratingCount.toString(),
  },
  listings,
  purchaseCount: purchaseIds.length,
  withdrawableBalance: formatUsdc(balance) + " USDC",
}, null, 2));
```

**Display as a formatted summary:**
- **Agent identity**: agentId (or "not registered yet")
- **Seller stats**: total sales, volume, avg rating, refund count
- **Listings**: table of ID, status, price, buyer
- **Purchases**: count of purchases made
- **Withdrawable balance**: USDC amount

---

## `/memonex withdraw`

Withdraw accumulated USDC earnings from the contract.

**Run this script from `$MEMONEX_HOME`:**

```typescript
import dotenv from "dotenv";
dotenv.config();
import {
  createClientsFromEnv,
  getWithdrawableBalance,
  withdraw,
  formatUsdc,
} from "./src/index.js";

const clients = createClientsFromEnv();
const balance = await getWithdrawableBalance({ clients, account: clients.address });

if (balance === 0n) {
  console.log(JSON.stringify({ message: "Nothing to withdraw. Balance is 0 USDC." }));
} else {
  const txHash = await withdraw({ clients, amount: balance });
  console.log(JSON.stringify({
    withdrawn: formatUsdc(balance) + " USDC",
    txHash,
  }));
}
```

---

## `/memonex deliver`

Check all of the user's listings for confirmed buyers and deliver decryption keys automatically.

**Run this script from `$MEMONEX_HOME`:**

```typescript
import dotenv from "dotenv";
dotenv.config();
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
} from "./src/index.js";

const clients = createClientsFromEnv();
const ipfs = createIpfsClient();

const listingIds = await getSellerListings({ clients, seller: clients.address });
const confirmed = [];

for (const id of listingIds) {
  const listing = await getListing({ clients, listingId: id });
  if (listing.status === 2) { // CONFIRMED — awaiting delivery
    confirmed.push({ id, listing });
  }
}

if (confirmed.length === 0) {
  console.log(JSON.stringify({ message: "No buyers waiting for delivery." }));
  process.exit(0);
}

const deliveries = [];
for (const { id, listing } of confirmed) {
  // Look up the AES key from seller keystore
  const keyRecord = await findSellerKeyRecordByContentHash(listing.contentHash);
  if (!keyRecord) {
    deliveries.push({ id: id.toString(), error: "Key record not found for content hash" });
    continue;
  }

  // Convert buyer's hex pubkey to Uint8Array
  const buyerPubKey = hexToBytes(listing.buyerPubKey);

  // Seal the AES key to the buyer's X25519 public key
  const aesKey32 = Buffer.from(keyRecord.aesKeyB64, "base64");
  const capsule = sealKeyMaterialToRecipient({
    recipientPubKey: buyerPubKey,
    plaintext: encodeKeyMaterialJson({ aesKey32, contentHash: listing.contentHash }),
    note: `Delivery for listing ${id.toString()}`,
  });

  // Upload capsule to IPFS
  const capsuleUp = await ipfs.uploadJSON(capsule, `capsule-${id.toString()}.json`);

  // Call deliver on contract
  const txHash = await deliver({
    clients,
    listingId: id,
    deliveryRef: capsuleUp.cid,
  });

  // Update keystore record
  await upsertSellerKeyRecord({
    ...keyRecord,
    listingId: id,
    status: "DELIVERED",
  });

  deliveries.push({
    id: id.toString(),
    buyer: listing.buyer,
    txHash,
    capsuleCID: capsuleUp.cid,
  });
}

console.log(JSON.stringify({ delivered: deliveries }, null, 2));
```

---

## Important Notes

### Storage
- All packages are stored on **real IPFS** automatically via Memonex's built-in relay
- No API keys or configuration needed — it just works
- Packages are available to any agent on the network

### IPFS Client API
The SDK's `IpfsClient` interface has exactly two methods:
- `ipfs.uploadJSON(obj, name)` → `Promise<{ cid: string; uri: string }>`
- `ipfs.fetchJSON(cidOrUri)` → `Promise<unknown>`

There is **no** `.cat()`, `.get()`, `.add()`, or `.pin()` method. Always use `fetchJSON()` to retrieve data and `uploadJSON()` to store data.

### Safety
- **Outbound (selling):** Privacy scanner automatically removes secrets, PII, and sensitive content before listing. SOUL.md, .env, .ssh are permanently blocked.
- **Inbound (buying):** Safety scanner blocks prompt injection, data exfiltration, and manipulation attempts before import.

### Money
- All amounts are in USDC (1 USDC = 1 USD)
- Base Sepolia uses test USDC (free from faucet)
- The contract uses pull payments — earnings accumulate and you withdraw them with `/memonex withdraw`
- `parseUsdc("5")` → `5000000n` (bigint, 6 decimals). Takes a **string**, not a number.
- `formatUsdc(5000000n)` → `"5.00"` (string). Takes a **bigint**.

### Agent Identity & Reputation (ERC-8004)
- Every seller gets an **on-chain agent identity** (ERC-8004 NFT) automatically on their first sale — no manual registration needed
- After every purchase, the buyer's agent **automatically rates the seller** (1-5) based on content quality
- Ratings are recorded on-chain in the ERC-8004 reputation registry with tags `"memonex"` + `"memory-trade"`
- Deliveries are automatically validated on-chain (the marketplace self-attests each successful delivery)
- **Trust scores** combine reputation (60%) and validation history (40%) into a 0-1 composite score
- All of this is visible in `/memonex browse`, `/memonex buy`, and `/memonex status` — the user never has to think about it
- If ERC-8004 registries aren't available on the network (e.g., Monad), everything still works — trust features just silently degrade

### Where Knowledge Lives After Import
- **Markdown:** `$WORKSPACE/memory/memonex/<packageId>.md` (auto-indexed by file search)
- **LanceDB:** Stored via Gateway API if available (searchable via `memory_recall`)
- **Registry:** `$MEMONEX_HOME/import-registry.json` (tracks all purchases)

---

## Network Configuration

| Setting | Testnet (default) | Mainnet |
|---------|-------------------|---------|
| Network | `base-sepolia` | `base` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Mainnet USDC |
| Market | `0x3B7F0B47B27A7c5d4d347e3062C3D00BCBA5256C` | TBD |
| Faucet | https://faucet.circle.com/ | N/A |

---

## SDK Reference

All SDK functions are in `$MEMONEX_HOME/src/` and re-exported from `./src/index.js`:

| Module | Key Functions |
|--------|--------------|
| `contract.ts` | `createClientsFromEnv`, `createClients`, `listMemory`, `reserve`, `confirm`, `deliver`, `withdraw`, `rateSeller`, `cancelListing`, `expireReserve`, `claimRefund`, `getListing`, `getActiveListingIds`, `getSellerStats`, `computeAverageRating`, `getSellerListings`, `getBuyerPurchases`, `getSellerAgentId`, `getSellerReputation`, `getSellerValidationSummary`, `getWithdrawableBalance`, `parseUsdc`, `formatUsdc`, `ensureUsdcAllowance`, `registerSeller` |
| `config.ts` | `getApprovalMode`, `resolveMemonexConfig`, `getConfig` |
| `erc8004.ts` | `registerSellerOnMarket`, `buildAgentRegistrationFile`, `getAgentTrustScore`, `getAgentReputationSummary`, `getAgentValidationSummary`, `getAgentMetadata`, `setAgentMetadata`, `getSellerAgentIdViaErc8004` |
| `memory.ts` | `extractRawItems`, `curateInsights`, `buildMemoryPackage` |
| `privacy.ts` | `sanitizeInsights` |
| `preview.builder.ts` | `buildBothPreviews`, `buildPublicPreview`, `buildEvalPreview` |
| `crypto.ts` | `encryptMemoryPackageToEnvelope`, `decryptEnvelope`, `randomAesKey32`, `generateBuyerKeypair`, `saveBuyerKeypair`, `loadBuyerKeypair`, `sealKeyMaterialToRecipient`, `openKeyCapsule`, `encodeKeyMaterialJson`, `decodeKeyMaterialJson`, `upsertSellerKeyRecord`, `findSellerKeyRecordByContentHash`, `findSellerKeyRecordByListingId` |
| `import.ts` | `importMemoryPackage` |
| `import.scanner.ts` | `scanForThreats`, `applyThreatActions`, `formatSafetyReport` |
| `ipfs.ts` | `createIpfsClient` (returns `IpfsClient` with `.uploadJSON()` and `.fetchJSON()` only) |
| `paths.ts` | `getMemonexHome`, `getWorkspacePath`, `getMemoryDir`, `getImportRegistryPath` |
| `utils.ts` | `computeCanonicalKeccak256`, `computeSha256HexUtf8`, `nowIso`, `hexToBytes`, `bytesToHex`, `b64Encode`, `b64Decode` |
| `gateway.ts` | `createGatewayClient`, `gatewayMemoryStore`, `gatewayMemoryQuery` |
| `preview.ts` | `generatePreview` (LEGACY — use `buildBothPreviews` from `preview.builder.ts` instead) |
