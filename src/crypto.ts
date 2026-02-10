import crypto from "node:crypto";

import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import type { Hex } from "viem";

import type {
  BuyerKeypairFileV1,
  EncryptedEnvelopeV1,
  KeyCapsuleV1,
  SellerKeystoreFile,
  SellerKeystorePlainV1,
  SellerKeystoreRecordV1,
} from "./types.js";
import { getMemonexHome, getBuyerKeyFile, getSellerKeystoreFile } from "./paths.js";
import { b64Decode, b64Encode, ensureDir, nowIso, readJsonFile, writeJsonFile } from "./utils.js";

export function randomAesKey32(): Buffer {
  return crypto.randomBytes(32);
}

export function aesGcmEncrypt(plaintext: Buffer, key32: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct, tag };
}

export function aesGcmDecrypt(ct: Buffer, key32: Buffer, iv: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptMemoryPackageToEnvelope(params: { plaintextJson: string; contentHash: Hex; aesKey32: Buffer }): EncryptedEnvelopeV1 {
  const aadStr = `memonex:${params.contentHash}`;
  const aad = Buffer.from(aadStr, "utf8");

  const { iv, ct, tag } = aesGcmEncrypt(Buffer.from(params.plaintextJson, "utf8"), params.aesKey32, aad);

  return {
    v: 1,
    alg: "AES-256-GCM",
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
    ctB64: ct.toString("base64"),
    aad: aadStr,
    contentHash: params.contentHash,
    mime: "application/json",
  };
}

export function decryptEnvelope(params: { envelope: EncryptedEnvelopeV1; aesKey32: Buffer }): string {
  const iv = Buffer.from(params.envelope.ivB64, "base64");
  const tag = Buffer.from(params.envelope.tagB64, "base64");
  const ct = Buffer.from(params.envelope.ctB64, "base64");
  const aad = Buffer.from(params.envelope.aad, "utf8");

  const pt = aesGcmDecrypt(ct, params.aesKey32, iv, tag, aad);
  return pt.toString("utf8");
}

export function generateBuyerKeypair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  // tweetnacl.box uses X25519 keys
  return nacl.box.keyPair();
}

export async function saveBuyerKeypair(kp: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<void> {
  const file: BuyerKeypairFileV1 = {
    v: 1,
    scheme: "x25519-box",
    publicKeyB64: b64Encode(kp.publicKey),
    secretKeyB64: b64Encode(kp.secretKey),
    createdAt: nowIso(),
  };
  await writeJsonFile(getBuyerKeyFile(), file);
}

export async function loadBuyerKeypair(): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array } | null> {
  const file = await readJsonFile<BuyerKeypairFileV1>(getBuyerKeyFile());
  if (!file) return null;
  if (file.v !== 1 || file.scheme !== "x25519-box") throw new Error("Unsupported buyer key file format");
  return { publicKey: b64Decode(file.publicKeyB64), secretKey: b64Decode(file.secretKeyB64) };
}

export function sealKeyMaterialToRecipient(params: {
  recipientPubKey: Uint8Array;
  plaintext: Uint8Array;
  note?: string;
}): KeyCapsuleV1 {
  const eph = nacl.box.keyPair();
  const nonce = crypto.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(params.plaintext, nonce, params.recipientPubKey, eph.secretKey);

  return {
    v: 1,
    scheme: "x25519-box",
    recipientPubKeyB64: b64Encode(params.recipientPubKey),
    ephemeralPubKeyB64: b64Encode(eph.publicKey),
    nonceB64: Buffer.from(nonce).toString("base64"),
    ctB64: b64Encode(ct),
    note: params.note,
  };
}

export function openKeyCapsule(params: { capsule: KeyCapsuleV1; recipientSecretKey: Uint8Array }): Uint8Array {
  if (params.capsule.v !== 1 || params.capsule.scheme !== "x25519-box") {
    throw new Error("Unsupported capsule format");
  }

  const recipientPk = b64Decode(params.capsule.recipientPubKeyB64);
  const ephPk = b64Decode(params.capsule.ephemeralPubKeyB64);
  const nonce = new Uint8Array(Buffer.from(params.capsule.nonceB64, "base64"));
  const ct = b64Decode(params.capsule.ctB64);

  const pt = nacl.box.open(ct, nonce, ephPk, params.recipientSecretKey);
  if (!pt) throw new Error("Failed to open key capsule (wrong key or corrupted capsule)");

  return pt;
}

