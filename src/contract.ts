import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveMemonexConfig, type MemonexChainConfig } from "./config.js";
import { createFallbackTransport } from "./transport.js";
import type { ListingTupleV2, SellerStatsV2 } from "./types.js";

/** @deprecated Use `clients.config.chainId` instead. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** @deprecated Use `clients.config.addresses.market` instead. */
export const MEMONEX_MARKET = "0x3B7F0B47B27A7c5d4d347e3062C3D00BCBA5256C" as const satisfies Address;
/** @deprecated Use `clients.config.addresses.usdc` instead. */
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const satisfies Address;
/** @deprecated Use `clients.config.addresses.eas` instead. */
export const EAS_BASE_SEPOLIA = "0x4200000000000000000000000000000000000021" as const satisfies Address;

// Full ABI matching deployed MemonexMarket contract.
export const MEMONEX_MARKET_ABI = [
  {
    type: "function",
    name: "listMemory",
    stateMutability: "nonpayable",
    inputs: [
      { name: "contentHash", type: "bytes32" },
      { name: "previewCID", type: "string" },
      { name: "encryptedCID", type: "string" },
      { name: "priceUSDC", type: "uint256" },
      { name: "evalFeeUSDC", type: "uint256" },
      { name: "deliveryWindow", type: "uint32" },
      { name: "prevListingId", type: "uint256" },
      { name: "discountBps", type: "uint16" },
    ],
    outputs: [{ name: "listingId", type: "uint256" }],
  },
  {
    type: "function",
    name: "reserve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "buyerPubKey", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "confirm",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "expireReserve",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claimRefund",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "deliver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "deliveryRef", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getActiveListingIds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getListing",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "seller", type: "address" },
          { name: "sellerAgentId", type: "uint256" },
          { name: "contentHash", type: "bytes32" },
          { name: "previewCID", type: "string" },
          { name: "encryptedCID", type: "string" },
          { name: "price", type: "uint256" },
          { name: "evalFee", type: "uint256" },
          { name: "deliveryWindow", type: "uint32" },
          { name: "status", type: "uint8" },
          { name: "prevListingId", type: "uint256" },
          { name: "discountBps", type: "uint16" },
          { name: "buyer", type: "address" },
          { name: "buyerPubKey", type: "bytes" },
          { name: "salePrice", type: "uint256" },
          { name: "evalFeePaid", type: "uint256" },
          { name: "reserveWindow", type: "uint32" },
          { name: "reservedAt", type: "uint256" },
          { name: "remainderPaid", type: "uint256" },
          { name: "confirmedAt", type: "uint256" },
          { name: "deliveryRef", type: "string" },
          { name: "deliveredAt", type: "uint256" },
          { name: "completionAttestationUid", type: "bytes32" },
          { name: "rating", type: "uint8" },
          { name: "ratedAt", type: "uint64" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getSellerStats",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "totalSales", type: "uint256" },
          { name: "totalVolume", type: "uint256" },
          { name: "avgDeliveryTime", type: "uint256" },
          { name: "refundCount", type: "uint256" },
          { name: "cancelCount", type: "uint256" },
          { name: "totalRatingSum", type: "uint256" },
          { name: "ratingCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "rateSeller",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "rating", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelListing",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registerSeller",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "updateDiscountBps",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "uint256" },
      { name: "newBps", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSellerListings",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getBuyerPurchases",
    stateMutability: "view",
    inputs: [{ name: "buyer", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getVersionHistory",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "getSellerAgentId",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSellerReputation",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "summaryValue", type: "int256" },
      { name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getSellerValidationSummary",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      { name: "count", type: "uint256" },
      { name: "averageResponse", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getValidationRequestHash",
    stateMutability: "view",
    inputs: [{ name: "listingId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  }
] as const;

type WalletAccount = ReturnType<typeof privateKeyToAccount>;

export type Clients = {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, WalletAccount>;
  address: Address;
  config: MemonexChainConfig;
};

export type ListingTuple = ListingTupleV2;

export function getRpcUrl(): string {
  return (
    process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim() ||
    "https://sepolia.base.org"
  );
}

export function parseUsdc(input: string): bigint {
  return parseUnits(input, 6);
}

export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, 6);
}

export function createClientsFromEnv(): Clients {
  const pk =
    process.env.MEMONEX_PRIVATE_KEY?.trim() ||
    process.env.PRIVATE_KEY?.trim() ||
    process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) {
    throw new Error("Missing env MEMONEX_PRIVATE_KEY (or PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)");
  }
  return createClients(pk as Hex);
}

export function createClients(privateKey: Hex): Clients {
  const account = privateKeyToAccount(privateKey);
  const config = resolveMemonexConfig();
  const transport = createFallbackTransport(config);

  const publicClient = createPublicClient({ chain: config.chain, transport });
  const walletClient = createWalletClient({ chain: config.chain, transport, account });

  return { publicClient, walletClient, address: account.address, config };
}

export async function ensureUsdcAllowance(params: {
  clients: Clients;
  owner: Address;
  spender: Address;
  amount: bigint;
}): Promise<void> {
  const usdcAddress = params.clients.config.addresses.usdc;
  const chain = params.clients.config.chain;

  const allowance = (await params.clients.publicClient.readContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [params.owner, params.spender],
  })) as bigint;

  if (allowance >= params.amount) return;

  const hash = await params.clients.walletClient.writeContract({
    chain,
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [params.spender, params.amount],
  });

  await params.clients.publicClient.waitForTransactionReceipt({ hash });
}

export async function getListing(params: { clients: Clients; listingId: bigint }): Promise<ListingTuple> {
  const l = (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getListing",
    args: [params.listingId],
  })) as any;

  return l as ListingTuple;
}

export async function getActiveListingIds(params: { clients: Clients }): Promise<bigint[]> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getActiveListingIds",
    args: [],
  })) as bigint[];
}

