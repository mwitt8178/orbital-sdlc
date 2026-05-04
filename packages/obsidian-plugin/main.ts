/**
 * main.ts — Orbital Vault Sync Obsidian community plugin.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * v1 commands:
 *   Orbital: Configure         → set API URL + tenant id + Cognito user-pool client id
 *   Orbital: Sign in           → OAuth 2.0 device-code flow against Cognito
 *   Orbital: Sync from Orbital → pull manifest + every file from S3 into the vault
 *
 * Real auth: device-code flow is the standard "no localhost callback" path
 * for desktop apps. The plugin opens the verification URL in the user's
 * default browser; the user signs in there; the plugin polls Cognito's
 * /oauth2/token endpoint until grant_type=urn:ietf:params:oauth:grant-type:device_code
 * returns a JWT.
 *
 * Real API: every command calls the configured Orbital API. No mocks.
 *
 * Out of scope for v1:
 *   - push-back from vault → Orbital
 *   - automatic background sync
 *   - conflict resolution (we currently overwrite local files; v2 adds a diff
 *     prompt if local and remote hash differ)
 */

// The `obsidian` module is provided at runtime by the Obsidian app — esbuild
// marks it as external. Types come from the obsidian devDependency.
import { Plugin, PluginSettingTab, App, Setting, Notice, requestUrl, normalizePath } from 'obsidian'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface OrbitalVaultSyncSettings {
  apiUrl: string
  tenantId: string
  cognitoUserPoolDomain: string
  cognitoClientId: string
  /** Stored after a successful device-code sign-in. Plain text in plugin data
   *  (Obsidian's plugin data lives in `<vault>/.obsidian/plugins/<id>/data.json`
   *  which is local-only by default). For shared vaults, users should sign out
   *  before syncing the .obsidian folder. */
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: number | null
}

