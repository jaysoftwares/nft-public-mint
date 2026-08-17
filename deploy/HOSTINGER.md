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
| `/var/lib/copymint/users/<chatId>` | isolated config, wallet store, ledger and targets | `0700 copymint` |
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
COPYMINT_PASSPHRASE=any strong passphrase you choose now

RPC_URL_ETHEREUM=https://….ethereum-mainnet.quiknode.pro/…/
RPC_URL_BASE=https://….base-mainnet.quiknode.pro/…/
RPC_URL_ROBINHOOD=https://….robinhood-mainnet.quiknode.pro/…/

RPC_MAX_CALLS_PER_SEC=45
```

`Ctrl+O` to save, `Ctrl+X` to exit.

Set `COPYMINT_PASSPHRASE` now, before first start. It is the server master
secret; the bot derives a different encryption key for every Telegram chat.

> **The passphrase tradeoff.** Storing it here is what lets the service restart
> unattended at 4am. But a passphrase sitting beside the encrypted seeds means
> the encryption protects you against a stolen backup or snapshot — **not**
> against someone who already has root.
>
> Leave it blank if you'd rather unlock by hand. The service will start and exit
> immediately after every reboot until you do — and the Telegram setup flow in
> the Telegram setup flow cannot create stores without it.

---

## 6. Start it

```bash
systemctl start copymint
journalctl -u copymint -f
```

The log says `Multi-user bot running.` No whitelist or chat-id editing is
needed. Group chats are refused; every private chat is a separate user.

---

## 7. Each user creates their own wallet store in Telegram

This is the step that used to live on this terminal. It doesn't any more.

Each user opens a private chat with the bot and sends `/start`. Their isolated
setup screen asks them to set an NFT vault before creating wallets:

- **⚙️ Your settings** — set that user's NFT vault and view their funding wallet.
- **❔ What is this?** — what the phrase controls and where it will appear.
- **🔐 Create wallet store** — warns first, then shows the phrase.

Tapping through generates the 12-word phrase and prints it **in the chat**. Write
it on paper, then tap **"Written down — delete this message"**. If nobody taps,
the message deletes itself after ten minutes.

That user's bot session then comes up fully — no service restart needed — and
offers **➕ Generate 500 wallets**. Other users' sessions keep running.

Users can also choose **Restore existing seed** during setup. After setup,
**Wallets → Import wallet** accepts a private key or selected accounts from
another BIP-39 seed phrase. Imported wallets start manual-only. When adding a
copy target, the bot also asks whether to copy free mints, paid mints, or both.

> **The phrase goes through Telegram.** Cloud chats are not end-to-end
> encrypted, so it passes through Telegram's servers on the way to whoever is
> reading. Deleting the message is cleanup, not a guarantee about what was
> retained. The tradeoff buys something real — the phrase is seen by the person
> who owns the wallets, not by whoever holds the server's SSH session — but it
> is a tradeoff, not a free win.
>
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

> **The phrase does not back up imported keys.** Those live in `imported.enc`
> and need their own backup.

---

## 8. Measure from the server

Latency and provider limits from Hostinger's network are not the numbers you
measured from your desk.

```bash
# load the RPC URLs into this shell — systemd has them, your SSH session doesn't
set -a; . /etc/copymint/env; set +a
cd /opt/copymint

node dist/tools/verify.js                    # 165 offline checks
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

User stores live in `/var/lib/copymint/users/<chatId>`; none of that touches them.

**If it won't start** — `journalctl -u copymint -n 50` almost always names the
missing secret or configuration error. The unit
retries ten times in five minutes then stops, so a genuine config error surfaces
as a stopped service rather than an endless crash loop.

**Firewall** — nothing to open. Telegram long polling means outbound connections
only; SSH is the sole port that needs to be reachable.
