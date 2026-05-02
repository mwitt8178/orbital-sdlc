/**
 * onboarding-types.ts — UI-side mirror of the onboarding mode literal.
 *
 * The orchestrator-side `OnboardingMode` is exported via the tRPC router
 * type bundle; the literal union is duplicated here to keep this file
 * import-light (no runtime import on the frontend bundle path).
 */

export type OnboardingMode = 'demo' | 'live' | 'readonly'