export function encodeKeyMaterialJson(params: { aesKey32: Buffer; contentHash: Hex }): Uint8Array {
  const obj = { aesKeyB64: params.aesKey32.toString("base64"), contentHash: params.contentHash };
  return naclUtil.decodeUTF8(JSON.stringify(obj));
}

export function decodeKeyMaterialJson(pt: Uint8Array): { aesKey32: Buffer; contentHash: Hex } {
  const s = naclUtil.encodeUTF8(pt);
  const obj = JSON.parse(s) as { aesKeyB64: string; contentHash: Hex };
  return { aesKey32: Buffer.from(obj.aesKeyB64, "base64"), contentHash: obj.contentHash };
}

function getKeystorePassphrase(): string | null {
  return process.env.MEMONEX_KEYSTORE_PASSPHRASE?.trim() || null;
}

function encryptKeystoreJson(plaintextJson: string, passphrase: string): SellerKeystoreFile {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const aad = Buffer.from("memonex:keystore:v1", "utf8");
  const { iv, ct, tag } = aesGcmEncrypt(Buffer.from(plaintextJson, "utf8"), key, aad);

  return {
    v: 1,
    encrypted: true,
    kdf: "scrypt",
    saltB64: salt.toString("base64"),
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
    ctB64: ct.toString("base64"),
  };
}

function decryptKeystoreJson(file: SellerKeystoreFile, passphrase: string): SellerKeystorePlainV1 {
  if (file.v !== 1 || file.encrypted !== true) throw new Error("Not an encrypted keystore");
  const salt = Buffer.from(file.saltB64, "base64");
  const iv = Buffer.from(file.ivB64, "base64");
  const tag = Buffer.from(file.tagB64, "base64");
  const ct = Buffer.from(file.ctB64, "base64");
  const key = crypto.scryptSync(passphrase, salt, 32);
  const aad = Buffer.from("memonex:keystore:v1", "utf8");
  const pt = aesGcmDecrypt(ct, key, iv, tag, aad).toString("utf8");
  const parsed = JSON.parse(pt) as SellerKeystorePlainV1;
  if (parsed.v !== 1 || parsed.encrypted !== false) throw new Error("Invalid decrypted keystore format");
  return parsed;
}

export async function loadSellerKeystore(): Promise<SellerKeystorePlainV1> {
  const file = await readJsonFile<SellerKeystoreFile>(getSellerKeystoreFile());
  if (!file) return { v: 1, encrypted: false, records: [] };

  if (file.v !== 1) throw new Error("Unsupported seller keystore format");

  if (file.encrypted === false) return file;

  const pass = getKeystorePassphrase();
  if (!pass) {
    throw new Error(
      `Seller keystore is encrypted but MEMONEX_KEYSTORE_PASSPHRASE is not set. File: ${getSellerKeystoreFile()}`
    );
  }

  return decryptKeystoreJson(file, pass);
}

export async function saveSellerKeystore(plain: SellerKeystorePlainV1): Promise<void> {
  await ensureDir(getMemonexHome());
  const pass = getKeystorePassphrase();

  if (!pass) {
    console.warn(
      "[memonex] WARNING: MEMONEX_KEYSTORE_PASSPHRASE not set — saving keystore in plaintext. " +
      "Set this env var to encrypt AES keys at rest."
    );
  }

  const payload: SellerKeystoreFile = pass
    ? encryptKeystoreJson(JSON.stringify(plain), pass)
    : plain;

  await writeJsonFile(getSellerKeystoreFile(), payload);
}

export async function upsertSellerKeyRecord(rec: SellerKeystoreRecordV1): Promise<void> {
  const ks = await loadSellerKeystore();
  const idx = ks.records.findIndex((r) => r.contentHash === rec.contentHash);
  if (idx >= 0) ks.records[idx] = { ...ks.records[idx], ...rec };
  else ks.records.push(rec);
  await saveSellerKeystore(ks);
}

export async function findSellerKeyRecordByListingId(listingId: bigint): Promise<SellerKeystoreRecordV1 | null> {
  const ks = await loadSellerKeystore();
  return ks.records.find((r) => r.listingId === listingId) ?? null;
}

export async function findSellerKeyRecordByContentHash(contentHash: Hex): Promise<SellerKeystoreRecordV1 | null> {
  const ks = await loadSellerKeystore();
  return ks.records.find((r) => r.contentHash === contentHash) ?? null;
}
