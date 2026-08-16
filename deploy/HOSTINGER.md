# Deploying to a Hostinger VPS

About 30 minutes, most of it waiting for installs. Nothing here spends money.

Your Telegram bot token is already in your local `.env`, so BotFather is behind
you — you'll copy that token to the server in step 5.

---

## 1. Push your code to GitHub

The server pulls from your repo, and all the new work is still untracked
locally.

```powershell
# Windows PowerShell, in the project folder
cd C:\Users\PC\OneDrive\Desktop\copymint\nft-public-mint

git add src deploy package.json package-lock.json .env.example
git commit -m "Add bot, core, tools and deploy kit"
git push origin main
```

**Safe to push.** `.gitignore` already excludes `.env`, and the wallet store
lives in `~/.copymint` — outside the repo entirely. No secret leaves your
machine here.

---

## 2. Create the VPS

In hPanel, order a VPS and pick **Ubuntu 24.04** as a plain OS template — not
one of the application images, which pre-install a control panel that only gets
in the way.

The smallest plan is ample. This bot is network-bound, not CPU-bound.

When provisioning finishes, hPanel shows the **IP address** and lets you set the
**root password**. Keep both.

On region: choose one near you for SSH comfort, but don't guess at it for
minting — step 8 measures real latency from the box, and that's the number that
matters.

---

## 3. Connect

Windows has SSH built in.

```powershell
ssh root@YOUR_VPS_IP
```

Accept the fingerprint, enter the root password. Everything below runs on the
server.

---

## 4. Clone and run setup

```bash
apt update && apt install -y git curl rsync

git clone https://github.com/jaysoftwares/nft-public-mint.git /tmp/copymint
cd /tmp/copymint
bash deploy/setup.sh
```

Installs Node 22, creates an unprivileged `copymint` user, builds the
TypeScript, installs the systemd unit. Three or four minutes.

| Path | Holds | Mode |
|---|---|---|
| `/opt/copymint` | code and compiled `dist/` | `0755 root` |
| `/var/lib/copymint` | wallet store, config, ledger | `0700 copymint` |
| `/etc/copymint/env` | secrets, read by systemd | `0640 root:copymint` |

Node 22 specifically: the copy-mint watcher needs a global `WebSocket`, which
lands unflagged there. On an older runtime it silently falls back to polling —
still quick enough for block N+1, but with less margin.

---

## 5. Fill in the secrets

```bash
nano /etc/copymint/env
```

Copy the values across from your local `.env` — bot token, OpenSea key, and all
three QuickNode URLs.

```
TELEGRAM_BOT_TOKEN=your token
OPENSEA_API_KEY=your key
COPYMINT_PASSPHRASE=chosen in step 6

RPC_URL_ETHEREUM=https://….ethereum-mainnet.quiknode.pro/…/
RPC_URL_BASE=https://….base-mainnet.quiknode.pro/…/
RPC_URL_ROBINHOOD=https://….robinhood-mainnet.quiknode.pro/…/

RPC_MAX_CALLS_PER_SEC=45
```

`Ctrl+O` to save, `Ctrl+X` to exit. Come back for the passphrase line once
step 6 has set it.

> **The passphrase tradeoff.** Storing it here is what lets the service restart
> unattended at 4am. But a passphrase sitting beside the encrypted seed means
> the encryption protects you against a stolen backup or snapshot — **not**
> against someone who already has root.
>
> Leave it blank if you'd rather unlock by hand. The service will start and exit
> immediately after every reboot until you do.

---

## 6. Create the wallet store

Run as the `copymint` user so files end up owned by the account the service
runs as.

```bash
sudo -u copymint COPYMINT_HOME=/var/lib/copymint \
  node /opt/copymint/dist/tools/wallets.js init

sudo -u copymint COPYMINT_HOME=/var/lib/copymint \
  node /opt/copymint/dist/tools/wallets.js generate 500
```

`init` asks for a passphrase twice, prints a 12-word recovery phrase once, and
clears the screen when you press Enter.

> **One bot per seed — this one bites.**
>
> If you restore your desktop mnemonic here and both bots ever run at once, they
> will each track nonces independently for the same addresses and collide:
> transactions replacing each other, wallets stuck behind gaps.
>
> Pick one home. Either create a **fresh** store here and retire the desktop
> one, or use `wallets.js restore` to bring the desktop seed over and never run
> the desktop bot again. Your ten desktop wallets hold nothing, so a fresh store
> costs you nothing.

> **Write the phrase on paper.** It restores every derived wallet and is shown
> exactly once. It does **not** back up imported keys — those live in
> `imported.enc` and need their own backup.

---

## 7. Point the config at your addresses

```bash
nano /var/lib/copymint/config.json
```

```json
"vault":  "0x… where swept NFTs go",
"funder": "0x… the wallet that disperses gas",
"telegram": { "allowedChatIds": [ your id — next step ] }
```

Both addresses are deliberately unreachable from Telegram. A fully compromised
Telegram account can make the bot mint and sweep, but everything it moves still
lands at an address changeable only over SSH.

Leave `copy.enabled` as `false` until you've watched real signals for a while.
`/copy on` in chat is deliberately temporary and does not survive a restart.

---

## 8. Start it, and claim your chat id

```bash
systemctl start copymint
journalctl -u copymint -f
```

Open Telegram, find your bot, send `/start`. The log prints:

```
Rejected message from chat 123456789
```

That's the whitelist working. Put the number in `allowedChatIds`, restart, and
send `/start` again — this time you get the menu.

```bash
nano /var/lib/copymint/config.json
systemctl restart copymint
```

---

## 9. Measure from the server

Latency and provider limits from Hostinger's network are not the numbers you
measured from your desk.

```bash
# load the RPC URLs into this shell — systemd has them, your SSH session doesn't
set -a; . /etc/copymint/env; set +a
cd /opt/copymint

node dist/tools/verify.js                    # 121 offline checks
node dist/tools/shakedown.js --chain base    # live, read-only
```

**Use `node dist/…`, not `npm run …`.** The npm shortcuts go through `ts-node`,
a devDependency `setup.sh` deliberately doesn't install.

Looking for: chain id confirmed, a sequencer endpoint present, WebSocket headers
arriving, and a reconcile slice comfortably inside 30 seconds.

---

## Living with it

| Command | Does |
|---|---|
| `systemctl status copymint` | running? how long? last exit reason |
| `journalctl -u copymint -f` | follow the log live |
| `journalctl -u copymint -p err` | errors only |
| `systemctl restart copymint` | restart after a config change |

**Updating**

```bash
cd /opt/copymint && git pull
npm install --omit=dev && npx tsc
systemctl restart copymint
```

The wallet store lives in `/var/lib/copymint`; none of that touches it.

**If it won't start** — `journalctl -u copymint -n 50` almost always names the
reason outright: a missing secret, or `vault`/`funder` still unset. The unit
retries ten times in five minutes then stops, so a genuine config error surfaces
as a stopped service rather than an endless crash loop.

**Firewall** — nothing to open. Telegram long polling means outbound connections
only; SSH is the sole port that needs to be reachable.
