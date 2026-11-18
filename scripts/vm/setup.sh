#!/usr/bin/env bash
# One-time setup of the EarningsLens job runner on the Mumbai VM.
# Idempotent: safe to re-run. Installs everything under the user's home; no sudo,
# no system packages, nothing that touches the tick-trade bot.
#
#   ssh opc@VM 'bash -s' < scripts/vm/setup.sh
#   scp .env.local opc@VM:~/earningslens/.env.local
set -euo pipefail

APP="$HOME/earningslens"
NODE_DIR="$HOME/.local/node"
NODE_MAJOR=22

case "$(uname -m)" in
  aarch64|arm64) ARCH=arm64 ;;
  x86_64)        ARCH=x64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

if [ ! -x "$NODE_DIR/bin/node" ]; then
  V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import json,sys;print(next(r['version'] for r in json.load(sys.stdin) if r['lts'] and r['version'].startswith('v$NODE_MAJOR')))")
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-$ARCH.tar.xz" -o "$TMP/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep "node-$V-linux-$ARCH.tar.xz" | sed "s|node-$V-linux-$ARCH.tar.xz|$TMP/node.tar.xz|" | sha256sum -c -
  mkdir -p "$HOME/.local"
  tar -xJf "$TMP/node.tar.xz" -C "$HOME/.local"
  ln -sfn "$HOME/.local/node-$V-linux-$ARCH" "$NODE_DIR"
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "node $(node -v)"

if [ ! -d "$APP/.git" ]; then
  git clone --depth 50 https://github.com/ronikdedhia/EarningsLens.git "$APP"
fi
cd "$APP"
git pull --ff-only -q
npm ci --no-audit --no-fund --omit=optional >/dev/null
mkdir -p "$APP/logs"
chmod +x scripts/vm/run.sh

# Cron (VM clock is UTC): 16:00 / 19:00 IST daily, Friday 12:00 IST.
MARK="# earningslens"
( crontab -l 2>/dev/null | grep -v "$MARK" ; cat <<EOF
30 10 * * * $APP/scripts/vm/run.sh daily   $MARK
30 13 * * * $APP/scripts/vm/run.sh evening $MARK
30 6 * * 5  $APP/scripts/vm/run.sh refresh $MARK
EOF
) | crontab -
echo "cron:"; crontab -l | grep "$MARK"

[ -f "$APP/.env.local" ] || echo "!! copy .env.local to $APP/.env.local"
echo "setup done"
