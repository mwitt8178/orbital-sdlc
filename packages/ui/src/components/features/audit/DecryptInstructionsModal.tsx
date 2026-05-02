/**
 * DecryptInstructionsModal — copy-paste guide for decrypting an audit-export
 * tarball.
 *
 * The audit export pipeline produces an encrypted file at
 * <orbital_home>/exports/audit/<id>.tar.gz.enc. This modal surfaces the two
 * canonical commands a user can run to restore the package: the bundled npm
 * script (preferred) and a raw openssl invocation (escape hatch).
 */

import { useState } from 'react'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { useToast } from '../../../services/use-toast.js'

interface Props {
  open: boolean
  onClose: () => void
  /** Optional file path of the export, surfaced in the snippets when known. */
  filePath?: string
}

const DEFAULT_PATH = '<path-to-export.tar.gz.enc>'

export function DecryptInstructionsModal({ open, onClose, filePath }: Props) {
  const toast = useToast()
  const [copyTarget, setCopyTarget] = useState<string | null>(null)
  const target = filePath ?? DEFAULT_PATH

  const npmCmd = `npm run restore -- --from "${target}" --passphrase "<passphrase>"`
  const opensslCmd = [
    `# Decrypt to a tarball:`,
    `openssl enc -d -aes-256-gcm -pbkdf2 -iter 200000 \\`,
    `  -in "${target}" -out audit-export.tar.gz \\`,
    `  -pass pass:"<passphrase>"`,
    ``,
    `# Then extract:`,
    `tar -xzf audit-export.tar.gz`,
  ].join('\n')

  const copy = async (text: string, label: string) => {
    const nav = typeof window !== 'undefined' ? window.navigator : null
    if (!nav?.clipboard) {
      toast.warn('Clipboard not available')
      return
    }
    try {
      await nav.clipboard.writeText(text)
      setCopyTarget(label)
      toast.success(`Copied ${label} command`, { durationMs: 3000 })
      window.setTimeout(() => setCopyTarget(null), 2000)
    } catch (err) {
      toast.error('Could not copy', { description: (err as Error).message })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Decrypt an audit export" width="max-w-2xl">
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          The audit export tarball is encrypted with AES-256-GCM (PBKDF2, 200k iterations) using
          the passphrase you provided when requesting the export. Decrypt it with one of the
          two commands below before extracting.
        </p>

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Recommended · npm script
            </h3>
            <Button size="sm" variant="secondary" onClick={() => copy(npmCmd, 'npm')}>
              {copyTarget === 'npm' ? 'Copied' : 'Copy'}
            </Button>
          </header>
          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">
            <code>{npmCmd}</code>
          </pre>
          <p className="mt-1 text-xs text-slate-500">
            Replace <code className="font-mono">&lt;passphrase&gt;</code> with the passphrase
            you supplied when requesting the export. You can also set{' '}
            <code className="font-mono">ORBITAL_BACKUP_PASSPHRASE</code> in your environment to
            avoid putting it on the command line.
          </p>
        </section>

        <section>
          <header className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Raw openssl
            </h3>
            <Button size="sm" variant="secondary" onClick={() => copy(opensslCmd, 'openssl')}>
              {copyTarget === 'openssl' ? 'Copied' : 'Copy'}
            </Button>
          </header>
          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-800">
            <code>{opensslCmd}</code>
          </pre>
        </section>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-semibold">Keep the passphrase out of shell history</p>
          <p className="mt-0.5">
            Prefer environment variables (<code className="font-mono">ORBITAL_BACKUP_PASSPHRASE</code>)
            or a password manager. Anyone with the file <em>and</em> the passphrase can read the
            export.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}
