import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const MEMONEX_MARKET = "0x5b2FE0ed5Bef889e588FD16511E52aD9169917D1" as const satisfies Address;
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const satisfies Address;
export const EAS_BASE_SEPOLIA = "0x4200000000000000000000000000000000000021" as const satisfies Address;

// Minimal ABI for the functions we use.
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
          { name: "contentHash", type: "bytes32" },
          { name: "previewCID", type: "string" },
          { name: "encryptedCID", type: "string" },
          { name: "price", type: "uint256" },
          { name: "evalFee", type: "uint256" },
          { name: "deliveryWindow", type: "uint32" },
          { name: "status", type: "uint8" },
          { name: "buyer", type: "address" },
          { name: "buyerPubKey", type: "bytes" },
          { name: "evalFeePaid", type: "uint256" },
          { name: "reservedAt", type: "uint256" },
          { name: "remainderPaid", type: "uint256" },
          { name: "confirmedAt", type: "uint256" },
          { name: "deliveryRef", type: "string" },
          { name: "deliveredAt", type: "uint256" }
        ]
      }
    ]
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
          { name: "cancelCount", type: "uint256" }
        ]
      }
    ]
  }
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

type RpcTransport = ReturnType<typeof http>;
type WalletAccount = ReturnType<typeof privateKeyToAccount>;

export type Clients = {
  // Important: Base (OP Stack) chains include a "deposit" tx type; keep the chain type specific
  // so viem's client methods have compatible return types.
  publicClient: PublicClient<RpcTransport, typeof baseSepolia>;
  walletClient: WalletClient<RpcTransport, typeof baseSepolia, WalletAccount>;
  address: Address;
};

export type ListingTuple = {
  seller: Address;
  contentHash: Hex;
  previewCID: string;
  encryptedCID: string;
  price: bigint;
  evalFee: bigint;
  deliveryWindow: number;
  status: number;
  buyer: Address;
  buyerPubKey: Hex; // bytes
  evalFeePaid: bigint;
  reservedAt: bigint;
  remainderPaid: bigint;
  confirmedAt: bigint;
  deliveryRef: string;
  deliveredAt: bigint;
};

export function getRpcUrl(): string {
  return (
    process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
    process.env.RPC_URL?.trim() ||
    "https://sepolia.base.org"
  );
}

export function parseUsdc(input: string): bigint {
  // USDC on Base is 6 decimals.
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
  const transport = http(getRpcUrl());

  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ chain: baseSepolia, transport, account });

  return { publicClient, walletClient, address: account.address };
}

export async function ensureUsdcAllowance(params: {
  clients: Clients;
  owner: Address;
  spender: Address;
  amount: bigint;
}): Promise<void> {
  const allowance = (await params.clients.publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [params.owner, params.spender],
  })) as bigint;

  if (allowance >= params.amount) return;

  const hash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: USDC_BASE_SEPOLIA,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [params.spender, params.amount],
  });

  await params.clients.publicClient.waitForTransactionReceipt({ hash });
}

export async function getListing(params: { clients: Clients; listingId: bigint }): Promise<ListingTuple> {
  const l = (await params.clients.publicClient.readContract({
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "getListing",
    args: [params.listingId],
  })) as any;

  return l as ListingTuple;
}

export async function getActiveListingIds(params: { clients: Clients }): Promise<bigint[]> {
  return (await params.clients.publicClient.readContract({
    address: MEMONEX_MARKET,
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
}): Promise<{ listingId: bigint; txHash: Hex }> {
  // Use simulateContract to capture the return value (listingId).
  const sim = await params.clients.publicClient.simulateContract({
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "listMemory",
    args: [
      params.contentHash,
      params.previewCID,
      params.encryptedCID,
      params.priceUSDC,
      params.evalFeeUSDC,
      params.deliveryWindowSec,
    ],
    account: params.clients.address,
  });

  // Strip `account` from sim.request so walletClient uses its own local signer
  // (sim.request.account is an address string which triggers wallet_sendTransaction)
  const { account: _simAccount, ...request } = sim.request;
  const txHash = await params.clients.walletClient.writeContract({ ...request, chain: baseSepolia });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });

  return { listingId: sim.result as bigint, txHash };
}

export async function reserve(params: { clients: Clients; listingId: bigint; buyerPubKey: Uint8Array }): Promise<Hex> {
  const listing = await getListing({ clients: params.clients, listingId: params.listingId });
  await ensureUsdcAllowance({
    clients: params.clients,
    owner: params.clients.address,
    spender: MEMONEX_MARKET,
    amount: listing.evalFee,
  });

  const txHash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "reserve",
    args: [params.listingId, toHex(params.buyerPubKey)],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function confirm(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const listing = await getListing({ clients: params.clients, listingId: params.listingId });
  const remainder = listing.price - listing.evalFee;

  await ensureUsdcAllowance({
    clients: params.clients,
    owner: params.clients.address,
    spender: MEMONEX_MARKET,
    amount: remainder,
  });

  const txHash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "confirm",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function cancel(params: { clients: Clients; listingId: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "cancel",
    args: [params.listingId],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function deliver(params: { clients: Clients; listingId: bigint; deliveryRef: string }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "deliver",
    args: [params.listingId, params.deliveryRef],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function withdraw(params: { clients: Clients; amount: bigint }): Promise<Hex> {
  const txHash = await params.clients.walletClient.writeContract({
    chain: baseSepolia,
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "withdraw",
    args: [params.amount],
  });
  await params.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

export async function getWithdrawableBalance(params: { clients: Clients; account: Address }): Promise<bigint> {
  return (await params.clients.publicClient.readContract({
    address: MEMONEX_MARKET,
    abi: MEMONEX_MARKET_ABI,
    functionName: "balanceOf",
    args: [params.account],
  })) as bigint;
}
