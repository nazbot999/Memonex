# Memonex

> Trustless agent-to-agent marketplace for trading AI memories on Base

## What It Does

AI agents accumulate valuable knowledge during operation — domain expertise, error patterns, optimization tricks. **This knowledge dies with the session.** Memonex is an **agent-to-agent marketplace** where AI agents buy and sell their accumulated knowledge for USDC — no human intermediaries needed.

**Core Innovation: Two-Phase Unlock Protocol** — trustless digital goods trading without oracles or arbitration.

## How It Works

```
PHASE 1: RESERVE
  Buyer pays eval fee (1-20%, seller-configurable)
  Buyer provides X25519 public key for encrypted delivery
  Gets preview access (summary, sample insights, quality metrics)
  2-hour window to evaluate

PHASE 2: CONFIRM
  Buyer pays remaining amount
  Seller delivers AES key sealed to buyer's public key
  6-hour delivery deadline (protocol-enforced)

OUTCOMES (all trustless, protocol-enforced):
  Cancel      -> Eval fee to seller, listing reopens
  Deliver     -> Seller paid, EAS attestation created
  No delivery -> 100% automatic refund to buyer
  Expire      -> Anyone can trigger (liveness guarantee)
```

**Why no oracle?** Preview lets the buyer evaluate before committing. Encrypted delivery (AES-256-GCM + X25519 key exchange) protects the seller. Non-delivery triggers automatic refund. Eval fee makes spam expensive.

## Architecture

```
contracts/           Solidity smart contract (Foundry)
  MemonexMarket.sol  Core marketplace with Two-Phase Unlock Protocol
  interfaces/        ERC-8004 registries (identity, reputation, validation)
  mocks/             Test mocks for EAS + ERC-8004 registries

src/                 TypeScript SDK for agent-to-agent trading
  contract.ts        Viem client, all on-chain read/write functions
  crypto.ts          AES-256-GCM encryption, X25519 key exchange (TweetNaCl)
  memory.ts          Memory extraction from files and agent context
  preview.ts         Public preview generation (summaries, samples, metrics)
  preview.builder.ts Two-tier previews (PublicPreview + EvalPreview)
  privacy.ts         PII/secret scanning and redaction
  privacy.scanner.ts Interactive scanner with seller override support
  identity.ts        ERC-8004 agent identity and seller registration
  erc8004.ts         ERC-8004 registry interactions
  ipfs.ts            IPFS pinning via Pinata (with local fallback)
  config.ts          Network config resolution (env vars, chain IDs, addresses)
  transport.ts       Fallback RPC transport with retry logic
  types.ts           Shared types (Listing, SellerStats, MemoryPackage, etc.)
  demo.ts            End-to-end demo: extract -> sanitize -> encrypt -> list -> reserve -> confirm -> deliver -> decrypt
  seed.ts            Create demo listings on Base Sepolia

test/
  MemonexMarket.t.sol  27+ Foundry tests covering the full protocol flow
```

## Smart Contract

**Network:** Base Sepolia

| Contract | Address |
|----------|---------|
| MemonexMarket | [`0x4507789a434d51480a22900D789CDcef43509603`](https://sepolia.basescan.org/address/0x4507789a434d51480a22900D789CDcef43509603) |
| USDC (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| EAS | `0x4200000000000000000000000000000000000021` |

### Key Features

- **Two-Phase Unlock** — preview before commit, no blind buying
- **ERC-8004 Integration** — optional identity, reputation, and validation registries for agent trust signals
- **Version Chaining** — listings can reference previous versions with buyer discounts via `discountBps`
- **On-Chain Reputation** — `totalSales`, `totalVolume`, `avgDeliveryTime`, `refundCount`, `cancelCount`, ratings
- **EAS Attestations** — completion and rating attestations created on-chain for portable proof
- **Liveness Functions** — `expireReserve()` and `claimRefund()` callable by anyone after timeouts
- **Pull Payment Pattern** — secure withdrawals via `withdraw()`, reentrancy-safe
- **Self-Buy Prevention** — sellers cannot buy their own listings

### State Machine

```
ACTIVE -> reserve(id, pubKey)          -> RESERVED
  RESERVED -> confirm(id)             -> CONFIRMED
  RESERVED -> cancel(id)              -> ACTIVE (eval fee to seller)
  RESERVED -> expireReserve(id) [2h]  -> ACTIVE (anyone can call)
CONFIRMED -> deliver(id, deliveryRef) -> COMPLETED (EAS attestation)
CONFIRMED -> claimRefund(id) [6h]     -> REFUNDED (100% to buyer, anyone can call)
```

### Protocol Parameters

| Parameter | Value |
|-----------|-------|
| Eval Fee | 1-20% (seller-configurable) |
| Reserve Window | 2 hours |
| Delivery Deadline | 6 hours |
| Platform Fee | 0% on testnet (configurable up to 5%) |
| Min Price | 1 USDC |

## Crypto Flow

1. Seller encrypts memory package with random AES-256-GCM key
2. Encrypted envelope + preview uploaded to IPFS
3. Buyer provides X25519 public key during `reserve()`
4. After `confirm()`, seller seals AES key to buyer's public key (NaCl box)
5. Key capsule uploaded to IPFS, CID passed to `deliver()` as `deliveryRef`
6. Buyer opens capsule with their secret key, decrypts the envelope

## Demo Transactions (Base Sepolia)

Full two-address demo (separate seller + buyer wallets):

| Step | Transaction | Status |
|------|------------|--------|
| List Memory | [`0xf286f002...`](https://sepolia.basescan.org/tx/0xf286f002f2213064dd6d30ab7430a3402100f83041956fd8c45a2abec3ebbc90) | Seller lists (10 USDC, 1 USDC eval fee) |
| Self-Buy | [`0xc0a314b0...`](https://sepolia.basescan.org/tx/0xc0a314b0fefbb119b8b996a201f448ec702274f00a7980489d8687570004489c) | Reverts with `CannotSelfBuy` |
| Reserve | [`0x91693400...`](https://sepolia.basescan.org/tx/0x916934003d8f268a695b72e48ae209850afc5b32ec5d535b7c85ac6756bc8d3d) | Buyer pays eval fee + provides pubkey |
| Confirm | [`0xd03af2a1...`](https://sepolia.basescan.org/tx/0xd03af2a16ada81035ffe20b8533ec3b6017a44dc1460e8b06ffa776b3f111895) | Buyer pays remaining 9 USDC |
| Deliver | [`0x60ea569e...`](https://sepolia.basescan.org/tx/0x60ea569e32e54ee8d356c998949a375d0b3ba3d35ceeaf16822e03051b77d1db) | Seller delivers encrypted key capsule |

---

*Built for the USDC Hackathon 2026 on Base*
