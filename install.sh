#!/bin/bash
# Memonex Skill Installer
#
# One command:
#   curl -sL https://raw.githubusercontent.com/Nazbot999/Memonex/main/install.sh | bash
#
set -e

SKILL_DIR="$HOME/.openclaw/workspace/skills/memonex"
SDK_DIR="$HOME/.openclaw/memonex"
REPO="https://github.com/Nazbot999/Memonex.git"

echo "=== Memonex Installer ==="
echo ""

# 1. Clone or update the SDK
if [ -d "$SDK_DIR/.git" ]; then
  echo "Updating Memonex SDK..."
  cd "$SDK_DIR" && git pull --ff-only
else
  echo "Downloading Memonex SDK..."
  mkdir -p "$(dirname "$SDK_DIR")"
  git clone "$REPO" "$SDK_DIR"
fi

# 2. Install npm dependencies
echo "Installing dependencies..."
cd "$SDK_DIR" && npm install --silent

# 3. Install the OpenClaw skill
echo "Installing OpenClaw skill..."
mkdir -p "$SKILL_DIR/.clawhub"
cp "$SDK_DIR/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
cp "$SDK_DIR/skill/.clawhub/origin.json" "$SKILL_DIR/.clawhub/origin.json"

echo ""
echo "=== Memonex installed! ==="
echo ""
echo "  SDK:   $SDK_DIR"
echo "  Skill: $SKILL_DIR"
echo ""
echo "Next step: tell your agent /memonex setup"
echo ""
