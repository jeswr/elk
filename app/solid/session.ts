// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Solid session state for Elk — a SECOND identity alongside Elk's Mastodon OAuth.
 *
 * Elk authenticates to a Mastodon/fediverse server (its primary identity). This
 * module adds an INDEPENDENT Solid login so the user can ALSO connect a Solid pod
 * (their personal data store) without touching the Mastodon session: the two
 * identities coexist (a Solid WebID + a Mastodon account).
 *
 * The auth model is `@solid/reactive-authentication`'s "patched global fetch": there
 * is no session object and no wrapped fetch — `ReactiveFetchManager.registerGlobally()`
 * upgrades every `fetch()` that gets a 401 from a pod by attaching a DPoP-bound token.
 * So the "authed fetch" we hand to the unstorage-solid driver and the mirror is just
 * `globalThis.fetch` once the manager is registered. We track the WebID separately
 * (reactive `solidWebId`) so the rest of the app knows a pod is connected and where to
 * write.
 *
 * Silent session restore (cross-app UX invariant #1): on load we read the persisted
 * WebID via `@jeswr/solid-session-restore` and re-establish the connection without a
 * popup while the IdP cookie session lives (reactive-auth's `prompt=none` path), only
 * falling back to interactive login on genuine restore failure.
 *
 * This module is browser-only (reactive-auth defines custom elements + opens popups);
 * import it solely from a `.client.ts` plugin.
 */

import type { RestoredSession } from '@jeswr/solid-session-restore'
import { computed, ref, shallowRef } from 'vue'

/** The current Solid WebID, or `null` when no pod is connected. */
export const solidWebId = ref<string | null>(null)

/** `true` while a silent session restore is in flight on load. */
export const solidRestoring = ref(false)

/** True once a Solid pod session is connected (a WebID is known). */
export const solidConnected = computed(() => solidWebId.value !== null)

/**
 * The authenticated `fetch` for pod requests. Once reactive-auth's manager is
 * registered globally, the plain `globalThis.fetch` IS the authed fetch (it upgrades
 * on 401), so this returns `globalThis.fetch` bound to `globalThis`. Kept as a seam so
 * the driver/mirror depend on an injected fetch rather than the global directly — which
 * also makes them unit-testable with a stub.
 *
 * SECURITY: a SILENT RESTORE replaces this with a restored per-session DPoP fetch bound to one
 * user's token. That per-session fetch MUST be dropped on logout / before a new interactive
 * login (see {@link resetSolidFetchToDefault}) so one user's token can never be reused for
 * another user's pod requests (cross-user token reuse).
 */
export const solidFetch = shallowRef<typeof globalThis.fetch>(
  globalThis.fetch?.bind(globalThis),
)

/**
 * The DEFAULT pod fetch — the reactive-auth PATCHED GLOBAL fetch (or the bare global before the
 * manager registers). It is shared across users: it upgrades a pod 401 with a DPoP token for the
 * CURRENTLY interactive identity, so it carries no single user's restored token. The plugin
 * records it via {@link setDefaultSolidFetch} once the reactive-auth manager is registered;
 * {@link resetSolidFetchToDefault} restores it (dropping any restored per-session fetch).
 */
let defaultSolidFetch: typeof globalThis.fetch = globalThis.fetch?.bind(globalThis)

/**
 * Record the DEFAULT pod fetch (the reactive-auth patched global). Called by the plugin once the
 * `ReactiveFetchManager` is registered, so {@link resetSolidFetchToDefault} can later restore it.
 */
export function setDefaultSolidFetch(fetchImpl: typeof globalThis.fetch): void {
  defaultSolidFetch = fetchImpl
}

/**
 * The CURRENT default pod fetch (the reactive-auth patched global), via a stable getter. A SILENT
 * TOKEN REFRESH (re-running the refresh-grant restore at the token endpoint) MUST go through THIS,
 * never `solidFetch.value`: after a successful restore `solidFetch.value` IS the restored
 * per-resource DPoP fetch (an EXPIRED-token fetch when a refresh is needed), so routing the
 * refresh's token-endpoint request through it would send the token request under the
 * expired/wrong DPoP authorization (recursion / wrong auth headers — the roborev HIGH). The
 * patched global upgrades a 401 for the currently interactive identity and carries no single
 * user's restored token, so it is the correct transport for the discovery + grant. Returned as a
 * getter (re-evaluated per call) so the refresh rides whatever the patched global currently is.
 */
export function getDefaultSolidFetch(): typeof globalThis.fetch {
  return defaultSolidFetch
}

/**
 * RESET the pod fetch to the default (patched global) fetch, DROPPING any restored per-session
 * DPoP fetch. MUST run on logout AND before any interactive login / account switch so a restored
 * user's DPoP token can never be reused for a DIFFERENT user's profile resolution, ACL writes,
 * or pod mounting (the cross-user-token-reuse finding). The restored fetch is only ever held in
 * `solidFetch.value`; overwriting it here drops the last reference so its captured token does not
 * outlive the session.
 */
export function resetSolidFetchToDefault(): void {
  solidFetch.value = defaultSolidFetch
}

/**
 * The RESTORE GENERATION counter (roborev HIGH — restore-in-flight cross-user race). A silent
 * restore is ASYNCHRONOUS: between calling `silentRestore()` and its resolution the user may
 * interactively `login()` or `logout()`. Without a guard the late-resolving restore would
 * unconditionally adopt the OLD restored user's DPoP fetch, clobbering the interactive
 * login/logout that happened meanwhile (one user's token leaking onto another's session).
 *
 * The protocol: a restore captures the current generation via {@link beginRestoreGeneration}
 * (which bumps it so any restore ALREADY in flight is invalidated too); `login()`, `logout()`,
 * and `disconnectSolid()` each call {@link bumpRestoreGeneration} to invalidate any in-flight
 * restore; when a restore resolves the caller adopts its result ONLY if
 * {@link isRestoreGenerationCurrent} still holds for its captured generation — otherwise the
 * stale restore is DISCARDED (no fetch adopted, no pod mounted).
 */
let restoreGeneration = 0

/**
 * Bump the restore generation, invalidating any silent restore currently in flight. Call from
 * the interactive `login()` and from `logout()`/`disconnectSolid()` so a restore that resolves
 * AFTER an explicit login/logout is discarded rather than clobbering it.
 */
export function bumpRestoreGeneration(): void {
  restoreGeneration++
}

/**
 * Begin a restore: bump the generation (so an EARLIER in-flight restore is also invalidated) and
 * return the new generation for the caller to capture. The caller passes this token to
 * {@link isRestoreGenerationCurrent} when the restore resolves to decide whether to adopt it.
 */
export function beginRestoreGeneration(): number {
  bumpRestoreGeneration()
  return restoreGeneration
}

/**
 * Whether the captured restore generation is still the current one — i.e. no `login()`,
 * `logout()`, `disconnectSolid()`, or newer restore happened since the restore began. When this
 * is false the restore result is STALE and MUST be discarded (do not adopt its fetch / mount).
 */
export function isRestoreGenerationCurrent(gen: number): boolean {
  return gen === restoreGeneration
}

/**
 * The base container under which Elk writes the user's pod data. Derived from the
 * pod's storage root (from the WebID profile) when known; defaults to a conventional
 * sub-container. Set by {@link connectSolid} once the storage root resolves.
 */
export const solidPodBase = ref<string | null>(null)

/** localStorage key persisting the last-connected WebID (for silent restore). */
export const SOLID_WEBID_KEY = 'elk-solid-webid'

/**
 * The localStorage key for the credential-free remembered-account pointer (WebID→issuer)
 * that `@jeswr/solid-session-restore` reads on load to pick which issuer to silently
 * restore. App-scoped per the package's per-app-pointer rule.
 */
export const ELK_REMEMBERED_ACCOUNT_KEY = 'elk-solid.remembered-account'

/**
 * The per-app IndexedDB database name holding the DPoP-bound refresh-token credential that
 * silent restore redeems. App-scoped per the package's per-app-store rule (two apps on a
 * shared origin never share a session store).
 */
export const ELK_SESSION_DB_NAME = 'elk-solid:sessions'

/** The container (relative to the pod storage root) Elk owns for its KV + timeline. */
export const ELK_POD_NAMESPACE = 'elk/'

/**
 * Validate + normalise an untrusted container-URL string (a `pim:storage` object value)
 * into a canonical container address, or `undefined` when it must be rejected.
 *
 * SECURITY (untrusted-RDF hardening): a WebID profile is fetched from wherever the
 * user's `pim:storage` triple points — it is attacker-influenced input, not trusted
 * config. The naive `root.endsWith('/')` check this replaces operates on the RAW
 * string, so a value like `https://evil.example/foo?x=/` or `https://evil.example/foo#/`
 * satisfies it (the string literally ends with `/`) while the ACTUAL resource path is
 * `/foo` — the query/fragment is what supplied the trailing slash. Concatenating a
 * sub-path onto that raw string then lands on a completely different resource than the
 * container-shape check implied. Parsing via `new URL()` FIRST and checking the PARSED
 * `pathname` closes this: a query/fragment can no longer forge the container shape.
 *
 * Rejects: an unparseable value, a non-http(s) scheme, any `search`/`hash` component
 * (a container address carries neither), and a pathname that does not end with `/`.
 * Returns the canonical `url.toString()` on success.
 */
function normalizeContainerUrl(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return undefined
  if (url.search !== '' || url.hash !== '')
    return undefined
  if (!url.pathname.endsWith('/'))
    return undefined
  return url.toString()
}

/**
 * Resolve the pod storage root for a WebID by dereferencing its profile and reading
 * `pim:storage` (`http://www.w3.org/ns/pim/space#storage`). Falls back to the WebID's
 * origin root when the profile advertises no (validatable) storage. Returns a URL
 * ending in exactly one `/`, with no query/fragment (see {@link normalizeContainerUrl}).
 *
 * Uses the injected (authed) fetch so a private profile still resolves.
 */
export async function resolveStorageRoot(
  webId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#storage'
  try {
    const res = await fetchImpl(webId, {
      headers: { accept: 'text/turtle, application/ld+json;q=0.9' },
    })
    if (res.ok) {
      const body = await res.text()
      const ct = res.headers.get('content-type')
      const { parseRdf } = await import('@jeswr/fetch-rdf')
      const dataset = await parseRdf(body, ct, { baseIRI: webId })
      for (const quad of dataset) {
        if (quad.predicate.value === PIM_STORAGE && quad.object.termType === 'NamedNode') {
          const normalized = normalizeContainerUrl(quad.object.value)
          if (normalized)
            return normalized
          // Malformed/malicious pim:storage value (query/fragment/non-container-shape,
          // or an unparseable/non-http(s) IRI) — skip it and keep looking at the rest of
          // the profile; fall through to the origin-root default if none validates.
        }
      }
    }
  }
  catch {
    // fall through to origin-root default
  }
  const u = new URL(webId)
  return `${u.origin}/`
}

/**
 * Resolve a WebID's OIDC issuer (`solid:oidcIssuer`) by dereferencing its profile. The
 * WebID-first login model: the issuer comes from the user's own profile, not a guessed
 * host map. Throws an actionable error when the profile advertises no issuer (or none of
 * the issuers is an http(s) IRI). When several are listed, the first http(s) one is used.
 */
export async function resolveOidcIssuer(
  webId: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer'
  const res = await fetchImpl(webId, {
    headers: { accept: 'text/turtle, application/ld+json;q=0.9' },
  })
  if (!res.ok)
    throw new Error(`Cannot resolve issuer: WebID profile ${webId} returned ${res.status}`)
  const body = await res.text()
  const ct = res.headers.get('content-type')
  const { parseRdf } = await import('@jeswr/fetch-rdf')
  const dataset = await parseRdf(body, ct, { baseIRI: webId })
  for (const quad of dataset) {
    if (quad.predicate.value === SOLID_OIDC_ISSUER && quad.object.termType === 'NamedNode') {
      const value = quad.object.value
      if (value.startsWith('https://') || value.startsWith('http://'))
        return value
    }
  }
  throw new Error(
    `This WebID can't be used for Solid login — its profile has no solid:oidcIssuer (${webId})`,
  )
}

/**
 * The result of a SUCCESSFUL silent restore: the authenticated WebID PLUS the DPoP-bound,
 * AUTHENTICATED `fetch` rebuilt from the restored session. The caller MUST adopt this fetch
 * as the pod fetch (`solidFetch.value`) BEFORE mounting pod storage — otherwise the first
 * protected pod request would go out on the bare, UNAUTHENTICATED global fetch (the roborev
 * HIGH this fixes), falling into reactive-auth's interactive popup or failing outright.
 */
export interface SilentRestoreResult {
  /** The WebID the restored session authenticated AS. */
  readonly webId: string
  /**
   * The DPoP-authenticated `fetch` for this session — every request carries
   * `Authorization: DPoP <accessToken>` + a fresh per-request DPoP proof signed by the
   * session's bound (non-extractable) key. This is the "restored authed fetch" the
   * cross-app invariant requires reach pod storage with NO popup.
   */
  readonly fetch: typeof globalThis.fetch
}

/** The live DPoP credential a restored fetch sends with: the access token + its bound handle. */
export type RestoredCredential = Pick<RestoredSession, 'accessToken' | 'dpopHandle'>

/**
 * A SILENT refresh of the restored credential: re-mint a fresh access token (+ handle) from
 * the persisted DPoP-bound refresh token via `@jeswr/solid-session-restore`'s `restoreSession`
 * — a token-endpoint fetch, NEVER a popup/iframe. Returns the new credential, or `null` when
 * the refresh itself fails (dead/revoked token, transient blip) so the caller can fail-closed
 * rather than loop.
 */
export type RefreshRestoredCredential = () => Promise<RestoredCredential | null>

/**
 * Whether a `protectedResourceRequest` rejection (or a returned response) signals the access
 * token is EXPIRED / INVALID (an `invalid_token` WWW-Authenticate challenge or a bare 401), as
 * opposed to a DPoP-nonce challenge or an unrelated error. oauth4webapi throws a
 * `WWWAuthenticateChallengeError` carrying `.status` for a parseable challenge; a pod that
 * returns a 401 with no parseable challenge surfaces as a returned `Response`. We treat EITHER
 * 401 as a token-expiry signal that warrants ONE silent refresh + retry.
 */
function isTokenExpiry(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 401
}

/**
 * Build a DPoP-AUTHENTICATED, REFRESH-CAPABLE `fetch` from a restored session. The
 * auth-attaching mechanism is `oauth4webapi`'s `protectedResourceRequest` driven by the
 * session's live `dpopHandle` (created INSIDE `@jeswr/solid-session-restore` from the
 * persisted, non-extractable key) and its `accessToken`. We DELEGATE the DPoP proof signing +
 * the `Authorization: DPoP …` header + the server-nonce handshake to oauth4webapi (the same
 * vetted library that minted the handle) — NEVER hand-rolling a proof.
 *
 * Two DISTINCT single retries, in order:
 *  1. DPoP-NONCE retry (RFC 9449 §8): a server may answer the first DPoP request with a
 *     `use_dpop_nonce` challenge; the handle captures that nonce, so we retry ONCE with it
 *     primed. This does NOT consume the token-refresh retry.
 *  2. TOKEN-REFRESH retry: the captured access token is short-lived. When a request gets a 401
 *     (`invalid_token` challenge OR a bare 401 response), we run the injected `refresh` ONCE to
 *     silently re-mint a fresh access token (+ handle) from the persisted refresh credential,
 *     adopt it as the captured credential (so subsequent requests use the fresh token too), and
 *     retry the request ONCE with the new credential. If `refresh` is absent or itself fails →
 *     propagate the 401 to the caller (read paths degrade to "absent", writes see a non-ok) —
 *     we do NOT loop.
 *
 * The returned function matches the Fetch API surface the unstorage-solid driver / mirror call
 * (`fetch(input, init)`), adapting it to `protectedResourceRequest`'s
 * `(accessToken, method, url, headers, body, opts)` shape.
 */
export function authedFetchFromRestoredSession(
  session: RestoredCredential,
  refresh?: RefreshRestoredCredential,
): typeof globalThis.fetch {
  // The CAPTURED credential — mutable so a successful silent refresh updates it in place, and
  // every later request on this fetch uses the fresh token (not the original expired one).
  let cred: RestoredCredential = { accessToken: session.accessToken, dpopHandle: session.dpopHandle }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Normalise the Fetch API call through a SINGLE Request instance so the body bytes and the
    // Content-Type header (e.g. a multipart/form-data boundary) are derived from the same
    // serialization — re-serializing the body through a second Request can mint a DIFFERENT
    // boundary than the header copied from the original (the roborev LOW). A `Request` carries
    // its own method/headers/body, overridden by an explicit `init`.
    const req = new Request(input, init)
    const method = req.method
    const url = new URL(req.url)
    const headers = new Headers(req.headers)
    // protectedResourceRequest sets Authorization + DPoP itself; drop any stale ones.
    headers.delete('authorization')
    headers.delete('dpop')
    // Read the body ONCE from the SAME req (GET/HEAD have none), so the bytes match the headers
    // (incl. the boundary in any Content-Type set by the Request body serialization).
    let body: ArrayBuffer | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const ab = await req.arrayBuffer()
      body = ab.byteLength > 0 ? ab : undefined
    }

    const oauth = await import('oauth4webapi')
    const send = (): Promise<Response> =>
      oauth.protectedResourceRequest(
        cred.accessToken,
        method,
        url,
        new Headers(headers),
        body,
        { DPoP: cred.dpopHandle, signal: req.signal ?? undefined },
      )

    // First attempt, with the DPoP-nonce retry (RFC 9449 §8) folded in. `attempt()` resolves to
    // a Response (incl. a 401 a pod returns without a parseable challenge) or throws.
    const attempt = async (): Promise<Response> => {
      try {
        return await send()
      }
      catch (err) {
        // One DPoP-nonce retry once the handle has captured the server's nonce.
        if (oauth.isDPoPNonceError(err))
          return await send()
        throw err
      }
    }

    // Run the request, then — ONCE — refresh-on-401 + retry. We catch both shapes of a 401: a
    // thrown WWWAuthenticateChallengeError (invalid_token) and a returned bare-401 Response.
    try {
      const res = await attempt()
      if (res.status === 401 && refresh)
        return (await refreshAndRetry(attempt, refresh)) ?? res
      return res
    }
    catch (err) {
      if (isTokenExpiry(err) && !oauth.isDPoPNonceError(err) && refresh) {
        const retried = await refreshAndRetry(attempt, refresh)
        if (retried)
          return retried
      }
      throw err
    }

    // Run the injected silent refresh ONCE; on success adopt the fresh credential and retry the
    // request once. Returns the retried Response, or `null` when refresh failed / the retry
    // still 401s (caller then propagates the original 401 — no loop).
    async function refreshAndRetry(
      retry: () => Promise<Response>,
      doRefresh: RefreshRestoredCredential,
    ): Promise<Response | null> {
      let fresh: RestoredCredential | null = null
      try {
        fresh = await doRefresh()
      }
      catch {
        // Refresh itself threw — fail-closed, no loop.
        return null
      }
      if (!fresh)
        return null
      cred = { accessToken: fresh.accessToken, dpopHandle: fresh.dpopHandle }
      try {
        const res = await retry()
        // A second 401 after a fresh token → do NOT loop; let the caller see the failure.
        return res.status === 401 ? null : res
      }
      catch (retryErr) {
        // Only SUPPRESS a SECOND auth failure (another 401 / token-expiry challenge): return null
        // so the ORIGINAL 401 propagates and we do NOT loop. RETHROW any UNRELATED retry error
        // (network, 5xx, parse, DPoP-nonce) so a real failure surfaces as itself rather than
        // being masked as the original 401 (the roborev Medium). `attempt()` folds in its own
        // single DPoP-nonce retry, so a nonce error here is genuinely terminal — but it is not a
        // token-expiry, so it must rethrow, not be silently swallowed.
        if (isTokenExpiry(retryErr) && !oauth.isDPoPNonceError(retryErr))
          return null
        throw retryErr
      }
    }
  }
}

