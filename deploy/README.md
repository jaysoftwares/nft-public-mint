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
| `/var/lib/copymint/users/<chatId>` | one user's config, wallet store, ledger and targets | `0700 copymint` |
| `/etc/copymint/env` | secrets read by systemd | `0640 root:copymint` |

## The three steps setup.sh leaves to you

**1. Secrets** — `nano /etc/copymint/env`. Bot token, OpenSea key, RPC URLs, and
`COPYMINT_PASSPHRASE`.

Set the passphrase before first start. It is the server master secret: the bot
derives a different encryption key for each Telegram chat, so one user's
encrypted files cannot be opened as another user's store.

That passphrase is the honest tradeoff of unattended restart. The seeds are
encrypted at rest, but a passphrase sitting beside it on the same disk means the
encryption protects against a stolen backup or a snapshot, not against someone
who already has root. If you would rather it never touch the disk, leave it
blank and unlock by hand after each restart — the service will exit immediately
on boot until you do.

**2. Start**

```bash
systemctl start copymint
journalctl -u copymint -f
```

**3. Each user starts privately in Telegram.**

Every private chat gets an isolated directory and setup flow. The user sends
`/start`, sets their NFT vault, then creates their wallet store. Their
12-word recovery phrase is shown only in their chat, deleted on confirmation,
and deleted after ten minutes regardless. Their session comes up without a
service restart; other users' sessions keep running.

Users may instead restore an existing 12/24-word BIP-39 seed during setup. Once
running, **Wallets → Import wallet** accepts a private key or the first 1/10
accounts from another seed. Secret messages are deleted immediately; imported
wallets remain manual-only until the user explicitly enables auto-fire.

Each watched target stores its own copy filter: free mints, paid mints, or both.
Here, free means the source transaction sends zero native ETH.

The phrase travels through Telegram, whose cloud chats are not end-to-end
encrypted. Users should enable Telegram two-step verification and write the
phrase on paper. It restores every derived wallet, but **not** imported keys,
which need a separate backup.

## Operating

```bash
systemctl status copymint
systemctl restart copymint
journalctl -u copymint -f          # follow
journalctl -u copymint -p err      # errors only
```

`Restart=always` brings it back after a crash; `StartLimitBurst=10` means a
genuine config error stops the unit instead of looping forever. If it will not
start, `journalctl -u copymint -n 50` almost always names the missing secret or
configuration error.

**`copy.enabled` is `false` by default, and `/copy on` does not survive a
restart.** Autonomous spending resumes after a reboot only because
`config.json` says it should.

## Updating

One command, from anywhere on the box:

```bash
curl -fsSL https://raw.githubusercontent.com/jaysoftwares/nft-public-mint/main/deploy/update.sh | sudo bash
```

`update.sh` pulls the latest `main`, rebuilds, restarts, and then **checks that
the running process is actually the new build** before reporting success. It is
safe to re-run, and it never overwrites a value already in `/etc/copymint/env` —
it only appends keys that are missing.

<details>
<summary>By hand, if you prefer</summary>

`/opt/copymint` is **not** a git checkout — `setup.sh` rsyncs into it from
wherever you cloned. So the update runs from the clone, not from the install:

```bash
cd /opt/copymint-src && git pull    # wherever you cloned it
bash deploy/setup.sh
systemctl restart copymint
```

`setup.sh` is idempotent: it re-syncs, reinstalls dependencies, rebuilds, and
reinstalls the unit. It does **not** start the service, and a rebuild alone
changes nothing until the process restarts — Node has the old code in memory.
Confirm the restart actually took:

```bash
systemctl show copymint -p ActiveEnterTimestamp --value   # must be AFTER
stat -c %y /opt/copymint/dist/bot/index.js                # this
```

</details>

### WebSocket endpoints for copy-mint

The watcher subscribes to mint logs over WebSocket and polls when it cannot.
Most public RPCs cannot serve one — `mainnet.base.org` answers the upgrade with
405, and both Robinhood endpoints answer 400 — so the watcher detects that,
says so, and switches to polling rather than reconnecting forever.

Polling works; it is one poll behind push. To get push delivery back, set a
per-chain endpoint in `/etc/copymint/env` (`update.sh` adds the first two for
you):

```
WS_URL_BASE=wss://base-rpc.publicnode.com
WS_URL_ETHEREUM=wss://ethereum-rpc.publicnode.com
# Robinhood publishes no public WebSocket — needs a provider key.
# WS_URL_ROBINHOOD=wss://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
```

User stores live under `/var/lib/copymint/users/` and are untouched by any of that.

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
