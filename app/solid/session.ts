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
 */
export const solidFetch = shallowRef<typeof globalThis.fetch>(
  globalThis.fetch?.bind(globalThis),
)

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
 * Resolve the pod storage root for a WebID by dereferencing its profile and reading
 * `pim:storage` (`http://www.w3.org/ns/pim/space#storage`). Falls back to the WebID's
 * origin root when the profile advertises no storage. Returns a URL ending in `/`.
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
          const root = quad.object.value
          return root.endsWith('/') ? root : `${root}/`
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

/**
 * Build a DPoP-AUTHENTICATED `fetch` from a restored session. The auth-attaching mechanism
 * is `oauth4webapi`'s `protectedResourceRequest` driven by the session's live `dpopHandle`
 * (created INSIDE `@jeswr/solid-session-restore` from the persisted, non-extractable key) and
 * its freshly-minted `accessToken`. We DELEGATE the DPoP proof signing + the
 * `Authorization: DPoP …` header + the server-nonce handshake to oauth4webapi (the same
 * vetted library that minted the handle) — NEVER hand-rolling a proof.
 *
 * Resource servers may answer the first DPoP request with a `use_dpop_nonce` challenge; the
 * handle captures the server nonce from that error, so we retry ONCE with the nonce now
 * primed (RFC 9449 §8). Any other failure propagates to the caller as a normal fetch error.
 *
 * The returned function matches the Fetch API surface the unstorage-solid driver / mirror
 * call (`fetch(input, init)`), adapting it to `protectedResourceRequest`'s
 * `(accessToken, method, url, headers, body, opts)` shape.
 */
export function authedFetchFromRestoredSession(
  session: Pick<RestoredSession, 'accessToken' | 'dpopHandle'>,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Normalise the Fetch API call into method + URL + headers + body. A `Request` object
    // carries its own method/headers, overridden by an explicit `init`.
    const req = input instanceof Request ? input : new Request(input, init)
    const method = init?.method ?? req.method
    const url = new URL(req.url)
    const headers = new Headers(init?.headers ?? req.headers)
    // protectedResourceRequest sets Authorization + DPoP itself; drop any stale ones.
    headers.delete('authorization')
    headers.delete('dpop')
    // Read the body once (GET/HEAD have none). Use the init body verbatim when given so we
    // do not consume a Request stream twice.
    let body: ArrayBuffer | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const ab = init && 'body' in init
        ? await new Request('http://x/', { method: 'POST', body: init.body }).arrayBuffer()
        : await req.clone().arrayBuffer()
      body = ab.byteLength > 0 ? ab : undefined
    }

    const oauth = await import('oauth4webapi')
    const send = (): Promise<Response> =>
      oauth.protectedResourceRequest(
        session.accessToken,
        method,
        url,
        headers,
        body,
        { DPoP: session.dpopHandle, signal: init?.signal ?? req.signal ?? undefined },
      )
    try {
      return await send()
    }
    catch (err) {
      // One retry once the handle has captured the server's DPoP nonce (RFC 9449 §8).
      if (oauth.isDPoPNonceError(err))
        return await send()
      throw err
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
      // Build the DPoP-authenticated fetch from the restored session and hand BOTH the WebID
      // and that fetch to the caller. The plugin adopts this fetch as the pod fetch BEFORE
      // mounting storage so pod requests carry the restored authorization (NO popup).
      result = {
        webId: decision.webId,
        fetch: authedFetchFromRestoredSession(restoredSession),
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
 */
export async function connectSolid(webId: string): Promise<void> {
  const fetchImpl = solidFetch.value
  const root = await resolveStorageRoot(webId, fetchImpl)
  solidWebId.value = webId
  solidPodBase.value = `${root}${ELK_POD_NAMESPACE}`
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
