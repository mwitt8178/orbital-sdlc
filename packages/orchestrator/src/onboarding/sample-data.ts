/**
 * onboarding/sample-data.ts — sample sandbox project bootstrap.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Wraps the existing acme sample-loader and adds the sample-mode flag check
 * required by Flow D. This module is the entry point the Welcome page's
 * SampleDataFlow calls; it is intentionally thin so the heavy lifting stays
 * in sample-loader.ts.
 *
 * Sample mode = no real LLM calls. The MockDriver from drivers/mock.ts is
 * the only LLM driver loaded; its output is deterministic and free.
 */

import type { Actor } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { SampleLoader } from './sample-loader.js'
import { isSampleModeEnabled } from '../drivers/mock.js'

const SAMPLE_PROJECT_NAME = 'Acme Widgets — sample'

export interface SampleSandboxResult {
  loaded: boolean
  alreadyLoaded: boolean
  projectName: string
  conversionCta: string
  /** Number of sample sprints/channels/posts loaded. */
  sprintCount: number
  channelCount: number
  /** Persistent banner copy for the UI. */
  bannerText: string
}

export interface SampleSandbox {
  bootstrap(): Promise<SampleSandboxResult>
  isActive(): boolean
}

export class DefaultSampleSandbox implements SampleSandbox {
  constructor(
    private readonly _db: DB,
    private readonly _eventStore: EventStore,
    private readonly sampleLoader: SampleLoader,
  ) {}

  async bootstrap(): Promise<SampleSandboxResult> {
    const result = await this.sampleLoader.load()
    return {
      loaded: result.loaded,
      alreadyLoaded: result.alreadyLoaded,
      projectName: SAMPLE_PROJECT_NAME,
      sprintCount: result.sprintIds.length,
      channelCount: result.channelIds.length,
      bannerText: "You're in sample mode. Switch to a real project anytime.",
      conversionCta: 'Ready to set up your real project?',
    }
  }

  isActive(): boolean {
    return isSampleModeEnabled()
  }
}

export function createSampleSandbox(
  db: DB,
  eventStore: EventStore,
  sampleLoader: SampleLoader,
): SampleSandbox {
  return new DefaultSampleSandbox(db, eventStore, sampleLoader)
}

// Suppress unused-import warning on Actor — re-exported for callers building
// system events around the sandbox lifecycle.
export type { Actor }
