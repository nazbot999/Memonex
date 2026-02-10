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

6. Confirm setup is complete. Tell them:
   - Their wallet address (derive from key)
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
   - Upload the registration JSON to IPFS via `createIpfsClient().add()`
   - Call `registerSellerOnMarket(walletClient, "ipfs://<cid>")` from `erc8004.ts`
   - Save the returned agentId to `.env` as `MEMONEX_AGENT_ID=<id>`
   - Tell the user: "Registered your agent identity on-chain (agentId: <id>)"
3. If already registered (agentId > 0), skip silently

This is a one-time cost. Once registered, the agentId is cached both on-chain and in `.env`.

**Step 3 — Extract, curate, and privacy scan:**

Run this TypeScript via `npx tsx` from the memonex project directory:

```typescript
import { extractRawItems, curateInsights, buildMemoryPackage } from "./src/memory.js";
import { sanitizeInsights } from "./src/privacy.js";
import { createIpfsClient } from "./src/ipfs.js";
import { encryptMemoryPackageToEnvelope, randomAesKey32, upsertSellerKeyRecord } from "./src/crypto.js";
import { createClients, listMemory, parseUsdc } from "./src/contract.js";
import { computeCanonicalKeccak256, computeSha256HexUtf8, nowIso } from "./src/utils.js";
import { generatePreview } from "./src/preview.js";
import { getSellerAgentId, registerSellerOnMarket, buildAgentRegistrationFile } from "./src/erc8004.js";
import { getApprovalMode } from "./src/config.js";
```

Use `ExtractionSpec` with:
- `sources: [{ kind: "openclaw-memory", limit: 50, includeCurated: <user_choice> }]`
- `topics`, `query`, `timeRange` from user input
- `constraints: { maxItems: 25, noPII: true, noSecrets: true }`

Extract raw items, curate insights, and run privacy scanning (`sanitizeInsights`). Build the memory package and generate the preview.

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

- Generate AES key, encrypt package to envelope
- Upload preview + envelope to IPFS
- Call `listMemory()` on the contract
- Save key record to seller keystore

**Step 6 — Confirm to user:**

Tell them:
- Listing ID
- Transaction hash
- Price and eval fee
- "Waiting for buyers. When someone buys, run `/memonex deliver <id>`"

---

## `/memonex browse`

Show available listings on the marketplace with seller trust information.

**What to do:**

1. Call `getActiveListingIds()` from `contract.ts` — returns IDs of all listings with status ACTIVE (0)
2. For each listing, call `getListing()` to get details. Note: `status: 0` means ACTIVE (see status reference table above)
3. For each unique seller address, look up their ERC-8004 trust data:
   - Call `getSellerAgentId({ clients, seller })` — if > 0, the seller has a verified identity
   - Call `getSellerReputation({ clients, seller })` — get rating count and average
   - Optionally call `getAgentTrustScore(publicClient, agentId)` from `erc8004.ts` for the composite score
4. Display a table with trust info:

```
ID  | Title/Preview          | Price   | Seller        | Trust
----|------------------------|---------|---------------|------------------
42  | DeFi Yield Strategies  | 5 USDC  | DefiSage      | 4.8/5 (12 trades)
43  | Solidity Security      | 0 USDC  | AuditBot      | NEW (no ratings)
44  | MEV Strategies         | 3 USDC  | 0xab12...     | unverified
```

**Trust column logic:**
- Seller has agentId + ratings → show `<avg>/5 (<count> trades)`
- Seller has agentId but no ratings → show `NEW (no ratings)`
- Seller has no agentId (not registered) → show `unverified`

5. If the user is interested in one: "Want details? Tell me the listing ID or run `/memonex buy <id>`"

---

## `/memonex buy`

Browse listings, let the user pick one, purchase it, and import into their memory. Handles the full flow: browse, reserve, confirm, wait for delivery, decrypt, safety scan, import, and auto-rate.

**Step 1 — Show available listings with trust info:**

Display listings the same way as `/memonex browse` (with trust column). Ask the user which one they want to buy. Once they pick a listing ID, fetch its details with `getListing()` and display:
- Content hash, preview CID
- Price, eval fee
- Seller address, delivery window
- Status (must be `0` = ACTIVE — see status reference table)
- **Seller trust score** — call `getSellerAgentId()` and if registered, `getAgentTrustScore(publicClient, agentId)` from `erc8004.ts`. Display: rating, trade count, and composite score. If unverified, warn: "This seller has no verified identity."

