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
  connectSolid,
  disconnectSolid,
  resetSolidFetchToDefault,
  setDefaultSolidFetch,
  getDefaultSolidFetch,
  beginRestoreGeneration,
  bumpRestoreGeneration,
  isRestoreGenerationCurrent,
  solidFetch,
  solidWebId,
  solidPodBase,
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

  // ---- Medium #1: refresh-on-401 — an expired token re-mints silently + retries ONCE ----

  it('refreshes the token + retries on a RETURNED bare-401, succeeding with the NEW token', async () => {
    // First request 401s (expired token); refresh mints a fresh credential; the retry succeeds.
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-token-999', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
    // The RETRY went out with the FRESH token, not the original expired one.
    expect(protectedResourceRequestMock.mock.calls[0][0]).toBe('access-token-xyz')
    expect(protectedResourceRequestMock.mock.calls[1][0]).toBe('fresh-token-999')
  })

  it('refreshes the token + retries on a THROWN invalid_token 401 challenge (WWW-Authenticate)', async () => {
    // oauth4webapi throws a WWWAuthenticateChallengeError (carrying .status=401) for invalid_token.
    const challenge = Object.assign(new Error('invalid_token'), { status: 401 })
    protectedResourceRequestMock
      .mockRejectedValueOnce(challenge)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-token-999', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(200)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
    expect(protectedResourceRequestMock.mock.calls[1][0]).toBe('fresh-token-999')
  })

  it('after a refresh, SUBSEQUENT requests on the same fetch use the fresh token', async () => {
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })) // req1 expired
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // req1 retry (fresh)
      .mockResolvedValueOnce(new Response('ok', { status: 200 })) // req2 (fresh, no 401)
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-token-999', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    await f('https://a.example/elk/kv/a')
    await f('https://a.example/elk/kv/b')

    // refresh only ran once (req1); req2 went straight out on the now-captured fresh token.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(3)
    expect(protectedResourceRequestMock.mock.calls[2][0]).toBe('fresh-token-999')
  })

  it('does NOT loop when refresh FAILS: returns the original 401, refresh tried ONCE', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const refresh = vi.fn(async () => null) // dead refresh credential
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    // The caller sees the non-ok 401 (read degrades to absent / write sees non-ok) — no loop.
    expect(res.status).toBe(401)
    expect(refresh).toHaveBeenCalledTimes(1)
    // One initial request only — refresh returned null so there was no retry.
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
  })

  it('does NOT loop when the refreshed token STILL 401s: refresh + ONE retry, then stop', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-but-also-bad', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(401)
    expect(refresh).toHaveBeenCalledTimes(1)
    // Exactly two protectedResourceRequest calls: the original + ONE post-refresh retry.
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
  })

  // ---- roborev Medium: refreshAndRetry must only SUPPRESS a SECOND auth failure; an UNRELATED
  // retry error (network / 5xx / parse) must PROPAGATE as itself, not be masked as the 401. ----

  it('a NETWORK error on the post-refresh retry PROPAGATES as that error, not masked as the 401', async () => {
    // First request 401s (expired) → refresh mints a fresh token → the RETRY hits a network error.
    // That non-auth error must surface as itself (not swallowed into the original 401).
    const netErr = new Error('ECONNRESET on retry')
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })) // initial 401
      .mockRejectedValueOnce(netErr) // post-refresh retry: network failure (no .status)
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-token-999', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    await expect(f('https://a.example/elk/kv/x')).rejects.toThrow('ECONNRESET on retry')
    expect(refresh).toHaveBeenCalledTimes(1)
    // The original request + the (failing) post-refresh retry.
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
  })

  it('a 5xx-style non-auth THROW on the post-refresh retry PROPAGATES (not masked as the 401)', async () => {
    // A thrown error carrying a non-401 status (e.g. a 503) is NOT a token-expiry → must rethrow.
    const serverErr = Object.assign(new Error('Service Unavailable'), { status: 503 })
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockRejectedValueOnce(serverErr)
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-token-999', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    await expect(f('https://a.example/elk/kv/x')).rejects.toThrow('Service Unavailable')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
  })

  it('a SECOND 401 (THROWN invalid_token) on the post-refresh retry is suppressed → original 401 returned', async () => {
    // First request 401s → refresh → the RETRY throws an invalid_token challenge (.status=401):
    // a SECOND auth failure → suppress (return null) so the ORIGINAL 401 propagates, NO loop, NO throw.
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 })) // initial bare-401
      .mockRejectedValueOnce(Object.assign(new Error('invalid_token'), { status: 401 })) // retry: 2nd auth failure
    const refresh = vi.fn(async () => ({ accessToken: 'fresh-but-also-bad', dpopHandle: SENTINEL_HANDLE }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    // The original bare-401 is returned (degrade gracefully) — not thrown, not looped.
    expect(res.status).toBe(401)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT loop when refresh THROWS: returns the original 401, no retry', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const refresh = vi.fn(async () => {
      throw new Error('refresh blew up')
    })
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'), refresh)

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(401)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
  })

  it('without a refresh callback, a 401 is returned as-is (no refresh attempted)', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))

    const res = await f('https://a.example/elk/kv/x')

    expect(res.status).toBe(401)
    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
  })

  // ---- Low: single-Request body/header normalization (FormData boundary consistency) ----

  it('a FormData body round-trips with a Content-Type boundary that MATCHES the body bytes', async () => {
    protectedResourceRequestMock.mockResolvedValue(new Response(null, { status: 201 }))
    const f = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))

    const fd = new FormData()
    fd.append('field', 'value')
    await f('https://a.example/elk/kv/upload', { method: 'POST', body: fd })

    expect(protectedResourceRequestMock).toHaveBeenCalledTimes(1)
    const [, method, , headers, body] = protectedResourceRequestMock.mock.calls[0]
    expect(method).toBe('POST')
    // The Content-Type header carries a multipart boundary…
    const ct = (headers as Headers).get('content-type') ?? ''
    expect(ct).toMatch(/^multipart\/form-data; boundary=(.+)$/)
    const boundary = ct.replace(/^multipart\/form-data; boundary=/, '')
    // …and the SAME boundary appears in the serialized body bytes (no divergence from a second
    // Request re-serialization). The body must be derived from the SAME Request as the header.
    const decoded = new TextDecoder().decode(body as ArrayBuffer)
    expect(decoded).toContain(`--${boundary}`)
    expect(decoded).toContain('name="field"')
    expect(decoded).toContain('value')
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

