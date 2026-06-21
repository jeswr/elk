// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Silent-restore tests — the SECURITY/UX invariant: restore is SILENT (refresh-grant fetch
// only), NEVER opens an interactive/popup login, and on SUCCESS hands back the DPoP-AUTHENTICATED
// fetch rebuilt from the restored session so it reaches pod storage (the roborev HIGH: the
// pod fetch must be the restored authed fetch, never the bare/unauthenticated global). On any
// restore failure the user is left logged-out; interactive login is deferred to explicit action.
//
// Plus the disconnect race (roborev LOW): the remembered-account pointer is cleared SYNCHRONOUSLY.
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

// ---- mock oauth4webapi so authedFetchFromRestoredSession's DPoP-bound request is observable
// WITHOUT a real crypto handle / network. protectedResourceRequest is the vetted auth-attach. ----
const protectedResourceRequestMock = vi.fn()
let dpopNonceErrors = new Set<unknown>()
vi.mock('oauth4webapi', () => ({
  protectedResourceRequest: (...args: unknown[]) => protectedResourceRequestMock(...args),
  isDPoPNonceError: (e: unknown) => dpopNonceErrors.has(e),
}))

// ---- mock the unstorage-solid driver so we can assert WHICH fetch createPodStorage hands it. ----
const solidDriverMock = vi.fn((opts: { base: string, fetch: typeof globalThis.fetch }) => ({ __opts: opts }))
vi.mock('@jeswr/unstorage-solid', () => ({ default: (opts: any) => solidDriverMock(opts) }))

// Import AFTER the mocks are registered.
const {
  silentRestore,
  authedFetchFromRestoredSession,
  disconnectSolid,
  ELK_REMEMBERED_ACCOUNT_KEY,
} = await import('./session')
const { createPodStorage } = await import('./storage')

// A window whose `open` we spy on — a popup MUST never be opened during restore.
const windowOpen = vi.fn(() => null)
// A spy-able localStorage so we can assert SYNCHRONOUS pointer removal on disconnect.
const localRemove = vi.fn()

function installDom(): void {
  ;(globalThis as any).window = { open: windowOpen }
  ;(globalThis as any).location = { href: 'https://elk.example/' }
  ;(globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: (...a: unknown[]) => localRemove(...a),
  }
}
function uninstallDom(): void {
  delete (globalThis as any).window
  delete (globalThis as any).location
  delete (globalThis as any).localStorage
}

/** A restored session sufficient for authedFetchFromRestoredSession (token + a sentinel handle). */
const SENTINEL_HANDLE = { __dpop: 'handle' } as any
function restoredSession(webId: string) {
  return { webId, accessToken: 'access-token-xyz', dpopHandle: SENTINEL_HANDLE }
}

