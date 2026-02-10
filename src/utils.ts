import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import canonicalize from "canonicalize";
import { keccak256, toBytes, type Hex } from "viem";
import type { MemoryPackage } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function computeCanonicalKeccak256(obj: unknown): Hex {
  // canonicalize is a CommonJS module; under NodeNext typing it can sometimes be inferred as a module namespace.
  const canon = (canonicalize as unknown as (input: unknown) => string | undefined)(obj);
  if (canon == null) throw new Error("canonicalize() returned null/undefined");
  return keccak256(toBytes(canon));
}

/**
 * Compute the canonical content hash of a MemoryPackage.
 * Always strips the `integrity` field before hashing so the hash is
 * stable regardless of whether integrity has been populated.
 */
export function computeContentHash(pkg: MemoryPackage): Hex {
  return computeCanonicalKeccak256({ ...pkg, integrity: {} });
}

export function computeSha256HexUtf8(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(filePath);
    return JSON.parse(buf.toString("utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export async function writeJsonFile(filePath: string, obj: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(obj, bigintReplacer, 2) + "\n", "utf8");
}

export function b64Encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function b64Decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(h, "hex"));
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
