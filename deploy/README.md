# Deploying to a VPS

The bot uses Telegram long polling, so **no inbound ports are needed** — the
firewall can stay closed to everything but SSH.

## Why a VPS at all

Not latency. Copy-mint has roughly 1.4 seconds of slack before the next block,
and moving from a home connection (~240ms to Base) to a VPS (~5–20ms) recovers
time you were not spending. The reason is **uptime**: a missed signal is a total
loss, where 200ms of round-trip is a rounding error. A home machine that sleeps,
reboots for updates, or loses its connection misses drops.

Latency does matter for a timed FCFS open, where everyone fires at once and
arrival order decides the outcome.

## One-time setup

```bash
# on the VPS, as root
git clone <your repo> /tmp/copymint && cd /tmp/copymint
bash deploy/setup.sh
```

That installs Node 22 (the copy-mint watcher needs a global `WebSocket`, which
lands unflagged there), creates an unprivileged `copymint` user, lays out
directories, builds, and installs the systemd unit. It stops short of anything
that needs a decision from you.

| Path | Contents | Mode |
|---|---|---|
| `/opt/copymint` | code and `dist/` | `0755 root` |
| `/var/lib/copymint` | wallet store, config, ledger | `0700 copymint` |
| `/etc/copymint/env` | secrets read by systemd | `0640 root:copymint` |

## The four steps setup.sh leaves to you

**1. Secrets** — `nano /etc/copymint/env`. Bot token, OpenSea key, RPC URLs, and
`COPYMINT_PASSPHRASE`.

That passphrase is the honest tradeoff of unattended restart. The seed is
encrypted at rest, but a passphrase sitting beside it on the same disk means the
encryption protects against a stolen backup or a snapshot, not against someone
who already has root. If you would rather it never touch the disk, leave it
blank and unlock by hand after each restart — the service will exit immediately
on boot until you do.

**2. Wallet store** — create it as the service user so the files end up owned
correctly:

```bash
sudo -u copymint COPYMINT_HOME=/var/lib/copymint \
  node /opt/copymint/dist/tools/wallets.js init
sudo -u copymint COPYMINT_HOME=/var/lib/copymint \
  node /opt/copymint/dist/tools/wallets.js generate 500
```

`init` prints a recovery phrase once. Write it on paper. It restores every
derived wallet — but **not** imported keys, which live in `imported.enc` and
need their own backup.

**3. Config** — `nano /var/lib/copymint/config.json`. Set `vault`, `funder` and
`telegram.allowedChatIds`.

For the chat id: start the service, message the bot, then read
`journalctl -u copymint -n 20`. It logs the id it rejected. Add that id and
restart.

The vault and funder addresses are deliberately unreachable from Telegram. A
compromised Telegram account can make the bot mint and sweep, but everything it
moves still lands at an address only changeable over SSH.

**4. Start**

```bash
systemctl start copymint
journalctl -u copymint -f
```

## Operating

```bash
systemctl status copymint
systemctl restart copymint
journalctl -u copymint -f          # follow
journalctl -u copymint -p err      # errors only
```

`Restart=always` brings it back after a crash; `StartLimitBurst=10` means a
genuine config error stops the unit instead of looping forever. If it will not
start, `journalctl -u copymint -n 50` almost always names the reason — a missing
secret, or `vault`/`funder` unset.

**`copy.enabled` is `false` by default, and `/copy on` does not survive a
restart.** Autonomous spending resumes after a reboot only because
`config.json` says it should.

## Updating

```bash
cd /opt/copymint && git pull
npm install --omit=dev && npx tsc
systemctl restart copymint
```

The wallet store lives in `/var/lib/copymint` and is untouched by any of that.

## Sanity checks before trusting it

The `npm run …` shortcuts go through `ts-node`, which is a devDependency and is
**not installed here** — `setup.sh` installs production dependencies only. On
the VPS, run the compiled tools directly:

```bash
cd /opt/copymint
set -a; . /etc/copymint/env; set +a     # RPC URLs and keys into the shell

node dist/tools/verify.js                        # offline, no network or keys
node dist/tools/shakedown.js --chain base        # live, read-only
node dist/tools/balances.js 0xAAA 0xBBB          # per-chain balances
node dist/tools/probe.js --chain base --contract 0xNFT
node dist/tools/find-drops.js --chain base
```

The `set -a; . /etc/copymint/env` line matters: systemd passes those variables
to the service, but a shell you SSH into has none of them, so a tool run by hand
would fall back to public endpoints and report the wrong limits.

`shakedown` is worth running from the VPS specifically — it reports latency and
the provider's real batch and rate limits from where the bot will actually run,
which is not the same as from your desk.