export async function listMemory(params: {
  clients: Clients;
  contentHash: Hex;
  previewCID: string;
  encryptedCID: string;
  priceUSDC: bigint;
  evalFeeUSDC: bigint;
  deliveryWindowSec: number;
  prevListingId?: bigint;
  discountBps?: number;
}): Promise<{ listingId: bigint; txHash: Hex }> {
  const marketAddress = params.clients.config.addresses.market;
  const chain = params.clients.config.chain;

  const sim = await params.clients.publicClient.simulateContract({
    address: marketAddress,
    abi: MEMONEX_MARKET_ABI,
    functionName: "listMemory",
    args: [
      params.contentHash,
      params.previewCID,
      params.encryptedCID,
      params.priceUSDC,
      params.evalFeeUSDC,
      params.deliveryWindowSec,
      params.prevListingId ?? 0n,
      params.discountBps ?? 0,
    ],
    account: params.clients.address,
  });

  const { account: _simAccount, ...request } = sim.request;
  const txHash = await params.clients.walletClient.writeContract({ ...request, chain });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });

  return { listingId: sim.result as bigint, txHash };
}

export async function reserve(params: { clients: Clients; listingId: bigint; buyerPubKey: Uint8Array }): Promise<Hex> {
  const marketAddress = params.clients.config.addresses.market;
  const chain = params.clients.config.chain;

  const listing = await getListing({ clients: params.clients, listingId: params.listingId });
  const approvalAmount = listing.price; // approve total upfront to cover reserve + confirm
  await ensureUsdcAllowance({
    clients: params.clients,
    owner: params.clients.address,
    spender: marketAddress,
    amount: approvalAmount,
  });

  const txHash = await params.clients.walletClient.writeContract({
    chain,
    address: marketAddress,
    abi: MEMONEX_MARKET_ABI,
    functionName: "reserve",
    args: [params.listingId, toHex(params.buyerPubKey)],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function confirm(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const marketAddress = params.clients.config.addresses.market;
  const chain = params.clients.config.chain;

  const listing = await getListing({ clients: params.clients, listingId: params.listingId });
  const remainder = listing.salePrice - listing.evalFeePaid;

  await ensureUsdcAllowance({
    clients: params.clients,
    owner: params.clients.address,
    spender: marketAddress,
    amount: remainder,
  });

  const txHash = await params.clients.walletClient.writeContract({
    chain,
    address: marketAddress,
    abi: MEMONEX_MARKET_ABI,
    functionName: "confirm",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function cancel(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "cancel",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function deliver(params: { clients: Clients; listingId: bigint; deliveryRef: string }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "deliver",
    args: [params.listingId, params.deliveryRef],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function withdraw(params: { clients: Clients; amount: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "withdraw",
    args: [params.amount],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function getWithdrawableBalance(params: { clients: Clients; account: Address }): Promise<bigint> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "balanceOf",
    args: [params.account],
  })) as bigint;
}

export async function getSellerStats(params: { clients: Clients; seller: Address }): Promise<SellerStatsV2> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerStats",
    args: [params.seller],
  })) as SellerStatsV2;
}

export function computeAverageRating(stats: SellerStatsV2): number {
  if (stats.ratingCount === 0n) return 0;
  return Number(stats.totalRatingSum) / Number(stats.ratingCount);
}

export async function rateSeller(params: { clients: Clients; listingId: bigint; rating: number }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "rateSeller",
    args: [params.listingId, params.rating],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function cancelListing(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "cancelListing",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function expireReserve(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "expireReserve",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function claimRefund(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "claimRefund",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function getSellerListings(params: { clients: Clients; seller: Address }): Promise<bigint[]> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerListings",
    args: [params.seller],
  })) as bigint[];
}

export async function getBuyerPurchases(params: { clients: Clients; buyer: Address }): Promise<bigint[]> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getBuyerPurchases",
    args: [params.buyer],
  })) as bigint[];
}

