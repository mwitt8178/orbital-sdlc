/**
 * budget.js — Anthropic spend cap with hard kill-switch.
 *
 * Per the verification authorization: $25 USD hard cap.
 * Caller increments per-stream cost; over-budget triggers kill().
 */

const DEFAULT_CAP_CENTS = Number(process.env.ANTHROPIC_MAX_USD_CENTS ?? 2500)

export class BudgetTracker {
  constructor({ capCents = DEFAULT_CAP_CENTS } = {}) {
    this.capCents = capCents
    this.totalCents = 0
    this.killed = false
  }

  /** Add cost from one streaming chunk. Returns true if budget still OK. */
  add(cents) {
    if (this.killed) return false
    this.totalCents += cents
    if (this.totalCents >= this.capCents) {
      this.killed = true
      return false
    }
    return true
  }

  remaining() {
    return Math.max(0, this.capCents - this.totalCents)
  }

  isExceeded() {
    return this.killed
  }
}
