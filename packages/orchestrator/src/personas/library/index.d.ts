/**
 * Baseline persona library — 11 built-in personas.
 *
 * Each file exports a `definition` of type PersonaDefinition.
 * This index re-exports all definitions and provides the canonical
 * BASELINE_PERSONAS array consumed by PersonaLoader.
 */
import type { PersonaDefinition } from '../types.js';
import { definition as pm } from './pm.js';
import { definition as architect } from './architect.js';
import { definition as srDev } from './sr-dev.js';
import { definition as jrDev } from './jr-dev.js';
import { definition as principalDev } from './principal-dev.js';
import { definition as qa } from './qa.js';
import { definition as security } from './security.js';
import { definition as scrumMaster } from './scrum-master.js';
import { definition as em } from './em.js';
import { definition as retroAnalyst } from './retro-analyst.js';
import { definition as verifier } from './verifier.js';
import { definition as reviewer } from './reviewer.js';
export { pm, architect, srDev, jrDev, principalDev, qa, security, scrumMaster, em, retroAnalyst, verifier, reviewer, };
export declare const BASELINE_PERSONAS: PersonaDefinition[];
//# sourceMappingURL=index.d.ts.map