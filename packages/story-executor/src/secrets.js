/**
 * secrets.js — fetch ANTHROPIC_API_KEY from AWS Secrets Manager (with env fallback).
 *
 * Resolution order:
 *   1. process.env.ANTHROPIC_API_KEY (already injected by ECS via container `secrets:`).
 *   2. AWS Secrets Manager — secret name `ANTHROPIC_API_KEY_SECRET_ID`
 *      (default: `orbital-mwitt/anthropic-api-key`). Value can be either
 *      raw plaintext or JSON `{ "ANTHROPIC_API_KEY": "..." }`.
 *
 * Cached for the process lifetime.
 *
 * Real, end-to-end. Throws if neither source resolves.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

let _cached = null

const DEFAULT_SECRET_ID =
  process.env.ANTHROPIC_API_KEY_SECRET_ID ?? 'orbital-mwitt/anthropic-api-key'

/**
 * @param {object} [opts]
 * @param {SecretsManagerClient} [opts.client] — inject for testing
 * @param {string} [opts.secretId]
 * @returns {Promise<string>} the API key
 */
export async function getAnthropicApiKey(opts = {}) {
  if (_cached) return _cached
  const direct = process.env.ANTHROPIC_API_KEY
  if (direct && direct.length > 0) {
    _cached = direct
    return _cached
  }

  const secretId = opts.secretId ?? DEFAULT_SECRET_ID
  const client = opts.client ?? new SecretsManagerClient({})
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
  const raw = out.SecretString
  if (!raw) throw new Error(`secret ${secretId} returned no SecretString`)

  let value = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      value = parsed.ANTHROPIC_API_KEY ?? parsed.apiKey ?? parsed.api_key ?? raw
    }
  } catch {
    // raw plaintext — keep as-is
  }
  if (!value || typeof value !== 'string') {
    throw new Error(`secret ${secretId} did not yield a usable string value`)
  }
  _cached = value
  return _cached
}

export function _resetCache() {
  _cached = null
}