export async function getVersionHistory(params: { clients: Clients; listingId: bigint }): Promise<bigint[]> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getVersionHistory",
    args: [params.listingId],
  })) as bigint[];
}

export async function getSellerAgentId(params: { clients: Clients; seller: Address }): Promise<bigint> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerAgentId",
    args: [params.seller],
  })) as bigint;
}

export async function getSellerReputation(params: { clients: Clients; seller: Address }): Promise<{
  count: bigint;
  summaryValue: bigint;
  summaryValueDecimals: number;
}> {
  const result = await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerReputation",
    args: [params.seller],
  });
  const [count, summaryValue, summaryValueDecimals] = result as [bigint, bigint, number];
  return { count, summaryValue, summaryValueDecimals };
}

export async function getSellerValidationSummary(params: { clients: Clients; seller: Address }): Promise<{
  count: bigint;
  averageResponse: bigint;
}> {
  const result = await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getSellerValidationSummary",
    args: [params.seller],
  });
  const [count, averageResponse] = result as [bigint, bigint];
  return { count, averageResponse };
}

export async function getValidationRequestHash(params: { clients: Clients; listingId: bigint }): Promise<`0x${string}`> {
  return (await params.clients.publicClient.readContract({
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getValidationRequestHash",
    args: [params.listingId],
  })) as `0x${string}`;
}

export async function registerSeller(params: { clients: Clients; agentURI: string }): Promise<bigint> {
  const marketAddress = params.clients.config.addresses.market;
  const chain = params.clients.config.chain;

  const sim = await params.clients.publicClient.simulateContract({
    address: marketAddress,
    abi: MEMONEX_MARKET_ABI,
    functionName: "registerSeller",
    args: [params.agentURI],
    account: params.clients.address,
  });

  const { account: _simAccount, ...request } = sim.request;
  const txHash = await params.clients.walletClient.writeContract({ ...request, chain });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return sim.result as bigint;
}

export async function updateDiscountBps(params: { clients: Clients; listingId: bigint; newBps: number }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: params.clients.config.chain,
    address: params.clients.config.addresses.market,
    abi: MEMONEX_MARKET_ABI,
    functionName: "updateDiscountBps",
    args: [params.listingId, params.newBps],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}
