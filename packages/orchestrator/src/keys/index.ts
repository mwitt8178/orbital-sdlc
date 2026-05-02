/**
 * keys/index.ts — public surface for the federation auth keys module.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 */

export {
  signEnvelope,
  verifyEnvelope,
  sha256Hex,
  freshNonce,
  bytesToBase64Url,
  base64UrlToBytes,
  NonceLru,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
  type EnvelopeBody,
  type VerifyResult,
  type AuthErrorCode,
  type VerifyOptions,
} from './envelope.js'

export {
  loadInstallKey,
  generateAndPersistInstallKey,
  getOrCreateInstallKey,
  defaultInstallKeyPath,
  _purgeInstallKey,
  type InstallKey,
} from './install-key.js'
