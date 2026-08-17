import { randomBytes, timingSafeEqual } from "node:crypto";

export type ClaimResult =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "valid"; issuedBy: number };

interface PendingClaim {
  token: string;
  issuedBy: number;
  expiresAt: number;
}

/** One in-memory, single-use ownership handoff link. A restart invalidates it. */
export class OwnershipClaims {
  private pending?: PendingClaim;

  constructor(private readonly ttlMs = 10 * 60_000) {}

  issue(issuedBy: number, now = Date.now()): { token: string; expiresAt: number } {
    const token = randomBytes(16).toString("hex");
    const expiresAt = now + this.ttlMs;
    this.pending = { token, issuedBy, expiresAt };
    return { token, expiresAt };
  }

  consumeStart(text: string, now = Date.now()): ClaimResult {
    const match = text.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+claim_([a-f0-9]{32})\s*$/i);
    if (!match) return { kind: "none" };

    const pending = this.pending;
    if (!pending) return { kind: "invalid" };
    if (now > pending.expiresAt) {
      this.pending = undefined;
      return { kind: "expired" };
    }

    const supplied = Buffer.from(match[1].toLowerCase(), "hex");
    const expected = Buffer.from(pending.token, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return { kind: "invalid" };
    }

    this.pending = undefined;
    return { kind: "valid", issuedBy: pending.issuedBy };
  }
}
