import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ensureDir, readJsonFile, writeJsonFile } from "./utils.js";
import { getIpfsMockDir } from "./paths.js";

export type IpfsUploadResult = { cid: string; uri: string };

export interface IpfsClient {
  uploadJSON(obj: unknown, name: string): Promise<IpfsUploadResult>;
  fetchJSON(cidOrUri: string): Promise<unknown>;
}

function normalizeCid(input: string): string {
  if (input.startsWith("ipfs://")) return input.slice("ipfs://".length);
  const m = input.match(/\/ipfs\/([A-Za-z0-9]+)$/);
  if (m?.[1]) return m[1];
  return input;
}

function getGatewayBase(): string {
  const gw = process.env.MEMONEX_IPFS_GATEWAY?.trim();
  return gw && gw.length > 0 ? gw.replace(/\/$/, "") : "https://ipfs.io";
}

const DEFAULT_RELAY_URL = "https://memonex-ipfs.memonex.workers.dev";

function getRelayUrl(): string {
  const url = process.env.MEMONEX_RELAY_URL?.trim();
  return (url && url.length > 0 ? url : DEFAULT_RELAY_URL).replace(/\/$/, "");
}

// ---------------------------------------------------------------------------
// Relay client — proxies through the Memonex Cloudflare Worker
// ---------------------------------------------------------------------------

class RelayIpfsClient implements IpfsClient {
  constructor(private relayUrl: string) {}

  async uploadJSON(obj: unknown, name: string): Promise<IpfsUploadResult> {
    const res = await fetch(`${this.relayUrl}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: obj, name }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Relay upload failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as { cid: string; uri: string };
    return { cid: json.cid, uri: json.uri };
  }

  async fetchJSON(cidOrUri: string): Promise<unknown> {
    const cid = normalizeCid(cidOrUri);
    // Try relay's gateway proxy first
    const relayRes = await fetch(`${this.relayUrl}/ipfs/${cid}`).catch(() => null);
    if (relayRes?.ok) return relayRes.json();
    // Fallback to public gateway
    const url = `${getGatewayBase()}/ipfs/${cid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Direct Pinata client — user provides their own PINATA_JWT
// ---------------------------------------------------------------------------

class PinataIpfsClient implements IpfsClient {
  constructor(private jwt: string) {}

  async uploadJSON(obj: unknown, name: string): Promise<IpfsUploadResult> {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinataContent: obj,
        pinataMetadata: { name },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pinata upload failed: ${res.status} ${res.statusText} ${text}`);
    }

    const json = (await res.json()) as { IpfsHash: string };
    const cid = json.IpfsHash;
    return { cid, uri: `ipfs://${cid}` };
  }

  async fetchJSON(cidOrUri: string): Promise<unknown> {
    const cid = normalizeCid(cidOrUri);
    const url = `${getGatewayBase()}/ipfs/${cid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Local mock — zero config, works out of the box
// ---------------------------------------------------------------------------

class MockIpfsClient implements IpfsClient {
  private get baseDir(): string { return getIpfsMockDir(); }

  async uploadJSON(obj: unknown, name: string): Promise<IpfsUploadResult> {
    await ensureDir(this.baseDir);
    const cid = `bafyMOCK${crypto.randomBytes(12).toString("hex")}`;
    await writeJsonFile(path.join(this.baseDir, `${cid}.json`), { __name: name, ...((obj as any) ?? {}) });
    return { cid, uri: `ipfs://${cid}` };
  }

  async fetchJSON(cidOrUri: string): Promise<unknown> {
    const cid = normalizeCid(cidOrUri);
    const p = path.join(this.baseDir, `${cid}.json`);
    const local = await readJsonFile<unknown>(p);
    if (local) return local;

    // Fallback to public gateway if a real CID was provided.
    const url = `${getGatewayBase()}/ipfs/${cid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mock IPFS could not find ${cid} locally and gateway fetch failed.`);
    return res.json();
  }
}

// ---------------------------------------------------------------------------
// Eval key relay helpers — store/fetch eval AES keys via the relay worker
// ---------------------------------------------------------------------------

/** Store an eval AES key on the relay for automatic buyer delivery after reserve(). */
export async function storeEvalKey(params: {
  listingId: string;
  evalAesKeyB64: string;
  contentHash: string;
}): Promise<void> {
  const relayUrl = getRelayUrl();
  const res = await fetch(`${relayUrl}/eval-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to store eval key: ${res.status} ${text}`);
  }
}

/** Fetch a sealed eval key capsule from the relay (available after reserve()). */
export async function fetchEvalCapsule(listingId: string): Promise<unknown | null> {
  const relayUrl = getRelayUrl();
  const res = await fetch(`${relayUrl}/eval-capsule/${listingId}`);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch eval capsule: ${res.status} ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Factory — picks the best available client
//
// Priority: user's own Pinata key → relay proxy → local mock
// ---------------------------------------------------------------------------

export function createIpfsClient(): IpfsClient {
  // 1. User has their own Pinata key — use it directly (fastest, no middleman)
  const jwt = process.env.PINATA_JWT?.trim();
  if (jwt) return new PinataIpfsClient(jwt);

  // 2. Relay proxy — default for all users, no config needed
  //    Uses the shared Memonex Cloudflare Worker backed by Pinata.
  //    Override with MEMONEX_RELAY_URL env var if self-hosting.
  const relayUrl = getRelayUrl();
  return new RelayIpfsClient(relayUrl);
}