/**
 * Attempt a SILENT Solid session restore on load — refresh-grant only, NEVER a popup or
 * redirect (cross-app UX invariant #1). Reads the credential-free remembered-account
 * pointer (`@jeswr/solid-session-restore`) to find the last-active WebID + its issuer, then
 * redeems the persisted DPoP-bound refresh token via `restoreSession` (a token-endpoint
 * `fetch`, no window/iframe). The restore decision (`decideSilentRestore`) re-checks the
 * restored WebID equals the remembered one (WebID-scoped isolation, fail-closed).
 *
 * Returns, on success, the restored WebID AND the DPoP-AUTHENTICATED `fetch` rebuilt from the
 * restored session ({@link SilentRestoreResult}) — the caller adopts that fetch as the pod
 * fetch BEFORE mounting pod storage so every pod request carries the restored DPoP
 * authorization with NO popup (the roborev HIGH). Returns `null` when there is nothing to
 * restore / the credential is dead / the restore failed. CRUCIALLY it NEVER opens an
 * interactive login — on failure the user is simply left logged-out and an interactive login
 * is deferred to an explicit user action (a login button). Doomed/stale pointers are dropped
 * per the package's keep/drop matrix so they are not retried forever.
 *
 * NOTE: a silent restore only succeeds when a DPoP-bound refresh-token credential was
 * persisted at login time (IndexedDB, `extractable:false` key). Until the login path
 * persists one, this resolves to `null` (→ logged-out, no popup) — which is exactly the
 * fail-closed, no-popup-on-restore behaviour the invariant requires.
 */