Ask: "This costs <price> USDC (+ <eval_fee> eval fee). Proceed?"

**Step 2 — Reserve:**

- Generate buyer keypair (or load existing)
- Call `reserve()` with listing ID and buyer public key
- Tell user: "Reserved. Eval fee paid. Confirming purchase..."

**Step 3 — Confirm:**

- Call `confirm()` to pay the remainder
- Tell user: "Confirmed. Waiting for seller to deliver (up to <window> hours)..."

**Step 4 — Wait for delivery:**

- Poll `getListing()` every 30 seconds, check for `deliveryRef`
- If delivery window expires with no delivery: "Seller didn't deliver. Run `/memonex refund <id>` to get your money back."
- When `deliveryRef` appears: proceed to step 5

**Step 5 — Decrypt:**

- Fetch key capsule from IPFS using `deliveryRef`
- Open capsule with buyer's secret key
- Fetch and decrypt the envelope

Read the approval mode from `.env` via `getApprovalMode()` (defaults to `"manual"`).

**Step 6 — Safety scan and import (mode-aware):**

Run `scanForThreats()` (or `scanForThreatsV2()` if available) from `import.scanner.ts` on the decrypted package.

**If manual mode — Gate B1. Safety Scan Review (before import):**

Show the buyer:
- Threat score and safe-to-import verdict
- Total insights flagged: blocked / warned / passed
- For each flagged item: severity, category, pattern name, location, content snippet
- Which insights will be removed vs. kept

Ask: "Import this package? [yes / no / force-import]"
- If buyer says **no** → abort import, content is NOT written to memory. Skip to rating step (rate 1/5 or skip).
- If buyer says **force-import** → set `forceImport: true` and proceed with import (overrides blocks).
- If buyer says **yes** → proceed with standard import (blocked items still removed).

**If auto mode:**

Display the safety scan results for transparency but do NOT block on approval. If `safeToImport === false`, abort import automatically (built-in safety gate). Otherwise proceed with import.

Then call `importMemoryPackage()` from `import.ts`.

**Step 7 — Import results and rating (mode-aware):**

Determine the auto-rating based on **both content alignment and import quality**:

1. **Content alignment check** — compare the listing's preview (topics, description, claimed insight count) against what was actually delivered. The preview CID has the promised topics; the decrypted package has the actual topics. Calculate an overlap score.
2. **Import quality** — how many insights passed safety scanning and were successfully imported.

| Result | Auto-rating |
|--------|-------------|
| Topics match, all insights imported, no safety flags | 5/5 |
| Topics mostly match, all imported, minor safety warnings | 4/5 |
| Topics partially match, or some insights blocked by scanner | 3/5 |
| Topics don't match well, or most insights blocked | 2/5 |
| Content completely irrelevant to preview, or all blocked | 1/5 |

The topic matching compares the preview's `topics` array against the delivered package's `topics` array. If the listing claimed "Solidity gas optimization" but delivered "cooking recipes", that's a 1/5 regardless of safety scan results.

**If manual mode — Gate B2. Rating Approval (before on-chain rating):**

Show the buyer:
- Insights imported vs. blocked count
- Integrity verification status
- Content quality assessment (topic match between preview and delivered content)
- Proposed auto-rating with reasoning (e.g., "4/5 — topics mostly match, 2 insights blocked by scanner")

Ask: "Accept this rating or set your own? [accept / 1-5]"
- If buyer provides a number (1-5) → use that rating instead of the auto-rating.
- If buyer says **accept** → use the auto-rating.

Then call `rateSeller({ clients, listingId, rating })` from `contract.ts`.

**If auto mode:**

Display the import results and auto-rating for transparency. Submit the auto-rating automatically without approval.

The user sees this as part of the import report, e.g.:
```
Import complete: 18 insights added to memory.
Seller rated 5/5 — rating recorded on-chain.
```

If the rating call fails (e.g., seller has no agentId, or registry issue), skip silently — rating is best-effort.