describe('silentRestore — SILENT only, NEVER an interactive popup; success yields the authed fetch', () => {
  beforeEach(() => {
    installDom()
    restoreSessionMock.mockReset()
    rememberedRead.mockReset()
    rememberedClear.mockReset()
    hasPersistedMock.mockClear()
    windowOpen.mockClear()
    localRemove.mockClear()
    protectedResourceRequestMock.mockReset()
    solidDriverMock.mockClear()
    dpopNonceErrors = new Set()
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
    restoreSessionMock.mockResolvedValue(restoredSession(webId))
    // decideSilentRestore drives restoreIssuer (→ restoreSession) and returns restored.
    decisionImpl = async (inputs) => {
      // Prove the decision actually calls the silent seam we wired.
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return r ? { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' } : { outcome: 'login', reason: 'restore-failed' }
    }

    const result = await silentRestore()

    // The success shape is now { webId, fetch } — the WebID PLUS the restored authed fetch.
    expect(result).not.toBeNull()
    expect(result!.webId).toBe(webId)
    expect(typeof result!.fetch).toBe('function')
    expect(restoreSessionMock).toHaveBeenCalledTimes(1)
    // The refresh grant is a token-endpoint fetch — never a window/popup.
    expect(windowOpen).not.toHaveBeenCalled()
    // The static client_id (origin-aware) was passed to the public-client grant.
    const opts = restoreSessionMock.mock.calls[0][0] as { clientId?: string }
    expect(opts.clientId).toBe('https://elk.example/clientid.jsonld')
  })

  // THE HIGH: after a SUCCESSFUL silent restore, the fetch used for pod storage must be the
  // restored DPoP-AUTHENTICATED fetch — not the bare/unauthenticated global fetch. We take the
  // fetch silentRestore hands back (the value the plugin assigns to solidFetch.value BEFORE
  // mountPod), feed it through createPodStorage, and assert the unstorage-solid driver received
  // exactly that fetch AND that it carries the restored DPoP authorization.
  it('the fetch handed to pod storage IS the restored authed fetch (DPoP), not the bare global', async () => {
    const webId = 'https://alice.pod.example/profile/card#me'
    rememberedRead.mockReturnValue({ webId, issuer: 'https://issuer.example/' })
    restoreSessionMock.mockResolvedValue(restoredSession(webId))
    decisionImpl = async (inputs) => {
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' }
    }

    const result = await silentRestore()
    expect(result).not.toBeNull()
    const restoredFetch = result!.fetch

    // Mount pod storage with the restored fetch (what the plugin does after adopting it).
    createPodStorage('https://alice.pod.example/elk/kv/', restoredFetch)
    expect(solidDriverMock).toHaveBeenCalledTimes(1)
    // The driver got the EXACT restored authed fetch — same function reference, not the global.
    const passedFetch = solidDriverMock.mock.calls[0][0].fetch
    expect(passedFetch).toBe(restoredFetch)
    expect(passedFetch).not.toBe(globalThis.fetch)

    // And that fetch is genuinely DPoP-AUTHENTICATED: a pod request goes through
    // protectedResourceRequest with the restored access token + DPoP handle.
    protectedResourceRequestMock.mockResolvedValue(new Response('ok', { status: 200 }))
    await passedFetch('https://alice.pod.example/elk/kv/elk-settings')
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
    const [accessToken, method, url, , , prrOpts] = protectedResourceRequestMock.mock.calls[0]
    expect(accessToken).toBe('access-token-xyz')
    expect(method).toBe('GET')
    expect((url as URL).href).toBe('https://alice.pod.example/elk/kv/elk-settings')
    expect((prrOpts as { DPoP?: unknown }).DPoP).toBe(SENTINEL_HANDLE)
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

describe('authedFetchFromRestoredSession — DPoP-bound requests via oauth4webapi (no hand-rolled proof)', () => {
  beforeEach(() => {
    installDom()
    protectedResourceRequestMock.mockReset()
    dpopNonceErrors = new Set()
  })
  afterEach(() => {
    uninstallDom()
    vi.restoreAllMocks()
  })

  it('attaches the access token + DPoP handle and forwards method + body', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response(null, { status: 201 }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))

    const res = await f('https://a.example/elk/kv/elk-drafts', { method: 'PUT', body: '{"x":1}' })

    expect(res.status).toBe(201)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
    const [accessToken, method, url, , body, prrOpts] = protectedResourceRequestMock.mock.calls[0]
    expect(accessToken).toBe('access-token-xyz')
    expect(method).toBe('PUT')
    expect((url as URL).href).toBe('https://a.example/elk/kv/elk-drafts')
    // The body round-trips as bytes for protectedResourceRequest.
    expect(new TextDecoder().decode(body as ArrayBuffer)).toBe('{"x":1}')
    expect((prrOpts as { DPoP?: unknown }).DPoP).toBe(SENTINEL_HANDLE)
  })

  it('retries ONCE on a server DPoP-nonce challenge (RFC 9449 §8)', async () => {
    const nonceErr = new Error('use_dpop_nonce')
    dpopNonceErrors.add(nonceErr)
    protectedResourceRequestMock
      .mockRejectedValueOnce(nonceErr)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(200)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
  })

  it('propagates a non-nonce error without retry', async () => {
    const boom = new Error('network down')
    protectedResourceRequestMock.mockRejectedValue(boom)
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))

    await expect(f('https://a.example/elk/kv/x')).rejects.toThrow('network down')
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe('disconnectSolid — clears the remembered-account pointer SYNCHRONOUSLY (roborev LOW)', () => {
  beforeEach(() => {
    installDom()
    localRemove.mockClear()
  })
  afterEach(() => {
    uninstallDom()
    vi.restoreAllMocks()
  })

  it('removes the pointer key from localStorage synchronously, before returning', () => {
    disconnectSolid()
    // SYNCHRONOUS: the pointer is gone the instant disconnectSolid() returns — no microtask
    // gap a logout→immediate-reload race could slip through.
    expect(localRemove).toHaveBeenCalledWith(ELK_REMEMBERED_ACCOUNT_KEY)
    // The remembered-account class's async clear() must NOT be the mechanism here.
    expect(rememberedClear).not.toHaveBeenCalled()
  })
})
