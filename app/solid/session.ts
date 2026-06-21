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
}

/** Disconnect the Solid pod: clear state + persisted WebID (Mastodon session untouched). */
export function disconnectSolid(): void {
  solidWebId.value = null
  solidPodBase.value = null
  try {
    globalThis.localStorage?.removeItem(SOLID_WEBID_KEY)
  }
  catch {
    // ignore
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
