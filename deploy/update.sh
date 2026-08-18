#!/usr/bin/env bash
#
# Update an already-installed Copymint box to the latest main, in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/jaysoftwares/nft-public-mint/main/deploy/update.sh | bash
#
# or, from a clone:
#
#   bash deploy/update.sh
#
# setup.sh is the installer and is idempotent, but on its own it leaves three
# things to remember: /opt/copymint is an rsync target rather than a checkout so
# the pull has to happen somewhere else, a rebuild changes nothing until the
# process restarts, and "systemctl restart" reports success whether or not the
# new code is what came up. This does all three and then proves the restart
# actually took the new build, because a deploy that silently kept running the
# old code is the failure worth guarding against.
#
# Safe to re-run. It never overwrites a value already in the secrets file.

set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/jaysoftwares/nft-public-mint}
BRANCH=${BRANCH:-main}
CLONE_DIR=${CLONE_DIR:-/opt/copymint-src}
APP_DIR=/opt/copymint
SECRET_DIR=/etc/copymint
SERVICE=copymint

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  \033[90m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/update.sh" >&2
  exit 1
fi

# ── Source ─────────────────────────────────────────────────────────────
# Prefer the clone this script was run from, when it is one. Otherwise keep a
# checkout of our own under /opt so a cleared /tmp cannot lose it.
say "Source"
# Piped from curl there is no script file, and BASH_SOURCE is unset — which
# under `set -u` is an error, not an empty string. Guard before reading it.
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
fi
if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/.git" ]]; then
  CLONE_DIR="$SCRIPT_DIR"
  note "using the clone this script came from: $CLONE_DIR"
fi

if [[ -d "$CLONE_DIR/.git" ]]; then
  git -C "$CLONE_DIR" fetch origin "$BRANCH"
  # Hard reset rather than pull: /opt/copymint is the thing that runs, so a
  # local edit here is a stale experiment, not work worth a merge conflict.
  git -C "$CLONE_DIR" checkout -q "$BRANCH"
  git -C "$CLONE_DIR" reset -q --hard "origin/$BRANCH"
else
  note "cloning $REPO_URL into $CLONE_DIR"
  git clone -q --branch "$BRANCH" "$REPO_URL" "$CLONE_DIR"
fi
note "now at $(git -C "$CLONE_DIR" log --oneline -1)"

# ── Secrets ────────────────────────────────────────────────────────────
#
# Only ever appends keys that are missing. An empty key counts as present, so a
# value you deliberately blanked is never refilled behind your back.
say "Secrets"
add_key() {
  local key=$1 value=$2 comment=${3:-}
  if [[ ! -f "$SECRET_DIR/env" ]]; then
    warn "$SECRET_DIR/env does not exist — run deploy/setup.sh first"
    return
  fi
  if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$SECRET_DIR/env"; then
    note "$key already present — left alone"
    return
  fi
  {
    printf '\n'
    [[ -n "$comment" ]] && printf '# %s\n' "$comment"
    printf '%s=%s\n' "$key" "$value"
  } >> "$SECRET_DIR/env"
  note "added $key"
}

# The copy-mint watcher subscribes over WebSocket and falls back to polling when
# the endpoint cannot serve one. Most public RPCs cannot: mainnet.base.org
# answers the upgrade with 405 and both Robinhood endpoints with 400. These two
# hosts do, which buys back push delivery on the chains where it is available.
add_key WS_URL_BASE "wss://base-rpc.publicnode.com" \
  "Log subscriptions for Base. mainnet.base.org cannot serve WebSocket (405)."
add_key WS_URL_ETHEREUM "wss://ethereum-rpc.publicnode.com" \
  "Log subscriptions for Ethereum."

# Robinhood publishes no public WebSocket endpoint, so it is left to poll. Set
# this to an Alchemy or QuickNode wss:// URL to get push delivery there too.
if ! grep -qE "^[[:space:]]*#?[[:space:]]*WS_URL_ROBINHOOD=" "$SECRET_DIR/env" 2>/dev/null; then
  {
    printf '\n'
    printf '# Robinhood has no public WebSocket endpoint — copy-mint polls there\n'
    printf '# instead, which works but is one poll slower. Uncomment with a real\n'
    printf '# provider URL for push delivery.\n'
    printf '# WS_URL_ROBINHOOD=wss://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY\n'
  } >> "$SECRET_DIR/env"
  note "noted WS_URL_ROBINHOOD (commented — needs your provider key)"
fi

# ── Build and install ──────────────────────────────────────────────────
say "Build"
bash "$CLONE_DIR/deploy/setup.sh"

# ── Restart, and prove it took ─────────────────────────────────────────
say "Restart"
systemctl restart "$SERVICE"

if [[ ! -f "$APP_DIR/dist/bot/index.js" ]]; then
  warn "no build at $APP_DIR/dist/bot/index.js — setup.sh did not produce one"
  exit 1
fi
BUILT_AT=$(stat -c %Y "$APP_DIR/dist/bot/index.js")
STARTED_RAW=$(systemctl show "$SERVICE" -p ActiveEnterTimestamp --value)
STARTED_AT=$(date -d "$STARTED_RAW" +%s 2>/dev/null || echo 0)

if [[ "$STARTED_AT" -eq 0 ]]; then
  # An unreadable timestamp is not evidence of a bad deploy, so do not claim one.
  warn "could not read the unit's start time (got '$STARTED_RAW')"
  warn "check by hand: systemctl status $SERVICE"
elif [[ "$STARTED_AT" -ge "$BUILT_AT" ]]; then
  note "running code built $(date -d "@$BUILT_AT" '+%H:%M:%S'), started $(date -d "@$STARTED_AT" '+%H:%M:%S')"
else
  warn "the service started BEFORE the current build — it is running old code."
  warn "  built:   $(date -d "@$BUILT_AT")"
  warn "  started: $STARTED_RAW"
  exit 1
fi

systemctl is-active --quiet "$SERVICE" || {
  warn "service is not active — showing the last 30 lines"
  journalctl -u "$SERVICE" -n 30 --no-pager
  exit 1
}

cat <<NEXT

$(printf '\033[1mUpdated.\033[0m') Watch it come up:

  journalctl -u $SERVICE -f

Within a few seconds each chain reports how it is watching. Robinhood should
now say it is switching to polling rather than reconnecting on a loop.

NEXT
