// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Silent-restore tests (roborev Medium #3) — the SECURITY/UX invariant: restore is SILENT
// (refresh-grant fetch only) and NEVER opens an interactive/popup login. On any restore
// failure the user is left logged-out; interactive login is deferred to explicit action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---- mock @jeswr/solid-session-restore so we can drive each decision branch + assert the
// restore path uses ONLY the refresh-grant seam (no popup). ----
const restoreSessionMock = vi.fn()
const hasPersistedMock = vi.fn<() => Promise<'present' | 'absent' | 'unknown'>>(async () => 'present')
const rememberedRead = vi.fn()
const rememberedClear = vi.fn()
const rememberedWrite = vi.fn()
let decisionImpl: (inputs: any) => Promise<any> = async () => ({ outcome: 'login', reason: 'no-account' })

vi.mock('@jeswr/solid-session-restore', () => {
  return {
    indexedDbAvailable: () => true,
    IndexedDbSessionStore: class { constructor(_: unknown) {} },
    RememberedAccount: class {
      constructor(_: string) {}
      read() { return rememberedRead() }
      clear() { return rememberedClear() }
      write(...a: unknown[]) { return rememberedWrite(...a) }
    },
    hasPersisted: hasPersistedMock,
    // decideSilentRestore CALLS restoreIssuer (which wraps restoreSession) — the SILENT seam.
    decideSilentRestore: (inputs: any) => decisionImpl(inputs),
    shouldDropRememberedPointer: (reason: string) => reason !== 'restore-failed',
    restoreSession: (...args: unknown[]) => restoreSessionMock(...args),
  }
})

// Import AFTER the mock is registered.
const { silentRestore, ELK_REMEMBERED_ACCOUNT_KEY } = await import('./session')

// A window whose `open` we spy on — a popup MUST never be opened during restore.
const windowOpen = vi.fn(() => null)

function installDom(): void {
  ;(globalThis as any).window = { open: windowOpen }
  ;(globalThis as any).location = { href: 'https://elk.example/' }
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
}
function uninstallDom(): void {
  delete (globalThis as any).window
  delete (globalThis as any).location
  delete (globalThis as any).localStorage
}

describe('silentRestore — SILENT only, NEVER an interactive popup (Medium #3)', () => {
  beforeEach(() => {
    installDom()
    restoreSessionMock.mockReset()
    rememberedRead.mockReset()
    rememberedClear.mockReset()
    hasPersistedMock.mockClear()
    windowOpen.mockClear()
    decisionImpl = async () => ({ outcome: 'login', reason: 'no-account' })
  })
  afterEach(() => {
    uninstallDom()
    vi.restoreAllMocks()
  })

  it('uses the app-scoped remembered-account key', () => {
    expect(ELK_REMEMBERED_ACCOUNT_KEY).toBe('elk-solid.remembered-account')
  })

  it('returns null and NEVER opens a popup when nothing is remembered', async () => {
    rememberedRead.mockReturnValue(null)
    const result = await silentRestore()
    expect(result).toBeNull()
    expect(windowOpen).not.toHaveBeenCalled()
    // Nothing remembered → the refresh-grant seam is never even reached.
    expect(restoreSessionMock).not.toHaveBeenCalled()
  })

  it('restores via the REFRESH-GRANT seam (restoreSession) — NO popup — on success', async () => {
    const webId = 'https://alice.pod.example/profile/card#me'
    rememberedRead.mockReturnValue({ webId, issuer: 'https://issuer.example/' })
    restoreSessionMock.mockResolvedValue({ webId })
    // decideSilentRestore drives restoreIssuer (→ restoreSession) and returns restored.
    decisionImpl = async (inputs) => {
      // Prove the decision actually calls the silent seam we wired.
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return r ? { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' } : { outcome: 'login', reason: 'restore-failed' }
    }

    const result = await silentRestore()

    expect(result).toBe(webId)
    expect(restoreSessionMock).toHaveBeenCalledTimes(1)
    // The refresh grant is a token-endpoint fetch — never a window/popup.
    expect(windowOpen).not.toHaveBeenCalled()
    // The static client_id (origin-aware) was passed to the public-client grant.
    const opts = restoreSessionMock.mock.calls[0][0] as { clientId?: string }
    expect(opts.clientId).toBe('https://elk.example/clientid.jsonld')
  })

  it('fails closed on a dead/failed restore: returns null, opens NO popup', async () => {
    rememberedRead.mockReturnValue({ webId: 'https://a.example/#me', issuer: 'https://issuer.example/' })
    restoreSessionMock.mockResolvedValue(undefined) // dead token
    decisionImpl = async (inputs) => {
      await inputs.restoreIssuer('https://issuer.example/')
      return { outcome: 'login', reason: 'restore-failed' }
    }

    const result = await silentRestore()

    expect(result).toBeNull()
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('drops a KNOWN-BAD pointer (webid-mismatch) and never popups', async () => {
    rememberedRead.mockReturnValue({ webId: 'https://a.example/#me', issuer: 'https://issuer.example/' })
    hasPersistedMock.mockResolvedValue('absent')
    decisionImpl = async () => ({ outcome: 'login', reason: 'webid-mismatch' })

    const result = await silentRestore()

    expect(result).toBeNull()
    expect(rememberedClear).toHaveBeenCalledTimes(1)
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('returns null (no popup) when the package throws — fail-closed', async () => {
    rememberedRead.mockReturnValue({ webId: 'https://a.example/#me', issuer: 'https://issuer.example/' })
    decisionImpl = async () => {
      throw new Error('store blew up')
    }

    const result = await silentRestore()
    expect(result).toBeNull()
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
