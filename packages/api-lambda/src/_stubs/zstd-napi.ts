/**
 * Lambda-runtime stub for `zstd-napi`.
 *
 * `zstd-napi` is a native binding used by the audit-export generator for
 * compressing audit bundles. The native binary is not available in the
 * Lambda nodejs22.x runtime, so we stub the module here. Any procedure
 * that actually invokes zstd compression throws a clear "not in api-lambda"
 * error so the failure is observable; the export bundle path is daemon-
 * shaped and is moved to the orchestrator-daemon in Phase 2.
 */

function notImplemented(): never {
  throw new Error(
    'zstd-napi is not available in api-lambda. Audit-export bundle generation runs ' +
      'on the orchestrator-daemon (Phase 2). This procedure should not be reachable ' +
      'from the browser path.',
  )
}

export const compress = notImplemented
export const decompress = notImplemented
export const Compressor = class {
  compress(): never {
    return notImplemented()
  }
  end(): never {
    return notImplemented()
  }
}
export const Decompressor = class {
  decompress(): never {
    return notImplemented()
  }
  end(): never {
    return notImplemented()
  }
}
export default {
  compress,
  decompress,
  Compressor,
  Decompressor,
}
