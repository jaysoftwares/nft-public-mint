// Every mint, drawn.
//
// The text report answers "what happened" well enough, and it looks like a log
// line. A drop is the moment the operator most wants to look at, and the one
// screen they are most likely to send to somebody else — so it gets a picture,
// on the same machinery the dashboard already uses: hand-written SVG, rasterised
// with sharp, sent as a photo with the links in the keyboard beneath it.
//
// The same card serves copy-mint, public, GTD, FCFS and scheduled runs. Only
// the tool name and a couple of rows differ between them, and that is the point
// — five screens that look like five different products is how an operator
// stops being able to tell at a glance which machinery just fired.
//
// Three constraints, inherited from dashboard-image.ts and rediscovered here:
//
//   Fonts are not guaranteed. The VPS ships with none, the deploy installs
//   DejaVu, and every family below falls back through sans-serif.
//
//   It must never be the only path. Rendering is a native dependency away from
//   failing, so every caller falls back to its text report on a throw.
//
//   The picture cannot be tapped. Anything that leads somewhere — the
//   transaction, the collection, the history — belongs in the keyboard under
//   the photo, never in the image.

const W = 1280;
const H = 720;

/** Card geometry, kept as named numbers because the layout is read as a whole. */
const CARD = { x: 88, y: 143, w: 640, h: 470, r: 30 };
const PAD = 32;

