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
 * Attempt a SILENT Solid session restore on load — refresh-grant only, NEVER a popup or
 * redirect (cross-app UX invariant #1). Reads the credential-free remembered-account
 * pointer (`@jeswr/solid-session-restore`) to find the last-active WebID + its issuer, then
 * redeems the persisted DPoP-bound refresh token via `restoreSession` (a token-endpoint
 * `fetch`, no window/iframe). The restore decision (`decideSilentRestore`) re-checks the
 * restored WebID equals the remembered one (WebID-scoped isolation, fail-closed).
 *
 * Returns the restored WebID on success (the caller then establishes pod state), or `null`
 * when there is nothing to restore / the credential is dead / the restore failed. CRUCIALLY
 * it NEVER opens an interactive login — on failure the user is simply left logged-out and an
 * interactive login is deferred to an explicit user action (a login button). Doomed/stale
 * pointers are dropped per the package's keep/drop matrix so they are not retried forever.
 *
 * NOTE: a silent restore only succeeds when a DPoP-bound refresh-token credential was
 * persisted at login time (IndexedDB, `extractable:false` key). Until the login path
 * persists one, this resolves to `null` (→ logged-out, no popup) — which is exactly the
 * fail-closed, no-popup-on-restore behaviour the invariant requires.
 */
export async function silentRestore(): Promise<string | null> {
  // Browser-only: IndexedDB + localStorage are required; bail (no popup) otherwise.
  if (typeof window === 'undefined')
    return null
  let restoredWebId: string | null = null
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

    // The single refresh-grant restore the decision drives — a token-endpoint fetch ONLY,
    // never a popup/iframe. On success it records the restored WebID for the caller.
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
        return session ? { webId: session.webId } : undefined
      },
    })

    if (decision.outcome === 'restored') {
      restoredWebId = decision.webId
    }
    else {
      // LOGIN outcome: never auto-popup. Drop a doomed pointer per the keep/drop matrix so
      // it is not retried forever; a transient blip keeps it (the credential may survive).
      const issuer = remembered.issuer
      const presence = issuer
        ? await import('@jeswr/solid-session-restore').then(m => m.hasPersisted(store, new URL(issuer)))
        : 'absent'
      if (shouldDropRememberedPointer(decision.reason, presence))
        pointer.clear()
    }
  }
  catch (err) {
    // Fail-closed: any unexpected error ⇒ logged-out, NO popup. (decideSilentRestore itself
    // never throws for the normal absent/dead-token path; this catches store/import faults.)
    console.warn('[solid] silent restore failed; staying logged-out (no popup):', err instanceof Error ? err.message : err)
    return null
  }
  return restoredWebId
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
  // Clear the silent-restore pointer so the next load does not attempt a restore for a
  // session the user explicitly disconnected. (The IndexedDB credential is cleared by the
  // restore helper on a definitive invalid_grant; an explicit logout that minted a
  // credential would forget it here too — reactive-auth's MVP flow persists none today.)
  try {
    void import('@jeswr/solid-session-restore').then(({ RememberedAccount }) => {
      new RememberedAccount(ELK_REMEMBERED_ACCOUNT_KEY).clear()
    })
  }
  catch {
    // ignore — a stale pointer is harmless (silent restore fails closed)
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
