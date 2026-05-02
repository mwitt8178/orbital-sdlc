/**
 * operator-color-server.ts — Server-side port of the deterministic color hash.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Same algorithm as packages/ui/src/lib/operator-color.ts — MUST stay in sync.
 * Returns the hue integer [60, 360) so the team.members tRPC response includes
 * a pre-computed color the UI can use directly.
 *
 * We duplicate the function (rather than sharing via a workspace lib) because
 * the UI lib cannot be imported in the orchestrator (it's a browser bundle
 * concern). A shared `@orbital/colors` package is the v2 solution.
 */

function fnv1a32(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash
}

/**
 * Deterministic HSL hue from an install_id string.
 * Same algorithm as operatorColor() in packages/ui/src/lib/operator-color.ts.
 * Returns hue in [60, 360).
 */
export function operatorHue(installId: string): number {
  const hash = fnv1a32(installId)
  return (hash % 300) + 60
}