// ---- Medium #2 (SECURITY): the restored per-session fetch must NOT survive logout / a new login,
// or one user's DPoP token could be reused for another user's pod requests. ----
describe('solidFetch reset — no cross-user DPoP-token reuse after logout / before a new login', () => {
  beforeEach(() => {
    installDom()
    restoreSessionMock.mockReset()
    rememberedRead.mockReset()
    rememberedClear.mockReset()
    hasPersistedMock.mockClear()
    windowOpen.mockClear()
    localRemove.mockClear()
    protectedResourceRequestMock.mockReset()
    dpopNonceErrors = new Set()
    decisionImpl = async () => ({ outcome: 'login', reason: 'no-account' })
  })
  afterEach(() => {
    uninstallDom()
    vi.restoreAllMocks()
  })

  it('after disconnect, solidFetch.value is the DEFAULT (patched global), NOT the restored fetch', () => {
    const patchedGlobal = (async () => new Response()) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    // Simulate a silent restore having adopted a restored per-session fetch.
    const restoredFetch = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))
    solidFetch.value = restoredFetch
    expect(solidFetch.value).toBe(restoredFetch)

    disconnectSolid()

    // The restored per-session fetch is dropped; the pod fetch is the default again.
    expect(solidFetch.value).toBe(patchedGlobal)
    expect(solidFetch.value).not.toBe(restoredFetch)
  })

  it('resetSolidFetchToDefault() drops the restored fetch (used before an interactive login)', () => {
    const patchedGlobal = (async () => new Response()) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    const restoredFetch = authedFetchFromRestoredSession(restoredSession('https://a.example/#me'))
    solidFetch.value = restoredFetch

    // The plugin's login() calls this BEFORE resolving the (possibly different) user's profile.
    resetSolidFetchToDefault()

    expect(solidFetch.value).toBe(patchedGlobal)
  })

  it('a login after a restore+logout does NOT carry the prior restored user\'s DPoP token', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)

    // 1) Silent restore for user A → adopt A's restored DPoP fetch (what the plugin does).
    const aliceWebId = 'https://alice.pod.example/profile/card#me'
    rememberedRead.mockReturnValue({ webId: aliceWebId, issuer: 'https://issuer.example/' })
    restoreSessionMock.mockResolvedValue({ ...restoredSession(aliceWebId), issuer: 'https://issuer.example/' })
    decisionImpl = async (inputs) => {
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' }
    }
    const restored = await silentRestore()
    expect(restored).not.toBeNull()
    solidFetch.value = restored!.fetch // plugin adopts A's restored authed fetch
    expect(solidFetch.value).not.toBe(patchedGlobal)

    // 2) User A logs out → restored fetch must be dropped.
    disconnectSolid()
    expect(solidFetch.value).toBe(patchedGlobal)

    // 3) A subsequent (interactive) login resets to the default first — so the pod fetch in use
    //    is the patched global, NEVER A's restored DPoP fetch. Prove a pod request now does NOT
    //    go through A's protectedResourceRequest (A's token-bearing path).
    resetSolidFetchToDefault()
    protectedResourceRequestMock.mockClear()
    await solidFetch.value('https://bob.pod.example/profile/card#me')
    expect(protectedResourceRequestMock).not.toHaveBeenCalled()
  })

  // ---- roborev HIGH #1: a token refresh must route through the DEFAULT (patched-global) fetch,
  // NEVER the restored per-resource DPoP fetch (which is the EXPIRED-token fetch a refresh exists
  // to replace — routing the refresh through it sends the token request under the wrong/expired
  // DPoP authorization). ----
  it('the refresh\'s restoreSession uses the DEFAULT fetch, NOT the restored per-resource fetch', async () => {
    // A distinctly-identifiable default (patched-global) fetch + a distinct restored fetch.
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)

    const webId = 'https://dave.pod.example/profile/card#me'
    rememberedRead.mockReturnValue({ webId, issuer: 'https://issuer.example/' })
    restoreSessionMock
      .mockResolvedValueOnce({ webId, accessToken: 'token1', dpopHandle: SENTINEL_HANDLE, issuer: 'https://issuer.example/' }) // initial restore
      .mockResolvedValueOnce({ webId, accessToken: 'token2', dpopHandle: SENTINEL_HANDLE, issuer: 'https://issuer.example/' }) // refresh
    decisionImpl = async (inputs) => {
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' }
    }

    const restored = await silentRestore()
    expect(restored).not.toBeNull()

    // The plugin ADOPTS the restored per-resource fetch as solidFetch.value (the real flow). After
    // this, solidFetch.value IS the restored DPoP fetch — distinct from the default/patched global.
    solidFetch.value = restored!.fetch
    expect(solidFetch.value).not.toBe(getDefaultSolidFetch())

    // First pod request 401s (token1 expired) → triggers the silent refresh → token2 → retry ok.
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await restored!.fetch('https://dave.pod.example/elk/kv/x')
    expect(res.status).toBe(200)

    // The refresh re-invoked restoreSession exactly once more (call index 1 = the refresh).
    expect(restoreSessionMock).toHaveBeenCalledTimes(2)
    const refreshCall = restoreSessionMock.mock.calls[1][0] as { fetch?: unknown }
    // CRITICAL: the refresh's token-endpoint request used the DEFAULT fetch — IDENTITY-equal to
    // the patched global — NOT the restored per-resource DPoP fetch (the expired-token fetch).
    expect(refreshCall.fetch).toBe(patchedGlobal)
    expect(refreshCall.fetch).not.toBe(restored!.fetch)
    expect(refreshCall.fetch).not.toBe(solidFetch.value)
  })

  // ---- roborev HIGH #2: restore-in-flight race. A login()/logout() that happens WHILE a silent
  // restore is in flight must WIN — the late-resolving restore is DISCARDED, never adopting the
  // stale restored user's DPoP fetch. We exercise the SAME generation-guard contract the plugin
  // uses (beginRestoreGeneration before the async restore; isRestoreGenerationCurrent after it;
  // login bumps via bumpRestoreGeneration, logout via disconnectSolid). ----

  // Re-implements the plugin's restore-adopt flow over the session-module guard primitives, so the
  // race can be unit-tested without the full Nuxt plugin harness. `race` runs WHILE restore is in
  // flight (between begin and resolve) to simulate an interactive login()/logout() interleaving.
  async function runPluginRestoreWithRace(
    restoredFetch: typeof globalThis.fetch,
    race: () => void,
  ): Promise<void> {
    const restoreGen = beginRestoreGeneration() // plugin captures the generation BEFORE the restore
    // The async restore: a deferred whose resolution we control so `race()` runs mid-flight.
    let resolveRestore!: (v: { fetch: typeof globalThis.fetch }) => void
    const restorePromise = new Promise<{ fetch: typeof globalThis.fetch }>(r => (resolveRestore = r))
    const adopted = restorePromise.then((restored) => {
      // The plugin's guard: only adopt the restored fetch if no login/logout raced ahead.
      if (!isRestoreGenerationCurrent(restoreGen))
        return
      solidFetch.value = restored.fetch
    })
    // An interactive login() / logout() fires WHILE the restore is still pending.
    race()
    // Now the restore finally resolves — its .then runs the guard.
    resolveRestore({ fetch: restoredFetch })
    await adopted
  }

  it('a LOGIN that races an in-flight restore DISCARDS the late restore (login wins)', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    // Start from the default fetch (as after the plugin records the patched global).
    resetSolidFetchToDefault()
    const staleRestoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // login() bumps the generation (and resets the fetch to default — its real behaviour).
    await runPluginRestoreWithRace(staleRestoredFetch, () => {
      bumpRestoreGeneration() // what login() does first
      resetSolidFetchToDefault() // what login() does next
    })

    // The stale restored fetch was NOT adopted — the pod fetch reflects the login (default), not
    // Alice's restored DPoP fetch.
    expect(solidFetch.value).toBe(patchedGlobal)
    expect(solidFetch.value).not.toBe(staleRestoredFetch)
  })

  it('a LOGOUT (disconnectSolid) that races an in-flight restore DISCARDS the late restore', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const staleRestoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // logout() == disconnectSolid(): it bumps the generation AND resets the fetch to default.
    await runPluginRestoreWithRace(staleRestoredFetch, () => {
      disconnectSolid()
    })

    // The stale restored fetch was NOT adopted — the pod fetch reflects the logout (default).
    expect(solidFetch.value).toBe(patchedGlobal)
    expect(solidFetch.value).not.toBe(staleRestoredFetch)
  })

  it('with NO racing login/logout, an in-flight restore IS adopted (guard is not vacuous)', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const restoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // No race: nothing bumps the generation between begin and resolve.
    await runPluginRestoreWithRace(restoredFetch, () => {})

    // The restored fetch IS adopted — proving the guard discards ONLY on a real race.
    expect(solidFetch.value).toBe(restoredFetch)
    expect(solidFetch.value).not.toBe(patchedGlobal)
  })

  // ---- roborev HIGH #3 (the LAST race window): the generation is checked BEFORE adopting the
  // restored fetch, but `connectSolid()` and `mountPod()` `await` AFTER it. A login()/logout() that
  // fires in that POST-ADOPTION window (after the line-191 check, during the connect/mount awaits)
  // must still WIN: the stale restore must perform NO further shared-state mutation, and its FAILURE
  // path must NOT call disconnectSolid() on the now-CURRENT session. We re-implement the plugin's
  // full post-adoption flow over the SAME guard primitives, with controllable awaits so a race can
  // be injected at the precise point connectSolid()/mountPod() would suspend. ----

  // Faithfully mirrors the plugin's restore .then/.catch flow (the fixed version): adopt the fetch,
  // re-check the generation after EACH await, abort silently when stale, and — in the catch — gate
  // disconnectSolid() on the generation. `connect`/`mount` are injected so a test can make them
  // throw (to drive the catch) and so `raceDuringConnect`/`raceDuringMount` fire WHILE they're
  // suspended. `mutate*` record any shared-state write the flow performs so a test can assert a
  // stale restore made NONE. Returns whether disconnect ran (the current-session-teardown signal).
  async function runPluginPostAdoptionRace(opts: {
    restoredFetch: typeof globalThis.fetch
    connect: () => Promise<void>
    mount?: () => Promise<void>
    raceDuringConnect?: () => void
    raceDuringMount?: () => void
    mutateOnConnect?: () => void
    mutateOnMount?: () => void
  }): Promise<{ disconnectCalled: boolean }> {
    const restoreGen = beginRestoreGeneration()
    let disconnectCalled = false
    // The plugin's logout()/its catch both ultimately call disconnectSolid(); here we wrap it so the
    // test can observe whether the STALE restore wrongly tore down the current session.
    const disconnect = () => {
      disconnectCalled = true
      disconnectSolid()
    }
    try {
      const restored = { fetch: opts.restoredFetch }
      // pre-adoption guard (already covered by the older tests; included so the flow is faithful)
      if (!isRestoreGenerationCurrent(restoreGen))
        return { disconnectCalled }
      solidFetch.value = restored.fetch
      // connectSolid(): suspends here — inject the race, then (in the real plugin) it writes
      // solidWebId/solidPodBase. We only perform that write if STILL current.
      opts.raceDuringConnect?.()
      await opts.connect()
      if (!isRestoreGenerationCurrent(restoreGen))
        return { disconnectCalled } // stale during connect → leave newer state intact, NO mutation
      opts.mutateOnConnect?.()
      // mountPod(): suspends here — inject the race, then it would mount pod storage.
      opts.raceDuringMount?.()
      if (opts.mount)
        await opts.mount()
      if (!isRestoreGenerationCurrent(restoreGen))
        return { disconnectCalled } // stale during mount → no trailing mutation
      opts.mutateOnMount?.()
      return { disconnectCalled }
    }
    catch {
      // The fixed catch: ONLY a CURRENT restore's failure may clean up. A stale restore returns
      // silently — disconnectSolid() here would tear down the now-current session (the HIGH).
      if (!isRestoreGenerationCurrent(restoreGen))
        return { disconnectCalled }
      disconnect()
      return { disconnectCalled }
    }
  }

  it('a LOGIN firing AFTER fetch-adoption but DURING the connect/mount awaits → stale restore makes NO further state mutation', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const staleRestoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // What the interactive login() actually does (its first two steps) — fired mid-connect.
    const loginFetch = (async () => new Response('login', { status: 200 })) as typeof globalThis.fetch
    const login = () => {
      bumpRestoreGeneration() // login() bumps the generation FIRST
      setDefaultSolidFetch(loginFetch)
      resetSolidFetchToDefault() // login() resets to default next → solidFetch.value = loginFetch
    }

    let podWriteHappened = false
    const { disconnectCalled } = await runPluginPostAdoptionRace({
      restoredFetch: staleRestoredFetch,
      raceDuringConnect: login, // the login fires AFTER adoption, while connectSolid() is suspended
      connect: async () => {}, // connectSolid() resolves
      mount: async () => {},
      mutateOnConnect: () => { podWriteHappened = true }, // would write solidWebId/solidPodBase
      mutateOnMount: () => { podWriteHappened = true }, // would mount pod storage
    })

    // The stale restore performed NO further mutation after going stale — no pod write.
    expect(podWriteHappened).toBe(false)
    // The pod fetch reflects the LOGIN, not the stale restored DPoP fetch.
    expect(solidFetch.value).toBe(loginFetch)
    expect(solidFetch.value).not.toBe(staleRestoredFetch)
    // The stale restore did NOT tear down the current session.
    expect(disconnectCalled).toBe(false)
  })

  it('a LOGOUT firing in the post-adoption window → stale restore does NOT disconnect the current (logged-out) session and does NOT re-mount', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const staleRestoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    let mounted = false
    // The logout() == disconnectSolid() fires mid-connect (after adoption). It bumps the generation.
    const { disconnectCalled } = await runPluginPostAdoptionRace({
      restoredFetch: staleRestoredFetch,
      raceDuringConnect: () => { disconnectSolid() }, // logout in the post-adoption window
      connect: async () => {},
      mount: async () => { mounted = true },
      mutateOnMount: () => { mounted = true },
    })

    // The stale restore did NOT re-mount the pod for the logged-out user.
    expect(mounted).toBe(false)
    // The pod fetch is the default (logout reset it), NOT the stale restored DPoP fetch.
    expect(solidFetch.value).toBe(patchedGlobal)
    expect(solidFetch.value).not.toBe(staleRestoredFetch)
    // CRITICAL: the stale restore did NOT call disconnectSolid() on the current (logged-out) session.
    expect(disconnectCalled).toBe(false)
  })

  it('a stale restore whose connect/mount FAILS does NOT disconnect the now-current session (catch is generation-gated)', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const staleRestoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // A newer login fires mid-connect, THEN connectSolid() rejects (a genuine failure of the now-stale restore).
    const loginFetch = (async () => new Response('login', { status: 200 })) as typeof globalThis.fetch
    const { disconnectCalled } = await runPluginPostAdoptionRace({
      restoredFetch: staleRestoredFetch,
      raceDuringConnect: () => {
        bumpRestoreGeneration()
        setDefaultSolidFetch(loginFetch)
        resetSolidFetchToDefault()
      },
      connect: async () => { throw new Error('connect failed after the race') },
    })

    // The stale restore's failure did NOT tear down the now-current login's session.
    expect(disconnectCalled).toBe(false)
    expect(solidFetch.value).toBe(loginFetch)
  })

  it('happy path (no race): the post-adoption flow fully connects AND mounts (guard not vacuous)', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const restoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    let connected = false
    let mounted = false
    const { disconnectCalled } = await runPluginPostAdoptionRace({
      restoredFetch,
      connect: async () => {},
      mount: async () => {},
      mutateOnConnect: () => { connected = true },
      mutateOnMount: () => { mounted = true },
    })

    // With NO race the full flow runs: fetch adopted, connect + mount both performed.
    expect(solidFetch.value).toBe(restoredFetch)
    expect(connected).toBe(true)
    expect(mounted).toBe(true)
    expect(disconnectCalled).toBe(false)
  })

  it('real connectSolid: a generation bump DURING resolveStorageRoot blocks the stale restore\'s solidWebId/solidPodBase writes', async () => {
    // Drive the PRODUCTION connectSolid(webId, isCurrent). resolveStorageRoot awaits solidFetch.value
    // before writing solidWebId/solidPodBase — the residual internal-await window. We suspend that
    // fetch, bump the generation (a racing login/logout) mid-flight, then resolve: the stale restore
    // must write NEITHER ref.
    solidWebId.value = null
    solidPodBase.value = null
    const restoreGen = beginRestoreGeneration()

    // A controllable fetch: the FIRST call (resolveStorageRoot) suspends until we release it; we bump
    // the generation while it is suspended. A non-ok response makes resolveStorageRoot fall back to
    // the origin-root default (no parseRdf) and makes resolveOidcIssuer throw (caught) — so the only
    // writes that could happen are the generation-gated solidWebId/solidPodBase.
    let releaseFetch!: () => void
    const gate = new Promise<void>(r => (releaseFetch = r))
    let first = true
    solidFetch.value = (async () => {
      if (first) {
        first = false
        await gate
      }
      return new Response('nope', { status: 404 })
    }) as typeof globalThis.fetch

    const connecting = connectSolid('https://alice.pod.example/profile/card#me', () => isRestoreGenerationCurrent(restoreGen))
    // A racing login()/logout() bumps the generation WHILE resolveStorageRoot is suspended.
    bumpRestoreGeneration()
    releaseFetch()
    await connecting

    // The stale restore's connectSolid wrote NEITHER shared ref — the newer session is untouched.
    expect(solidWebId.value).toBeNull()
    expect(solidPodBase.value).toBeNull()
  })

  it('real connectSolid: with NO race (still current), the writes DO happen (guard not vacuous)', async () => {
    solidWebId.value = null
    solidPodBase.value = null
    const restoreGen = beginRestoreGeneration()
    // A simple non-ok fetch → origin-root fallback for storage; issuer resolution throws (caught).
    solidFetch.value = (async () => new Response('nope', { status: 404 })) as typeof globalThis.fetch

    await connectSolid('https://alice.pod.example/profile/card#me', () => isRestoreGenerationCurrent(restoreGen))

    // No race → the refs ARE written (origin-root + Elk namespace).
    expect(solidWebId.value).toBe('https://alice.pod.example/profile/card#me')
    expect(solidPodBase.value).toBe('https://alice.pod.example/elk/')
  })

  it('a stale restore whose connect/mount FAILS while STILL CURRENT does fail-closed + disconnect (catch not vacuous)', async () => {
    const patchedGlobal = (async () => new Response('global', { status: 200 })) as typeof globalThis.fetch
    setDefaultSolidFetch(patchedGlobal)
    resetSolidFetchToDefault()
    const restoredFetch = authedFetchFromRestoredSession(restoredSession('https://alice.example/#me'))

    // NO race — the restore stays current — but connectSolid() genuinely fails. The catch SHOULD
    // clean up (this proves the generation gate in the catch is not always-skip).
    const { disconnectCalled } = await runPluginPostAdoptionRace({
      restoredFetch,
      connect: async () => { throw new Error('genuine connect failure, no race') },
    })

    expect(disconnectCalled).toBe(true)
  })

  it('the restored fetch CAN re-mint via refresh, re-invoking restoreSession for the SAME issuer', async () => {
    // Through the full silentRestore path: the built fetch is refresh-capable and the refresh
    // callback re-runs restoreSession (the silent refresh-grant seam) for the remembered issuer.
    const webId = 'https://carol.pod.example/profile/card#me'
    rememberedRead.mockReturnValue({ webId, issuer: 'https://issuer.example/' })
    // First restore (initial) yields token1; the refresh re-invocation yields token2.
    restoreSessionMock
      .mockResolvedValueOnce({ webId, accessToken: 'token1', dpopHandle: SENTINEL_HANDLE, issuer: 'https://issuer.example/' })
      .mockResolvedValueOnce({ webId, accessToken: 'token2', dpopHandle: SENTINEL_HANDLE, issuer: 'https://issuer.example/' })
    decisionImpl = async (inputs) => {
      const r = await inputs.restoreIssuer('https://issuer.example/')
      return { outcome: 'restored', webId: r.webId, issuer: 'https://issuer.example/' }
    }

    const restored = await silentRestore()
    expect(restored).not.toBeNull()

    // First pod request 401s (token1 expired) → refresh re-invokes restoreSession → token2 → retry ok.
    protectedResourceRequestMock
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await restored!.fetch('https://carol.pod.example/elk/kv/x')

    expect(res.status).toBe(200)
    // restoreSession ran twice: the initial restore + ONE silent refresh.
    expect(restoreSessionMock).toHaveBeenCalledTimes(2)
    // The refresh re-invocation used the SAME issuer + clientId as the initial restore.
    const refreshCall = restoreSessionMock.mock.calls[1][0] as { issuer: URL, clientId?: string }
    expect(refreshCall.issuer.href).toBe('https://issuer.example/')
    expect(refreshCall.clientId).toBe('https://elk.example/clientid.jsonld')
    // The retry used the freshly minted token2.
    expect(protectedResourceRequestMock.mock.calls[1][0]).toBe('token2')
    // No popup at any point.
    expect(windowOpen).not.toHaveBeenCalled()
  })
})