const C = {
  bg: "#050308",
  smokeA: "#6D28D9",
  smokeB: "#4C1D95",
  smokeC: "#2E1065",
  card: "#141020",
  cardStroke: "#2C2342",
  label: "#A78BFA",
  value: "#FFFFFF",
  faint: "#7C6BA8",
  accent: "#8B5CF6",
  eye: "#A78BFA",
  headA: "#1A1526",
  headB: "#05030A",
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

const FAMILY = "DejaVu Sans, Helvetica, Arial, sans-serif";

interface TextOpts {
  size?: number;
  fill?: string;
  weight?: number;
  anchor?: "start" | "middle" | "end";
  spacing?: number;
  opacity?: number;
}

function text(content: string, px: number, py: number, o: TextOpts = {}): string {
  return (
    `<text x="${px}" y="${py}" font-family="${FAMILY}" font-size="${o.size ?? 20}" ` +
    `font-weight="${o.weight ?? 400}" fill="${o.fill ?? C.value}" ` +
    (o.spacing ? `letter-spacing="${o.spacing}" ` : "") +
    (o.opacity !== undefined ? `opacity="${o.opacity}" ` : "") +
    `text-anchor="${o.anchor ?? "start"}">${x(content)}</text>`
  );
}

/**
 * Cut a string to fit a width, in the absence of any way to measure one.
 *
 * SVG gives no text metrics without a layout engine, so this approximates from
 * the average advance of the family at a given size. Erring narrow is correct:
 * a name that stops early reads as deliberate, one that runs off the card reads
 * as broken.
 */
function fit(value: string, size: number, maxWidth: number, weight = 400): string {
  const advance = size * (weight >= 700 ? 0.62 : 0.55);
  const max = Math.max(4, Math.floor(maxWidth / advance));
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function eth(wei: bigint, places = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address;
}

/**
 * The smoke.
 *
 * Four blurred ellipses at low opacity. It is doing the same job as the render
 * behind the reference card — giving the flat black some depth so the panel
 * reads as sitting on top of something — without shipping a bitmap that would
 * have to be kept alongside the code and loaded at draw time.
 */
function backdrop(): string {
  return (
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` +
    `<g filter="url(#smoke)">` +
    `<ellipse cx="120" cy="180" rx="260" ry="200" fill="${C.smokeB}" opacity="0.42"/>` +
    `<ellipse cx="70" cy="560" rx="220" ry="190" fill="${C.smokeC}" opacity="0.5"/>` +
    `<ellipse cx="980" cy="330" rx="330" ry="290" fill="${C.smokeA}" opacity="0.22"/>` +
    `<ellipse cx="1210" cy="640" rx="240" ry="170" fill="${C.smokeB}" opacity="0.3"/>` +
    `</g>` +
    // A faint sweep across the middle, so the two halves are not separate images.
    `<rect width="${W}" height="${H}" fill="url(#sweep)"/>`
  );
}

/**
 * The mascot.
 *
 * Drawn rather than embedded, for the same reason as the smoke. The silhouette
 * is what carries it — a rounded-square head, two lit eyes, an antenna — so it
 * survives being built out of gradients instead of rendered in three
 * dimensions.
 */
function mascot(cx: number, cy: number, scale: number): string {
  const s = (n: number): number => Math.round(n * scale);
  return (
    `<g transform="translate(${cx} ${cy})">` +
    // Antenna
    `<rect x="${-s(4)}" y="${-s(214)}" width="${s(8)}" height="${s(52)}" rx="${s(4)}" fill="url(#metal)"/>` +
    `<circle cx="0" cy="${-s(228)}" r="${s(22)}" fill="url(#ball)"/>` +
    `<circle cx="${-s(7)}" cy="${-s(236)}" r="${s(6)}" fill="#FFFFFF" opacity="0.5"/>` +
    // Side pods
    `<ellipse cx="${-s(178)}" cy="${s(14)}" rx="${s(30)}" ry="${s(52)}" fill="url(#pod)"/>` +
    `<ellipse cx="${s(178)}" cy="${s(14)}" rx="${s(30)}" ry="${s(52)}" fill="url(#pod)"/>` +
    // Head
    `<rect x="${-s(168)}" y="${-s(168)}" width="${s(336)}" height="${s(330)}" rx="${s(96)}" fill="url(#head)"/>` +
    `<rect x="${-s(168)}" y="${-s(168)}" width="${s(336)}" height="${s(330)}" rx="${s(96)}" ` +
    `fill="none" stroke="${C.accent}" stroke-opacity="0.18" stroke-width="${s(3)}"/>` +
    // Gloss. Fading gradients, not flat fills — a constant-opacity ellipse over
    // a near-black head reads as a grey band painted on it rather than as light.
    `<ellipse cx="${-s(30)}" cy="${-s(104)}" rx="${s(116)}" ry="${s(54)}" fill="url(#gloss)"/>` +
    `<ellipse cx="${s(96)}" cy="${s(84)}" rx="${s(58)}" ry="${s(86)}" fill="url(#sheen)"/>` +
    // Rim light, tracking just *inside* the top edge. Pushed any higher it
    // stops reading as light on the head and starts reading as a wire above it.
    `<path d="M ${-s(104)} ${-s(150)} Q 0 ${-s(164)} ${s(104)} ${-s(150)}" fill="none" ` +
    `stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="${s(3)}" stroke-linecap="round"/>` +
    // Face
    `<g filter="url(#glow)">` +
    `<rect x="${-s(104)}" y="${-s(46)}" width="${s(74)}" height="${s(46)}" rx="${s(14)}" fill="${C.eye}"/>` +
    `<rect x="${s(30)}" y="${-s(46)}" width="${s(74)}" height="${s(46)}" rx="${s(14)}" fill="${C.eye}"/>` +
    `<rect x="${-s(42)}" y="${s(52)}" width="${s(84)}" height="${s(34)}" rx="${s(13)}" fill="${C.eye}"/>` +
    `</g>` +
    `</g>`
  );
}

/** One label-over-value pair from the grid. */
function field(label: string, value: string, px: number, py: number, width: number): string {
  return (
    text(label, px, py, { size: 21, fill: C.label, weight: 400 }) +
    text(fit(value, 25, width, 700), px, py + 36, { size: 25, fill: C.value, weight: 700 })
  );
}

export type MintToolLabel =
  | "Copy Mint"
  | "Public Mint"
  | "FCFS"
  | "GTD"
  | "Allowlist"
  | "Scheduled";

export interface MintCardBrand {
  /** Wordmark in the corner. */
  name: string;
  /** Footer links. Omitted entirely when unset, rather than shown empty. */
  x?: string;
  telegram?: string;
}

export interface MintCardInput {
  collection: string;
  contract: string;
  chain: string;
  wallets: number;
  /** Zero renders as FREE, which is the fact the operator is looking for. */
  priceWei: bigint;
  minted: number;
  tool: MintToolLabel | string;
  brand: MintCardBrand;
  /**
   * The wallet this run mirrored. Copy-mint only — it is the whole reason the
   * mint happened, and it has no meaning for a mint the operator started.
   */
  mirrored?: string;
  /** Overrides the FREE/price row when a run failed, e.g. "MISSED". */
  status?: string;
}

export function buildMintCardSvg(input: MintCardInput): string {
  const inner = CARD.x + PAD;
  const col2 = CARD.x + 302;
  const colW = 250;

  const thumb = { x: inner, y: CARD.y + 37, s: 82 };
  const nameX = thumb.x + thumb.s + 26;
  const nameW = CARD.x + CARD.w - PAD - nameX;

  const price = input.status ?? (input.priceWei > 0n ? `${eth(input.priceWei)} ETH` : "FREE");

  const footer: string[] = [];
  if (input.brand.x) {
    footer.push(
      `<circle cx="${inner + 10}" cy="${CARD.y + CARD.h + 34}" r="13" fill="${C.accent}" opacity="0.9"/>`,
      text("X", inner + 10, CARD.y + CARD.h + 39, {
        size: 15,
        weight: 700,
        anchor: "middle",
        fill: "#FFFFFF",
      }),
      text(input.brand.x, inner + 32, CARD.y + CARD.h + 40, { size: 17, fill: C.faint })
    );
  }
  if (input.brand.telegram) {
    const tx = CARD.x + 330;
    footer.push(
      `<circle cx="${tx + 10}" cy="${CARD.y + CARD.h + 34}" r="13" fill="${C.accent}" opacity="0.9"/>`,
      text("t", tx + 10, CARD.y + CARD.h + 39, {
        size: 16,
        weight: 700,
        anchor: "middle",
        fill: "#FFFFFF",
      }),
      text(input.brand.telegram, tx + 32, CARD.y + CARD.h + 40, { size: 17, fill: C.faint })
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<filter id="smoke" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="90"/></filter>` +
    `<filter id="glow" x="-80%" y="-80%" width="260%" height="260%">` +
    `<feGaussianBlur stdDeviation="9" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<linearGradient id="sweep" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#8B5CF6" stop-opacity="0.05"/>` +
    `<stop offset="55%" stop-color="#000000" stop-opacity="0"/>` +
    `<stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.06"/></linearGradient>` +
    `<linearGradient id="head" x1="0.15" y1="0" x2="0.85" y2="1">` +
    `<stop offset="0%" stop-color="${C.headA}"/>` +
    `<stop offset="52%" stop-color="${C.headB}"/>` +
    `<stop offset="100%" stop-color="#120C1E"/></linearGradient>` +
    `<linearGradient id="pod" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="#241B36"/><stop offset="100%" stop-color="#080510"/></linearGradient>` +
    `<linearGradient id="metal" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0%" stop-color="#3B3350"/><stop offset="100%" stop-color="#15101F"/></linearGradient>` +
    `<radialGradient id="gloss" cx="0.5" cy="0.4" r="0.6">` +
    `<stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.13"/>` +
    `<stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="sheen" cx="0.5" cy="0.5" r="0.6">` +
    `<stop offset="0%" stop-color="${C.accent}" stop-opacity="0.16"/>` +
    `<stop offset="100%" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="ball" cx="0.35" cy="0.3" r="0.75">` +
    `<stop offset="0%" stop-color="#4C3E6B"/><stop offset="100%" stop-color="#0C0814"/></radialGradient>` +
    `<linearGradient id="cardFill" x1="0" y1="0" x2="0.6" y2="1">` +
    `<stop offset="0%" stop-color="#1A1428" stop-opacity="0.88"/>` +
    `<stop offset="100%" stop-color="#0B0813" stop-opacity="0.82"/></linearGradient>` +
    `</defs>` +
    backdrop() +
    mascot(985, 372, 0.98) +
    // Wordmark
    text(input.brand.name, 96, 112, { size: 34, weight: 700, spacing: -0.5 }) +
    `<circle cx="${96 + Math.round(input.brand.name.length * 34 * 0.62) + 18}" cy="102" r="11" ` +
    `fill="${C.accent}"/>` +
    // Panel
    `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="${CARD.r}" ` +
    `fill="url(#cardFill)" stroke="${C.cardStroke}" stroke-width="1.5"/>` +
    // Thumbnail placeholder — no collection art is fetched at draw time.
    `<rect x="${thumb.x}" y="${thumb.y}" width="${thumb.s}" height="${thumb.s}" rx="12" ` +
    `fill="#0E0A18" stroke="${C.accent}" stroke-opacity="0.45" stroke-width="1.5"/>` +
    text(input.collection.slice(0, 1).toUpperCase(), thumb.x + thumb.s / 2, thumb.y + thumb.s / 2 + 13, {
      size: 34,
      weight: 700,
      anchor: "middle",
      fill: C.accent,
      opacity: 0.75,
    }) +
    text(fit(input.collection.toUpperCase(), 33, nameW, 700), nameX, thumb.y + 36, {
      size: 33,
      weight: 700,
    }) +
    text(fit(input.contract, 16, nameW), nameX, thumb.y + 64, { size: 16, fill: C.faint }) +
    // Grid
    field("Chain", input.chain, inner, CARD.y + 190, colW) +
    field("Wallets", String(input.wallets), col2, CARD.y + 190, colW) +
    field("Price", price, inner, CARD.y + 278, colW) +
    field("Minted", String(input.minted), col2, CARD.y + 278, colW) +
    // Tool
    text("Mint Tool", inner, CARD.y + 366, { size: 21, fill: C.label }) +
    text(fit(input.tool, 44, CARD.w - PAD * 2, 700), inner, CARD.y + 414, {
      size: 44,
      weight: 700,
    }) +
    (input.mirrored
      ? text(`mirroring ${shortAddress(input.mirrored)}`, inner, CARD.y + 444, {
          size: 16,
          fill: C.faint,
        })
      : "") +
    footer.join("") +
    `</svg>`
  );
}

/**
 * Rasterise.
 *
 * sharp is a native module and imported lazily on purpose, so a machine without
 * it still runs every text path. Callers treat a throw as "send the text
 * instead", never as a failed mint.
 */
export async function renderMintCardPng(svg: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require("sharp") as (input: Buffer) => {
    png(options?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> };
  };
  return sharp(Buffer.from(svg)).png({ compressionLevel: 6 }).toBuffer();
}
