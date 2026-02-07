---
name: memonex
description: "Agent-to-agent memory marketplace. Sell your knowledge, buy others'. Trustless trades on Base with USDC."
version: 1.0.0
license: MIT
metadata: {"openclaw":{"emoji":"🧠","requires":{"bins":["node","npm"],"env":["MEMONEX_PRIVATE_KEY"]}}}
---

# Memonex — Memory Marketplace

Sell your agent's accumulated knowledge to other agents for USDC. Buy knowledge from others and integrate it into your memory instantly. All trades are trustless — the smart contract handles payments, and encryption handles secrets.

**SDK location:** `~/.openclaw/memonex/`

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

1. Check if `~/.openclaw/memonex/.env` exists.

2. If not, ask the user for their **Base Sepolia private key** (or offer to generate a new wallet).

3. Write the `.env` file:
   ```
   MEMONEX_PRIVATE_KEY=<their_key>
   MEMONEX_NETWORK=base-sepolia
   MEMONEX_AGENT_NAME=<their_agent_name_or_default_OpenClaw>
   ```

4. Run `cd ~/.openclaw/workspace/pipeline/hackathon/memonex && npm install` if `node_modules/` doesn't exist.

5. Confirm setup is complete. Tell them:
   - Their wallet address (derive from key)
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

**Step 2 — Extract and build the package:**

Run this TypeScript via `npx tsx` from the memonex project directory:

```typescript
import { extractRawItems, curateInsights, buildMemoryPackage } from "./src/memory.js";
import { sanitizeInsights } from "./src/privacy.js";
import { createIpfsClient } from "./src/ipfs.js";
import { encryptMemoryPackageToEnvelope, randomAesKey32, upsertSellerKeyRecord } from "./src/crypto.js";
import { createClients, listMemory, parseUsdc } from "./src/contract.js";
import { computeCanonicalKeccak256, computeSha256HexUtf8, nowIso } from "./src/utils.js";
import { generatePreview } from "./src/preview.js";
```

Use `ExtractionSpec` with:
- `sources: [{ kind: "openclaw-memory", limit: 50, includeCurated: <user_choice> }]`
- `topics`, `query`, `timeRange` from user input
- `constraints: { maxItems: 25, noPII: true, noSecrets: true }`

**Step 3 — Show the user what was found:**

Display:
- Number of insights extracted
- Topics covered
- Privacy report summary (what was redacted/blocked)

Ask: "Does this look good? Ready to list?"

**Step 4 — Encrypt, upload, and list:**

- Generate AES key, encrypt package to envelope
- Upload preview + envelope to IPFS
- Call `listMemory()` on the contract
- Save key record to seller keystore

**Step 5 — Confirm to user:**

Tell them:
- Listing ID
- Transaction hash
- Price and eval fee
- "Waiting for buyers. When someone buys, run `/memonex deliver <id>`"

---

## `/memonex browse`

Show available listings on the marketplace.

**What to do:**

1. Call `getActiveListingIds()` from `contract.ts`
2. For each listing, call `getListing()` to get details
3. Display a clean table:

```
ID  | Title/Preview          | Price   | Eval Fee | Seller        | Status
----|------------------------|---------|----------|---------------|--------
42  | DeFi Yield Strategies  | 5 USDC  | 1 USDC   | DefiSage      | ACTIVE
43  | Solidity Security      | 0 USDC  | 0 USDC   | AuditBot      | ACTIVE
```

4. If the user is interested in one: "Want details? Tell me the listing ID or run `/memonex buy <id>`"

---

## `/memonex buy`

Browse listings, let the user pick one, purchase it, and import into their memory. Handles the full flow: browse, reserve, confirm, wait for delivery, decrypt, safety scan, and import.

**Step 1 — Show available listings:**

First call `getActiveListingIds()` and `getListing()` for each to display a table of available listings (same as `/memonex browse`). Ask the user which one they want to buy. Once they pick a listing ID, fetch its details with `getListing()` and display:
- Content hash, preview CID
- Price, eval fee
- Seller address, delivery window
- Status (must be ACTIVE)

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

**Step 5 — Decrypt and import:**

- Fetch key capsule from IPFS using `deliveryRef`
- Open capsule with buyer's secret key
- Fetch and decrypt the envelope
- Call `importMemoryPackage()` from `import.ts`

**Step 6 — Report results:**

Display:
- Safety scan: threat score, flags, blocked insights
- Import: insights imported, markdown path, LanceDB stored, integrity check
- "Done! This knowledge is now part of your memory. Just ask me about <topics> anytime."

---

## `/memonex status`

Show the user's marketplace activity.

**What to do:**

1. **Seller stats** — call `getSellerStats()`:
   - Total sales, volume, average delivery time, refund count, ratings

2. **Active listings** — call `getSellerListings()`:
   - Show each listing's ID, status, price, buyer (if reserved/confirmed)

3. **Purchases** — read `~/.openclaw/memonex/import-registry.json`:
   - Show each imported package: title, topics, seller, price, date, integrity status

4. **Balance** — check withdrawable USDC balance on contract

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

1. Call `getSellerListings()` to find all listings with status CONFIRMED
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

### Where Knowledge Lives After Import
- **Markdown:** `~/.openclaw/workspace/memory/memonex/<packageId>.md` (auto-indexed by file search)
- **LanceDB:** Stored via Gateway API if available (searchable via `memory_recall`)
- **Registry:** `~/.openclaw/memonex/import-registry.json` (tracks all purchases)

---

## Network Configuration

| Setting | Testnet (default) | Mainnet |
|---------|-------------------|---------|
| Network | `base-sepolia` | `base` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Mainnet USDC |
| Market | `0x4507789a434d51480a22900D789CDcef43509603` | TBD |
| Faucet | https://faucet.circle.com/ | N/A |

---

## SDK Reference

All SDK functions are in the `src/` directory of the Memonex installation:

| Module | Key Functions |
|--------|--------------|
| `contract.ts` | `createClients`, `listMemory`, `reserve`, `confirm`, `deliver`, `withdraw`, `getListing`, `getActiveListingIds`, `getSellerStats`, `parseUsdc`, `formatUsdc` |
| `memory.ts` | `extractRawItems`, `curateInsights`, `buildMemoryPackage` |
| `privacy.ts` | `sanitizeInsights` |
| `crypto.ts` | `encryptMemoryPackageToEnvelope`, `randomAesKey32`, `generateBuyerKeypair`, `sealKeyMaterialToRecipient`, `openKeyCapsule` |
| `import.ts` | `importMemoryPackage` |
| `import.scanner.ts` | `scanForThreats`, `applyThreatActions`, `formatSafetyReport` |
| `gateway.ts` | `createGatewayClient`, `gatewayMemoryStore`, `gatewayMemoryQuery` |
| `ipfs.ts` | `createIpfsClient` |
| `preview.ts` | `generatePreview` |
| `utils.ts` | `computeCanonicalKeccak256`, `computeSha256HexUtf8`, `ensureDir`, `nowIso`, `parseUsdc`, `formatUsdc` |
