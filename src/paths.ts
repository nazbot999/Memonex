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

export function getOpenclawRoot(): string {
  if (process.env.OPENCLAW_ROOT) return process.env.OPENCLAW_ROOT;
  if (process.env.OPENCLAW_WORKSPACE) return path.dirname(process.env.OPENCLAW_WORKSPACE);
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