export async function silentRestore(): Promise<SilentRestoreResult | null> {
  // Browser-only: IndexedDB + localStorage are required; bail (no popup) otherwise.
  if (typeof window === 'undefined')
    return null
  let result: SilentRestoreResult | null = null
  try {
    const {
      IndexedDbSessionStore,
      RememberedAccount,
      decideSilentRestore,
      indexedDbAvailable,
      restoreSession,
      shouldDropRememberedPointer,
    } = await import('@jeswr/solid-session-restore')

    if (!indexedDbAvailable())
      return null

    const pointer = new RememberedAccount(ELK_REMEMBERED_ACCOUNT_KEY)
    const remembered = pointer.read()
    // Nothing remembered ⇒ nothing to restore silently. Do NOT popup — stay logged-out.
    if (!remembered)
      return null

    const store = new IndexedDbSessionStore({ dbName: ELK_SESSION_DB_NAME })
    const clientId = clientIdDocumentUrl()

    // Capture the FULL restored session (not just its WebID) so the success branch can build
    // the DPoP-authenticated fetch from it. `decideSilentRestore`'s restoreIssuer contract is
    // `{ webId } | undefined`, so the session itself is hoisted out via this closure var.
    let restoredSession: RestoredSession | undefined

    // A reusable SILENT refresh of the restored credential: re-run the same refresh-grant
    // restore (token-endpoint fetch, NO popup/iframe) to re-mint a fresh access token + handle
    // from the persisted refresh credential when the captured token expires. Scoped to the SAME
    // issuer/store/clientId the initial restore used. Returns null on any failure so the authed
    // fetch fails closed rather than looping.
    //
    // SECURITY/CORRECTNESS (roborev HIGH): the refresh's token-endpoint request MUST ride the
    // DEFAULT (patched-global) fetch via `getDefaultSolidFetch()`, NEVER `solidFetch.value`. Once
    // a restore succeeds the plugin adopts the restored per-resource DPoP fetch as
    // `solidFetch.value`; that fetch is bound to the (now EXPIRED) access token a refresh exists
    // to replace, so routing the refresh through it would re-send the token request under the
    // expired/wrong DPoP authorization. The patched global is shared, user-agnostic, and carries
    // no restored token — the correct transport for discovery + the refresh grant. We re-resolve
    // it per call so the refresh always rides the CURRENT patched global.
    const refreshCredential: RefreshRestoredCredential = async () => {
      const fresh = await restoreSession({
        store,
        issuer: new URL(remembered.issuer ?? restoredSession?.issuer ?? ''),
        clientId,
        fetch: getDefaultSolidFetch(),
      })
      return fresh ? { accessToken: fresh.accessToken, dpopHandle: fresh.dpopHandle } : null
    }

    // The single refresh-grant restore the decision drives — a token-endpoint fetch ONLY,
    // never a popup/iframe. On success it records the restored session for the caller.
    const decision = await decideSilentRestore({
      lastActiveWebId: remembered.webId,
      remembered: [remembered],
      restoreIssuer: async (issuer: string) => {
        const session = await restoreSession({
          store,
          issuer: new URL(issuer),
          clientId,
          fetch: solidFetch.value,
        })
        restoredSession = session ?? undefined
        return session ? { webId: session.webId } : undefined
      },
    })

    if (decision.outcome === 'restored' && restoredSession) {
      // Build the DPoP-authenticated, REFRESH-CAPABLE fetch from the restored session and hand
      // BOTH the WebID and that fetch to the caller. The plugin adopts this fetch as the pod
      // fetch BEFORE mounting storage so pod requests carry the restored authorization (NO
      // popup) — and so a later token expiry triggers a silent re-mint, not a dead session.
      result = {
        webId: decision.webId,
        fetch: authedFetchFromRestoredSession(restoredSession, refreshCredential),
      }
    }
    else {
      // LOGIN outcome (or a vanished session): never auto-popup. Drop a doomed pointer per the
      // keep/drop matrix so it is not retried forever; a transient blip keeps it.
      const issuer = remembered.issuer
      const presence = issuer
        ? await import('@jeswr/solid-session-restore').then(m => m.hasPersisted(store, new URL(issuer)))
        : 'absent'
      const reason = decision.outcome === 'login' ? decision.reason : 'restore-failed'
      if (shouldDropRememberedPointer(reason, presence))
        pointer.clear()
    }
  }
  catch (err) {
    // Fail-closed: any unexpected error ⇒ logged-out, NO popup. (decideSilentRestore itself
    // never throws for the normal absent/dead-token path; this catches store/import faults.)
    console.warn('[solid] silent restore failed; staying logged-out (no popup):', err instanceof Error ? err.message : err)
    return null
  }
  return result
}

