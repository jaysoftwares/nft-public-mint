// The dashboard as an actual picture.
//
// Telegram gives a bot two surfaces: a text message and an image. The text
// message has no type sizes, no colour, no columns and no alignment that
// survives a phone rotating — so every "designed" text card ends up as the same
// wall of monospace rows, which is exactly what the operator objected to. The
// numbers were right and the screen was unreadable.
//
// So the card is drawn instead. Hand-written SVG, rasterised with sharp, sent
// as a photo. That buys real hierarchy: one headline you read from across the
// room, a colour that means something before a word is read, and bars whose
// length is the fact rather than a decoration next to it.
//
// Three constraints shaped it:
//
//   Fonts are not guaranteed. The VPS had none at all, so the deploy installs
//   DejaVu and every family here falls back through sans-serif. Text that does
//   not render is worse than text that renders plainly.
//
//   It must never be the only path. Rendering is a native dependency away from
//   failing, and a dashboard that errors is worse than an ugly one — the caller
//   falls back to the text card on any throw.
//
//   The picture cannot be tapped. Numbers that lead somewhere stay in the
//   keyboard under the photo, not in the image.

import { DashboardStats } from "../core/dashboard";
import { Finding, Severity, ChainReadiness } from "../core/diagnosis";

const W = 1000;
const PAD = 44;
const CARD_R = 18;

const C = {
  bg: "#0B0E14",
  card: "#151A23",
  cardAlt: "#11161E",
  line: "#232A36",
  text: "#E6EDF3",
  muted: "#8B949E",
  dim: "#5A6472",
  green: "#3FB950",
  amber: "#D29922",
  red: "#F85149",
  blue: "#58A6FF",
};

const TONE: Record<Severity, { colour: string; label: string }> = {
  blocking: { colour: C.red, label: "NOT BUYING" },
  limiting: { colour: C.amber, label: "PARTLY READY" },
  ok: { colour: C.green, label: "READY" },
};

