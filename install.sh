#!/bin/bash
# Memonex Skill Installer
#
# One command:
#   curl -sL https://raw.githubusercontent.com/Nazbot999/Memonex/main/install.sh | bash
#
# Customizable via env vars:
#   OPENCLAW_ROOT=~/.myagent bash install.sh   # non-default root
#   MEMONEX_HOME=/opt/memonex bash install.sh  # explicit SDK location
#
set -e

REPO="https://github.com/Nazbot999/Memonex.git"

# --- Detect OpenClaw root ---
# Priority: explicit env var > walk up from $PWD looking for openclaw.json > ~/.openclaw
detect_openclaw_root() {
  if [ -n "$OPENCLAW_ROOT" ]; then
    echo "$OPENCLAW_ROOT"
    return
  fi
  # Walk up from current directory looking for openclaw.json (gateway config)
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/openclaw.json" ]; then
      echo "$dir"
      return
    fi
    dir="$(dirname "$dir")"
  done
  # Fallback: default location
  echo "$HOME/.openclaw"
}

OPENCLAW_ROOT="$(detect_openclaw_root)"
SDK_DIR="${MEMONEX_HOME:-$OPENCLAW_ROOT/memonex}"
SKILL_DIR="$OPENCLAW_ROOT/workspace/skills/memonex"

# Dev-only dirs to remove from a fresh clone (users don't need Foundry artifacts)
DEV_DIRS="contracts test script lib docs sample-memories broadcast cache_forge out"
DEV_FILES="foundry.toml vitest.config.ts"

echo "=== Memonex Installer ==="
echo ""
echo "  OPENCLAW_ROOT: $OPENCLAW_ROOT"
echo "  SDK dir:       $SDK_DIR"
echo "  Skill dir:     $SKILL_DIR"
echo ""

# --- Install or update ---
if [ -d "$SDK_DIR/src" ]; then
  echo "Updating Memonex SDK..."
  TEMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TEMP_DIR"' EXIT
  git clone --depth 1 --quiet "$REPO" "$TEMP_DIR"

  # Replace code files, preserve user data (.env, *.json data, node_modules)
  rm -rf "$SDK_DIR/src" "$SDK_DIR/skill"
  cp -r "$TEMP_DIR/src" "$SDK_DIR/src"
  cp -r "$TEMP_DIR/skill" "$SDK_DIR/skill"
  cp "$TEMP_DIR/package.json" "$SDK_DIR/package.json"
  cp "$TEMP_DIR/tsconfig.json" "$SDK_DIR/tsconfig.json"

  rm -rf "$TEMP_DIR"
  trap - EXIT
else
  echo "Downloading Memonex SDK..."
  mkdir -p "$(dirname "$SDK_DIR")"
  git clone --depth 1 --quiet "$REPO" "$SDK_DIR"

  # Remove dev-only directories and files (contracts, tests, Foundry artifacts)
  cd "$SDK_DIR"
  for d in $DEV_DIRS; do
    rm -rf "$SDK_DIR/$d"
  done
  for f in $DEV_FILES; do
    rm -f "$SDK_DIR/$f"
  done
  rm -rf "$SDK_DIR/.git"
fi

# --- Install npm dependencies ---
echo "Installing dependencies..."
cd "$SDK_DIR" && npm install --silent

# --- Install the OpenClaw skill ---
echo "Installing OpenClaw skill..."
mkdir -p "$SKILL_DIR/.clawhub"
cp "$SDK_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
if [ -f "$SDK_DIR/skill/.clawhub/origin.json" ]; then
  cp "$SDK_DIR/skill/.clawhub/origin.json" "$SKILL_DIR/.clawhub/origin.json"
fi

echo ""
echo "=== Memonex installed! ==="
echo ""
echo "  SDK:       $SDK_DIR"
echo "  Skill:     $SKILL_DIR"
echo "  Workspace: $OPENCLAW_ROOT/workspace"
echo ""
echo "Next step: tell your agent /memonex setup"
echo ""