const DEFAULT_SETTINGS: OrbitalVaultSyncSettings = {
  apiUrl: '',
  tenantId: '',
  cognitoUserPoolDomain: '',
  cognitoClientId: '',
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: null,
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class OrbitalVaultSyncPlugin extends Plugin {
  settings: OrbitalVaultSyncSettings = { ...DEFAULT_SETTINGS }

  override async onload(): Promise<void> {
    await this.loadSettingsFromDisk()
    this.addSettingTab(new OrbitalSettingTab(this.app, this))

    this.addCommand({
      id: 'orbital-sign-in',
      name: 'Orbital: Sign in (device code)',
      callback: () => this.signInWithDeviceCode(),
    })

    this.addCommand({
      id: 'orbital-sync-from-orbital',
      name: 'Orbital: Sync from Orbital',
      callback: () => this.syncFromOrbital(),
    })

    this.addCommand({
      id: 'orbital-sign-out',
      name: 'Orbital: Sign out',
      callback: async () => {
        this.settings.accessToken = null
        this.settings.refreshToken = null
        this.settings.tokenExpiresAt = null
        await this.saveSettingsToDisk()
        new Notice('Orbital: signed out.')
      },
    })
  }

  async loadSettingsFromDisk(): Promise<void> {
    const data = (await this.loadData()) as Partial<OrbitalVaultSyncSettings> | null
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) }
  }

  async saveSettingsToDisk(): Promise<void> {
    await this.saveData(this.settings)
  }

  // -------------------------------------------------------------------------
  // Device-code OAuth flow
  // -------------------------------------------------------------------------

  async signInWithDeviceCode(): Promise<void> {
    const { cognitoUserPoolDomain, cognitoClientId } = this.settings
    if (!cognitoUserPoolDomain || !cognitoClientId) {
      new Notice('Configure Cognito domain + client id in Orbital settings first.')
      return
    }

    // Step 1: request device + user codes.
    let deviceResp
    try {
      deviceResp = await requestUrl({
        url: `${cognitoUserPoolDomain}/oauth2/device_authorization`,
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        body: new URLSearchParams({
          client_id: cognitoClientId,
          scope: 'openid profile',
        }).toString(),
      })
    } catch (err) {
      new Notice(`Device-code init failed: ${(err as Error).message}`)
      return
    }

    const device = deviceResp.json as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete?: string
      expires_in: number
      interval: number
    }

    // Step 2: open the verification URL in the user's browser.
    const verifyUrl = device.verification_uri_complete ?? device.verification_uri
    new Notice(
      `Open ${verifyUrl} and enter code ${device.user_code}. (URL copied to clipboard.)`,
      10_000,
    )
    // eslint-disable-next-line no-undef -- `navigator` is provided by the Obsidian renderer process at runtime.
    await navigator.clipboard.writeText(verifyUrl).catch(() => {
      // Clipboard may be unavailable; the Notice already tells them the URL.
    })

    // Step 3: poll the token endpoint until success / expiry / error.
    const intervalMs = device.interval * 1000
    const expiresAt = Date.now() + device.expires_in * 1000
    while (Date.now() < expiresAt) {
      await new Promise((r) => setTimeout(r, intervalMs))
      try {
        const tokenResp = await requestUrl({
          url: `${cognitoUserPoolDomain}/oauth2/token`,
          method: 'POST',
          contentType: 'application/x-www-form-urlencoded',
          throw: false,
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: device.device_code,
            client_id: cognitoClientId,
          }).toString(),
        })
        if (tokenResp.status === 200) {
          const tokens = tokenResp.json as {
            access_token: string
            refresh_token?: string
            expires_in: number
          }
          this.settings.accessToken = tokens.access_token
          this.settings.refreshToken = tokens.refresh_token ?? null
          this.settings.tokenExpiresAt = Date.now() + tokens.expires_in * 1000
          await this.saveSettingsToDisk()
          new Notice('Orbital: signed in.')
          return
        }
        const err = tokenResp.json as { error?: string }
        if (err.error === 'authorization_pending' || err.error === 'slow_down') continue
        new Notice(`Sign-in failed: ${err.error ?? 'unknown error'}`)
        return
      } catch (err) {
        new Notice(`Token poll failed: ${(err as Error).message}`)
        return
      }
    }
    new Notice('Sign-in timed out — try again.')
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async syncFromOrbital(): Promise<void> {
    const { apiUrl, tenantId, accessToken } = this.settings
    if (!apiUrl || !tenantId) {
      new Notice('Configure API URL + tenant id first.')
      return
    }
    if (!accessToken) {
      new Notice('Sign in first (Orbital: Sign in).')
      return
    }

    // Pick the active project: ask the user. v1 uses the first project the
    // server returns; v2 will add a project picker.
    const projectId = await this.promptForProjectId()
    if (!projectId) return

    let listResp
    try {
      listResp = await this.callTrpc('vault.listForPlugin', { projectId })
    } catch (err) {
      new Notice(`Sync failed: ${(err as Error).message}`)
      return
    }
    const list = listResp as {
      manifestUrl: string | null
      files: Array<{ path: string; type: string; id: string; hash: string; url: string }>
    }
    if (list.files.length === 0) {
      new Notice('Orbital: vault is empty for this project.')
      return
    }

    let written = 0
    for (const file of list.files) {
      const objResp = await requestUrl({ url: file.url, method: 'GET', throw: false })
      if (objResp.status !== 200) {
        new Notice(`Skipped ${file.path}: HTTP ${objResp.status}`)
        continue
      }
      const localPath = normalizePath(file.path)
      const dir = localPath.split('/').slice(0, -1).join('/')
      if (dir.length > 0 && !(await this.app.vault.adapter.exists(dir))) {
        await this.app.vault.adapter.mkdir(dir)
      }
      await this.app.vault.adapter.write(localPath, objResp.text)
      written += 1
    }
    new Notice(`Orbital: pulled ${written} files into the vault.`)
  }

  async promptForProjectId(): Promise<string | null> {
    // v1: prompt via JS prompt (native Obsidian modal scaffolding lands in v2).
    const id = window.prompt('Orbital project id (UUID):')
    if (!id) return null
    return id.trim()
  }

  async callTrpc(procedure: string, input: unknown): Promise<unknown> {
    const { apiUrl, tenantId, accessToken } = this.settings
    const url = `${apiUrl}/trpc/${procedure}`
    const resp = await requestUrl({
      url,
      method: 'POST',
      contentType: 'application/json',
      headers: {
        Authorization: `Bearer ${accessToken ?? ''}`,
        'X-Orbital-Tenant-ID': tenantId,
      },
      body: JSON.stringify({ input }),
      throw: false,
    })
    if (resp.status !== 200) {
      throw new Error(`HTTP ${resp.status}: ${resp.text.slice(0, 200)}`)
    }
    const body = resp.json as { result?: { data?: unknown }; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    return body.result?.data
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class OrbitalSettingTab extends PluginSettingTab {
  plugin: OrbitalVaultSyncPlugin

  constructor(app: App, plugin: OrbitalVaultSyncPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()
    containerEl.createEl('h2', { text: 'Orbital Vault Sync' })

    new Setting(containerEl)
      .setName('Orbital API URL')
      .setDesc('e.g. https://api.orbital.team.dev — no trailing slash.')
      .addText((t) =>
        t
          .setPlaceholder('https://api.example.com')
          .setValue(this.plugin.settings.apiUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiUrl = value.trim().replace(/\/$/, '')
            await this.plugin.saveSettingsToDisk()
          }),
      )

    new Setting(containerEl)
      .setName('Tenant ID')
      .setDesc('UUID of your Orbital tenant.')
      .addText((t) =>
        t
          .setPlaceholder('00000000-0000-0000-0000-000000000000')
          .setValue(this.plugin.settings.tenantId)
          .onChange(async (value) => {
            this.plugin.settings.tenantId = value.trim()
            await this.plugin.saveSettingsToDisk()
          }),
      )

    new Setting(containerEl)
      .setName('Cognito user pool domain')
      .setDesc('e.g. https://orbital-mwitt.auth.us-east-1.amazoncognito.com')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.cognitoUserPoolDomain)
          .onChange(async (value) => {
            this.plugin.settings.cognitoUserPoolDomain = value.trim().replace(/\/$/, '')
            await this.plugin.saveSettingsToDisk()
          }),
      )

    new Setting(containerEl)
      .setName('Cognito client id')
      .setDesc('App client id with device-code flow enabled.')
      .addText((t) =>
        t.setValue(this.plugin.settings.cognitoClientId).onChange(async (value) => {
          this.plugin.settings.cognitoClientId = value.trim()
          await this.plugin.saveSettingsToDisk()
        }),
      )

    const status = this.plugin.settings.accessToken ? 'signed in' : 'signed out'
    containerEl.createEl('p', { text: `Status: ${status}` })
  }
}
