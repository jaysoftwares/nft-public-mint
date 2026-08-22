// The "why isn't it buying anything?" screen.
//
// Rendering rules, all of them reactions to the screen this replaces:
//
//   The answer goes first. Not a status table the reader has to interpret —
//   the sentence that says what is wrong, at the top, before anything else.
//
//   One fix per finding, phrased as an instruction. "No eligible wallets" is
//   not a fix. "Send them some ETH" is.
//
//   Buttons do the fix. A screen that explains a setting and then leaves you to
//   find it is half a screen, and the setting that broke this bot was four taps
//   deep in a submenu.
//
//   No internal words. Nothing here says selector, calldata, replay, nonce,
//   eligible, policy or verdict. If a concept cannot be said plainly it is the
//   concept that needs changing, not the reader.

import { InlineKeyboard } from "grammy";
import { Finding, Severity } from "../core/diagnosis";
import { SignalRecord } from "../core/copy-journal";
import { esc, short } from "./ui";

const MARK: Record<Severity, string> = {
  blocking: "🔴",
  limiting: "🟡",
  ok: "🟢",
};

function headline(state: Severity, findings: Finding[]): string {
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  if (state === "blocking") {
    return blocking === 1
      ? `🔴 <b>One thing is stopping it from buying</b>`
      : `🔴 <b>${blocking} things are stopping it from buying</b>`;
  }
  if (state === "limiting") {
    return `🟡 <b>It can buy, but some mints are being skipped</b>`;
  }
  return `🟢 <b>Everything is set up correctly</b>`;
}

export function renderHealth(findings: Finding[], state: Severity): string {
  const lines: string[] = [headline(state, findings), ``];

  for (const finding of findings) {
    lines.push(`${MARK[finding.severity]} <b>${esc(finding.title)}</b>`);
    lines.push(esc(finding.detail));
    if (finding.fix) lines.push(`<i>→ ${esc(finding.fix)}</i>`);
    lines.push(``);
  }

  lines.push(`<i>This screen reads your live settings — it is not a saved report.</i>`);
  return lines.join("\n");
}

/**
 * One button per fix that has one, plus the way back.
 *
 * Deduplicated by callback, because two findings often share a remedy and two
 * identical buttons look like a bug.
 */
export function healthMenu(findings: Finding[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!finding.action || seen.has(finding.action.callback)) continue;
    seen.add(finding.action.callback);
    keyboard.text(finding.action.label, finding.action.callback).row();
  }

  return keyboard.text("📜 Recent mints spotted", "a:signals").row().text("‹ Back", "m:copy");
}

function ago(then: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The history the rotating live card could never keep.
 *
 * Each entry is a mint that was spotted and what came of it — including, and
 * this is the whole point, the ones that came to nothing and why.
 */
export function renderSignals(signals: SignalRecord[]): string {
  if (signals.length === 0) {
    return [
      `📜 <b>Mints spotted</b>`,
      ``,
      `Nothing yet.`,
      ``,
      `<i>Every time a wallet you watch mints something, it is recorded here ` +
        `along with whether it was copied — and if not, why not.</i>`,
    ].join("\n");
  }

  const lines: string[] = [`📜 <b>Mints spotted</b>  <i>newest first</i>`, ``];

  for (const signal of signals) {
    const mark = signal.outcome === "fired" ? "✅" : signal.outcome === "failed" ? "⚠️" : "○";
    lines.push(
      `${mark} <b>${esc(short(signal.target))}</b> minted ` +
        `<code>${esc(short(signal.contract))}</code>  <i>${esc(signal.chainName)} · ${ago(signal.ts)}</i>`
    );
    lines.push(esc(signal.what));
    if (signal.fix && signal.outcome !== "fired") lines.push(`<i>→ ${esc(signal.fix)}</i>`);
    lines.push(``);
  }

  return lines.join("\n");
}

export function signalsMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("↻ Refresh", "a:signals")
    .text("🩺 Why?", "a:why")
    .row()
    .text("‹ Back", "m:copy");
}