/** The static Client Identifier Document URL (the `client_id` for the public-client grant). */
function clientIdDocumentUrl(): string {
  return new URL('/clientid.jsonld', globalThis.location?.href ?? 'http://localhost/').toString()
}

/**
 * Connect a Solid pod: record the WebID, resolve the pod base container, persist the
 * WebID for silent restore. The reactive-auth manager (registered by the plugin) makes
 * `globalThis.fetch` the authed fetch, so we do not store a token here.
 *
 * SILENT-RESTORE RACE (roborev HIGH — the last race window): `resolveStorageRoot` AWAITS a network
 * fetch before the shared `solidWebId`/`solidPodBase` refs (and the persisted WebID / remembered
 * pointer) are written. A silent restore passes the OPTIONAL `isCurrent` guard (its captured restore
 * generation, re-evaluated AFTER the await) so that if an interactive `login()`/`logout()` raced
 * ahead WHILE `resolveStorageRoot` was in flight, this (now-stale) restore performs NONE of those
 * writes — it must not clobber the newer session's WebID/pod-base for the OLD user. The interactive
 * `login()` path passes no guard (it is itself the latest action), so its behaviour is unchanged.
 */
export async function connectSolid(webId: string, isCurrent?: () => boolean): Promise<void> {
  const fetchImpl = solidFetch.value
  const root = await resolveStorageRoot(webId, fetchImpl)
  // A stale silent restore (a login/logout raced during resolveStorageRoot) must NOT write any
  // shared pod state — return without touching solidWebId/solidPodBase/persistence.
  if (isCurrent && !isCurrent())
    return
  solidWebId.value = webId
  // Build the sub-path via `new URL(child, base)`, never raw string concatenation — `root`
  // is already normalised (normalizeContainerUrl), but resolving through URL rather than
  // template-literal concat means a future change to root's shape can't silently reintroduce
  // the query/fragment-smuggling class this module was hardened against.
  solidPodBase.value = new URL(ELK_POD_NAMESPACE, root).toString()
  try {
    globalThis.localStorage?.setItem(SOLID_WEBID_KEY, webId)
  }
  catch {
    // localStorage unavailable (private mode) — connection still works for the session
  }
  // Best-effort: write the credential-free remembered-account pointer (WebID→issuer) so a
  // later reload can attempt a SILENT refresh-grant restore against the right issuer. Holds
  // NO token (the DPoP-bound credential lives in IndexedDB). A failure here never breaks the
  // live connection — it just means the next load shows login instead of silently restoring.
  try {
    const issuer = await resolveOidcIssuer(webId, fetchImpl)
    // After this further await, re-check once more: a stale restore must not (re)write the
    // remembered-account pointer for the OLD user over a login/logout that raced ahead.
    if (isCurrent && !isCurrent())
      return
    const { RememberedAccount } = await import('@jeswr/solid-session-restore')
    new RememberedAccount(ELK_REMEMBERED_ACCOUNT_KEY).write(webId, issuer)
  }
  catch {
    // issuer unresolved / package unavailable — silent restore simply won't run next load
  }
}

