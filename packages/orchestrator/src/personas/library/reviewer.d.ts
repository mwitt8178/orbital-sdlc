/**
 * reviewer.ts — Senior Code Reviewer persona.
 *
 * Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
 * [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
 *
 * Capability profile (per architecture.md):
 *   filesRead:     ['**']              — reads worktree + diff
 *   filesWrite:    []                  — NEVER writes to worktree
 *   boardMutate:   []                  — never touches board
 *   channelPost:   ['#review-*']       — posts only on review channels
 *   spawnSubagent: false               — terminal, no sub-spawning
 *   gitCommit:     null                — never commits
 *
 * Cross-family SoD: when author was Opus-family, the routing engine routes
 * this persona to Sonnet instead. The persona itself does not encode this
 * rule — it lives in engine.ts routeModel() so it can be audited centrally.
 */
import type { PersonaDefinition } from '../types.js';
export declare const definition: PersonaDefinition;
//# sourceMappingURL=reviewer.d.ts.map