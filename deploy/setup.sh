#!/usr/bin/env bash
#
# One-time VPS setup for the Copymint bot. Run as root on a fresh Ubuntu box.
#
#   bash deploy/setup.sh
#
# Installs Node 22, creates an unprivileged service user, lays out the
# directories, and installs the systemd unit. It deliberately does NOT create
# the wallet store or write any secret — those steps are interactive and belong
# to you, and are printed at the end.

set -euo pipefail

APP_DIR=/opt/copymint
STATE_DIR=/var/lib/copymint
SECRET_DIR=/etc/copymint
SERVICE_USER=copymint

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  \033[90m%s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/setup.sh" >&2
  exit 1
fi

# ── Node 22 ────────────────────────────────────────────────────────────
# The bot needs a global WebSocket, which lands unflagged in Node 22. On an
# older runtime the copy-mint watcher silently falls back to polling.
say "Node.js"
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v2[2-9]* || "$(node -v)" == v[3-9][0-9]* ]]; then
  note "already on $(node -v)"
else
  note "installing Node 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

# ── Service user and directories ───────────────────────────────────────
say "User and directories"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  note "created user $SERVICE_USER"
else
  note "user $SERVICE_USER exists"
fi

install -d -m 0755 -o root -g root "$APP_DIR"
# 0700: the wallet store lives here and nothing else needs to read it.
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
install -d -m 0750 -o root -g "$SERVICE_USER" "$SECRET_DIR"
note "$APP_DIR (code)  $STATE_DIR (wallet store, 0700)  $SECRET_DIR (secrets, 0750)"

# ── Application ────────────────────────────────────────────────────────
say "Application"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  note "copying from $SOURCE_DIR"
  rsync -a --delete \
    --exclude node_modules --exclude .git --exclude dist --exclude .env \
    "$SOURCE_DIR"/ "$APP_DIR"/
fi

cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm install --no-save typescript @types/node
npx tsc
chown -R root:root "$APP_DIR"
note "built to $APP_DIR/dist"

# Write a starter config now so there is a file to edit before first start.
# The bot writes this itself at boot too, but it then refuses to run until
# vault and funder are set — better to have it on disk while you are still here.
sudo -u "$SERVICE_USER" COPYMINT_HOME="$STATE_DIR" \
  node -e 'require("'"$APP_DIR"'/dist/core/config.js").writeDefaultConfig()'
note "starter config at $STATE_DIR/config.json"

# ── Secrets file ───────────────────────────────────────────────────────
say "Secrets"
if [[ ! -f "$SECRET_DIR/env" ]]; then
  cat > "$SECRET_DIR/env" <<'TEMPLATE'
# Read by systemd, never by git. Keep this file 0640 root:copymint.

TELEGRAM_BOT_TOKEN=
OPENSEA_API_KEY=

# Unlocks seed.enc at boot. Without it the service starts and immediately
# exits, because there is no terminal to prompt at.
COPYMINT_PASSPHRASE=

RPC_URL_ETHEREUM=
RPC_URL_BASE=
RPC_URL_ROBINHOOD=

# Stay under the provider's per-second quota. QuickNode's common tier is 50.
RPC_MAX_CALLS_PER_SEC=45
TEMPLATE
  chmod 0640 "$SECRET_DIR/env"
  chown root:"$SERVICE_USER" "$SECRET_DIR/env"
  note "wrote template $SECRET_DIR/env"
else
  note "$SECRET_DIR/env exists — left alone"
fi

# ── systemd ────────────────────────────────────────────────────────────
say "systemd"
install -m 0644 "$APP_DIR/deploy/copymint.service" /etc/systemd/system/copymint.service
systemctl daemon-reload
systemctl enable copymint >/dev/null
note "unit installed and enabled (not started yet)"

# ── What is left for you ───────────────────────────────────────────────
cat <<NEXT

$(printf '\033[1mRemaining steps — these need you\033[0m')

  1. Fill in the secrets:
       nano $SECRET_DIR/env

  2. Set vault, funder and telegram.allowedChatIds:
       nano $STATE_DIR/config.json

     For the chat id: start the service, message the bot, then read
       journalctl -u copymint -n 20
     It logs the id it rejected. Put that in allowedChatIds and restart.

     Deploying for someone else? Once the bot starts, open Owner settings,
     tap Transfer ownership, and send the one-time link to the real owner.
     They can set the payout address from Telegram without SSH.

  3. Start it:
       systemctl start copymint
       journalctl -u copymint -f

  4. Create the wallet store from Telegram.

     With no store on disk the bot boots into setup mode. Whoever owns
     the wallets messages it, taps "Create wallet store", and the
     recovery phrase is shown in their chat rather than on this terminal.

     Prefer it on a terminal instead? Do this before first start:
       sudo -u $SERVICE_USER COPYMINT_HOME=$STATE_DIR \\
         node $APP_DIR/dist/tools/wallets.js init

$(printf '\033[90mNo inbound ports are needed — the bot uses long polling, so\033[0m')
$(printf '\033[90mthe firewall can stay closed to everything but SSH.\033[0m')

NEXT
