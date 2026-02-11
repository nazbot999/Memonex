import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Central path resolution for the Memonex SDK.
 *
 * All paths derive from three roots, each overridable via env var:
 *
 *   OPENCLAW_ROOT      (default: ~/.openclaw)
 *   OPENCLAW_WORKSPACE (default: <OPENCLAW_ROOT>/workspace)
 *   MEMONEX_HOME       (default: <OPENCLAW_ROOT>/memonex)
 *
 * Every function reads env vars at call time (not import time) so that
 * tests and late-binding configs work correctly.
 */

/** Heuristic: does `dir` look like an OpenClaw root directory? */
function looksLikeOpenclawRoot(dir: string): boolean {
  try {
    if (fs.statSync(path.join(dir, "openclaw.json"), { throwIfNoEntry: false })) return true;
    if (fs.statSync(path.join(dir, "workspace"), { throwIfNoEntry: false })?.isDirectory()) return true;
  } catch {
    // fs errors → not a valid root
  }
  return false;
}

export function getOpenclawRoot(): string {
  // 1. Explicit env var (highest priority)
  if (process.env.OPENCLAW_ROOT) return process.env.OPENCLAW_ROOT;

  // 2. Derive from workspace env var
  if (process.env.OPENCLAW_WORKSPACE) return path.dirname(process.env.OPENCLAW_WORKSPACE);

  // 3. Derive from MEMONEX_HOME (parent dir, validated)
  if (process.env.MEMONEX_HOME) {
    const candidate = path.dirname(process.env.MEMONEX_HOME);
    if (looksLikeOpenclawRoot(candidate)) return candidate;
  }

  // 4. Infer from cwd — scripts run via `cd $MEMONEX_HOME && npx tsx ...`
  //    so cwd is MEMONEX_HOME and parent is the OpenClaw root
  const cwdParent = path.dirname(process.cwd());
  if (looksLikeOpenclawRoot(cwdParent)) return cwdParent;

  // 5. Fallback: default location
  return path.join(os.homedir(), ".openclaw");
}

export function getWorkspacePath(): string {
  return process.env.OPENCLAW_WORKSPACE ?? path.join(getOpenclawRoot(), "workspace");
}

export function getMemonexHome(): string {
  return process.env.MEMONEX_HOME ?? path.join(getOpenclawRoot(), "memonex");
}

export function getBuyerKeyFile(): string {
  return path.join(getMemonexHome(), "buyer-key.json");
}

export function getSellerKeystoreFile(): string {
  return path.join(getMemonexHome(), "keystore.json");
}

export function getImportRegistryPath(): string {
  return path.join(getMemonexHome(), "import-registry.json");
}

export function getIpfsMockDir(): string {
  return path.join(getMemonexHome(), "ipfs-mock");
}

export function getGatewayConfigPath(): string {
  return path.join(getOpenclawRoot(), "openclaw.json");
}

export function getMemoryDir(): string {
  return path.join(getWorkspacePath(), "memory");
}

/** Returns the basename of the OpenClaw root dir (for deny-list matching). */
export function getOpenclawRootDirName(): string {
  return path.basename(getOpenclawRoot());
}