/** Disconnect the Solid pod: clear state + persisted WebID + remembered pointer (Mastodon session untouched). */
export function disconnectSolid(): void {
  solidWebId.value = null
  solidPodBase.value = null
  // Invalidate any silent restore in flight (roborev HIGH — restore-in-flight race): a restore
  // that resolves AFTER this logout must be DISCARDED, never adopt the logged-out user's restored
  // DPoP fetch / re-mount their pod.
  bumpRestoreGeneration()
  // SECURITY: drop any restored per-session DPoP fetch so a later login / account switch cannot
  // reuse the logged-out user's token (cross-user token reuse). After disconnect the pod fetch is
  // the default (patched global) again.
  resetSolidFetchToDefault()
  try {
    globalThis.localStorage?.removeItem(SOLID_WEBID_KEY)
  }
  catch {
    // ignore
  }
  // Clear the silent-restore pointer SYNCHRONOUSLY so the next load does not attempt a restore
  // for a session the user explicitly disconnected. The clear MUST complete before
  // disconnectSolid() returns: an async clear (`void import(...).then(...)`) loses a
  // logout→immediate-reload race — the reload's silent restore can read a not-yet-cleared
  // pointer and resurrect a disconnected session (the roborev LOW this fixes). The pointer is
  // a plain localStorage entry under a known key (`RememberedAccount` writes/reads exactly
  // this key), so we remove it directly and synchronously here.
  try {
    globalThis.localStorage?.removeItem(ELK_REMEMBERED_ACCOUNT_KEY)
  }
  catch {
    // localStorage unavailable (private mode) — nothing persisted, nothing to clear
  }
}

/** The last-connected WebID, if any, for a silent-restore attempt on load. */
export function persistedSolidWebId(): string | null {
  try {
    return globalThis.localStorage?.getItem(SOLID_WEBID_KEY) ?? null
  }
  catch {
    return null
  }
}