**If the user wants to override the auto-rating**, they can run `/memonex rate <listingId> <1-5>` within 7 days. But this should be rare — the auto-rating covers the common case.

---

## `/memonex status`

Show the user's marketplace activity and ERC-8004 identity.

**What to do:**

1. **Agent identity** — call `getSellerAgentId({ clients, seller: walletAddress })`:
   - If registered: show agentId, then call `getAgentTrustScore(publicClient, agentId)` to display reputation (avg rating, trade count, composite score)
   - If not registered: show "No agent identity yet — one will be created automatically when you first sell"

2. **Seller stats** — call `getSellerStats()`:
   - Total sales, volume, average delivery time, refund count, ratings

3. **Active listings** — call `getSellerListings()`:
   - Show each listing's ID, status, price, buyer (if reserved/confirmed)

4. **Purchases** — read `$MEMONEX_HOME/import-registry.json`:
   - Show each imported package: title, topics, seller, price, date, integrity status

5. **Balance** — check withdrawable USDC balance on contract

---

## `/memonex withdraw`

Withdraw accumulated USDC earnings from the contract.

**What to do:**

1. Check the user's balance on the contract
2. If balance > 0: call `withdraw()`, display tx hash and amount
3. If balance = 0: "Nothing to withdraw."

---

## `/memonex deliver`

Check all of the user's listings for confirmed buyers and deliver decryption keys automatically.

**What to do:**

1. Call `getSellerListings()` to find all listings with status `2` (CONFIRMED)
2. If none found, tell the user "No buyers waiting for delivery."
3. For each confirmed listing, look up seller key record by content hash
3. Seal AES key to buyer's public key (from listing's `buyerPubKey`)
4. Upload key capsule to IPFS
5. Call `deliver()` with the capsule CID
6. Update seller keystore record to DELIVERED
7. Tell user: "Delivered! Buyer can now decrypt the package."

---

## Important Notes

### Storage
- All packages are stored on **real IPFS** automatically via Memonex's built-in relay
- No API keys or configuration needed — it just works
- Packages are available to any agent on the network

### Safety
- **Outbound (selling):** Privacy scanner automatically removes secrets, PII, and sensitive content before listing. SOUL.md, .env, .ssh are permanently blocked.
- **Inbound (buying):** Safety scanner blocks prompt injection, data exfiltration, and manipulation attempts before import.

### Money
- All amounts are in USDC (1 USDC = 1 USD)
- Base Sepolia uses test USDC (free from faucet)
- The contract uses pull payments — earnings accumulate and you withdraw them with `/memonex withdraw`

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

All SDK functions are in `$MEMONEX_HOME/src/`:

| Module | Key Functions |
|--------|--------------|
| `contract.ts` | `createClients`, `listMemory`, `reserve`, `confirm`, `deliver`, `withdraw`, `rateSeller`, `getListing`, `getActiveListingIds`, `getSellerStats`, `getSellerAgentId`, `getSellerReputation`, `getSellerValidationSummary`, `parseUsdc`, `formatUsdc` |
| `erc8004.ts` | `registerSellerOnMarket`, `buildAgentRegistrationFile`, `getAgentTrustScore`, `getAgentReputationSummary`, `getAgentValidationSummary`, `getAgentMetadata`, `setAgentMetadata`, `getSellerAgentIdViaErc8004` |
| `memory.ts` | `extractRawItems`, `curateInsights`, `buildMemoryPackage` |
| `privacy.ts` | `sanitizeInsights` |
| `crypto.ts` | `encryptMemoryPackageToEnvelope`, `randomAesKey32`, `generateBuyerKeypair`, `sealKeyMaterialToRecipient`, `openKeyCapsule` |
| `import.ts` | `importMemoryPackage` |
| `import.scanner.ts` | `scanForThreats`, `applyThreatActions`, `formatSafetyReport` |
| `gateway.ts` | `createGatewayClient`, `gatewayMemoryStore`, `gatewayMemoryQuery` |
| `ipfs.ts` | `createIpfsClient` |
| `preview.ts` | `generatePreview` |
| `utils.ts` | `computeCanonicalKeccak256`, `computeSha256HexUtf8`, `ensureDir`, `nowIso`, `parseUsdc`, `formatUsdc` |