/** SVG is XML: five characters have to go, or one apostrophe voids the file. */
function x(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function eth(wei: bigint, places = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

interface TextOpts {
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  mono?: boolean;
}

function text(content: string, px: number, py: number, o: TextOpts = {}): string {
  const family = o.mono
    ? "DejaVu Sans Mono, Menlo, monospace"
    : "DejaVu Sans, Helvetica, Arial, sans-serif";
  return (
    `<text x="${px}" y="${py}" font-family="${family}" font-size="${o.size ?? 20}" ` +
    `font-weight="${o.weight ?? 400}" fill="${o.fill ?? C.text}" ` +
    `text-anchor="${o.anchor ?? "start"}">${x(content)}</text>`
  );
}

function card(px: number, py: number, w: number, h: number, fill = C.card): string {
  return (
    `<rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${CARD_R}" ` +
    `fill="${fill}" stroke="${C.line}" stroke-width="1"/>`
  );
}

/**
 * A proportion, drawn.
 *
 * The bar is the number here, not an ornament beside it — "12 of 500" is
 * arithmetic the reader has to do, and a bar two percent full is a fact they
 * already have by the time they have finished looking at it.
 */
function bar(px: number, py: number, w: number, done: number, total: number, colour: string): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(w * ratio);
  return (
    `<rect x="${px}" y="${py}" width="${w}" height="10" rx="5" fill="${C.line}"/>` +
    (filled > 2
      ? `<rect x="${px}" y="${py}" width="${filled}" height="10" rx="5" fill="${colour}"/>`
      : "")
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export interface DashboardImageInput {
  stats: DashboardStats;
  findings: Finding[];
  state: Severity;
  chains: ChainReadiness[];
  /** Native symbol per chain key, for the per-network rows. */
  symbols: Record<string, string>;
}

/**
 * Build the whole card as one SVG string.
 *
 * Pure and synchronous so it can be asserted against in the offline suite —
 * the rasteriser is the only part that needs a machine with fonts on it.
 */
export function buildDashboardSvg(input: DashboardImageInput): string {
  const { stats, findings, state, chains } = input;
  const { funding, wallets, copied, copy, day } = stats;
  const tone = TONE[state];
  const inner = W - PAD * 2;

  const parts: string[] = [];
  let y = 0;

  // ── Header ──
  y = PAD + 12;
  parts.push(text("COPYMINT", PAD, y + 10, { size: 22, weight: 700, fill: C.muted }));

  const pillW = 210;
  const pillX = W - PAD - pillW;
  parts.push(
    `<rect x="${pillX}" y="${y - 16}" width="${pillW}" height="40" rx="20" ` +
      `fill="${tone.colour}" fill-opacity="0.14" stroke="${tone.colour}" stroke-width="1.5"/>`,
    `<circle cx="${pillX + 24}" cy="${y + 4}" r="6" fill="${tone.colour}"/>`,
    text(tone.label, pillX + 40, y + 11, { size: 17, weight: 700, fill: tone.colour })
  );

  // ── The verdict, as the headline ──
  y += 66;
  const blockers = findings.filter((f) => f.severity === "blocking");
  const headline =
    blockers.length > 0
      ? truncate(blockers[0].title, 46)
      : copy.enabled
        ? `Watching ${copy.targets} ${copy.targets === 1 ? "wallet" : "wallets"}`
        : "Copy-mint is off";
  parts.push(text(headline, PAD, y + 26, { size: 40, weight: 700 }));

  y += 48;
  const sub =
    blockers.length > 0
      ? truncate(blockers[0].fix ?? blockers[0].detail, 92)
      : `${funding.readyToFire} of your ${wallets.total} wallets can buy right now`;
  parts.push(text(sub, PAD, y + 20, { size: 20, fill: C.muted }));

  // ── Three headline figures ──
  y += 56;
  const statH = 108;
  const gap = 16;
  const statW = Math.floor((inner - gap * 2) / 3);
  const figures: { label: string; value: string; colour: string }[] = [
    {
      label: "WALLETS READY",
      value: funding.blind ? "—" : String(funding.readyToFire),
      colour: funding.readyToFire > 0 ? C.green : C.red,
    },
    { label: "MINTS COPIED", value: String(copied.nfts), colour: copied.nfts > 0 ? C.blue : C.dim },
    { label: "WALLETS FOLLOWED", value: String(copy.targets), colour: copy.targets > 0 ? C.text : C.dim },
  ];
  figures.forEach((figure, i) => {
    const fx = PAD + i * (statW + gap);
    parts.push(
      card(fx, y, statW, statH, C.cardAlt),
      text(figure.label, fx + 22, y + 32, { size: 14, weight: 700, fill: C.dim }),
      text(figure.value, fx + 22, y + 84, { size: 46, weight: 700, fill: figure.colour })
    );
  });

  // ── Per network ──
  y += statH + 28;
  const rowH = 56;
  const netH = 58 + chains.length * rowH;
  parts.push(
    card(PAD, y, inner, netH),
    text("READY TO BUY, BY NETWORK", PAD + 24, y + 34, { size: 14, weight: 700, fill: C.dim })
  );

  chains.forEach((chain, i) => {
    const ry = y + 58 + i * rowH;
    const colour = !chain.read ? C.dim : chain.ready > 0 ? C.green : C.red;
    const note = !chain.read
      ? "could not be reached"
      : chain.ready > 0
        ? `${chain.ready} ready to buy`
        : chain.funded > 0
          ? `${chain.funded} funded, none armed`
          : `no gas here — mints spotted, not bought`;

    parts.push(
      `<circle cx="${PAD + 32}" cy="${ry + 16}" r="6" fill="${colour}"/>`,
      text(truncate(chain.name, 22), PAD + 52, ry + 22, { size: 21, weight: 700 }),
      text(note, W - PAD - 24, ry + 22, { size: 17, fill: C.muted, anchor: "end" }),
      bar(PAD + 52, ry + 34, inner - 100, chain.ready, Math.max(1, chain.matched || wallets.total), colour)
    );
  });

  // ── Today's spending ──
  y += netH + 28;
  const spendH = 118;
  const spent = Number(day.autoSpentWei);
  const cap = Number(day.capWei);
  const pctUsed = cap > 0 ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
  const spendColour = pctUsed >= 100 ? C.red : pctUsed > 75 ? C.amber : C.green;

  parts.push(
    card(PAD, y, inner, spendH),
    text("SPENDING, LAST 24 HOURS", PAD + 24, y + 32, { size: 14, weight: 700, fill: C.dim }),
    text(`${eth(day.autoSpentWei)} of ${eth(day.capWei)} ETH`, PAD + 24, y + 72, {
      size: 30,
      weight: 700,
    }),
    text(`${pctUsed}%`, W - PAD - 24, y + 72, { size: 30, weight: 700, fill: spendColour, anchor: "end" }),
    bar(PAD + 24, y + 88, inner - 48, spent, Math.max(1, cap), spendColour)
  );

  // ── Footer ──
  y += spendH + 34;
  const when = new Date(stats.generatedAt).toISOString().slice(0, 16).replace("T", " ");
  parts.push(
    text(`${when} UTC`, PAD, y, { size: 15, fill: C.dim }),
    text(
      funding.blind ? "balances unread" : `${eth(funding.totalWei)} ETH across your wallets`,
      W - PAD,
      y,
      { size: 15, fill: C.dim, anchor: "end" }
    )
  );

  const H = y + PAD - 8;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` +
    parts.join("") +
    `</svg>`
  );
}

/**
 * Rasterise. Kept apart from the builder so the layout stays testable offline,
 * and imported lazily so a machine without sharp can still run the text card.
 */
export async function renderDashboardPng(svg: string): Promise<Buffer> {
  // Required at call time and untyped on purpose: sharp is a native module,
  // it is not needed to run the tests or the CLI, and a machine without it must
  // still start the bot rather than failing to import.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require("sharp") as (input: Buffer) => {
    png(options?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> };
  };
  return sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
}
