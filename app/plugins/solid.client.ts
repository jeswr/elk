// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Solid integration plugin (browser-only) — wires the SECOND identity for Elk.
 *
 * On boot it:
 *  1. Registers `@solid/reactive-authentication`'s `ReactiveFetchManager` globally, so any
 *     `fetch()` to a pod that 401s transparently upgrades with a DPoP-bound token. The
 *     provider uses Elk's ORIGIN-AWARE Client Identifier Document (`/clientid.jsonld`,
 *     served per-origin by the server route) so the consent screen shows "Elk" (not a
 *     throwaway dynamic registration) and the `client_id` always matches the served URL.
 *  2. Attempts a SILENT-ONLY session restore (cross-app UX invariant #1): redeem the
 *     persisted DPoP-bound refresh token via a token-endpoint fetch (`@jeswr/solid-session-restore`)
 *     — NO popup, NO redirect, NO iframe. On success it mounts the pod KV storage + hydrates
 *     Elk's mirrored settings/drafts; on ANY failure it leaves the user logged-out and defers
 *     interactive login to an explicit user action (it NEVER auto-opens the login popup).
 *  3. Exposes `$solid` actions (`login`, `logout`) for a UI to call; interactive login uses
 *     the popup `getCode` only on an EXPLICIT user `login()` call, never on restore.
 *
 * Everything is a NO-OP for users who never connect a pod — Elk works exactly as before.
 * The plugin name `solid` is `.client.ts` so it never runs during SSR (reactive-auth defines
 * custom elements + opens popups; both are browser-only).
 */

import {
  beginRestoreGeneration,
  bumpRestoreGeneration,
  clearPodStorage,
  connectSolid,
  createPodStorage,
  disconnectSolid,
  ensureKvAcl,
  isRestoreGenerationCurrent,
  resetSolidFetchToDefault,
  resolveOidcIssuer,
  setDefaultSolidFetch,
  setPodStorage,
  silentRestore,
  solidFetch,
  solidPodBase,
  solidRestoring,
  solidWebId,
  watchMirroredKeys,
} from '~/solid'

/**
 * The Client Identifier Document URL — computed from the CURRENT origin so it matches the
 * origin-aware doc served by the `/clientid.jsonld` server route byte-for-byte (Solid-OIDC).
 */
function clientIdUrl(): string {
  return new URL('/clientid.jsonld', location.href).toString()
}

/** The OAuth callback URL (served from `public/callback.html`), origin-relative. */
function callbackUrl(): string {
  return new URL('/callback.html', location.href).toString()
}

export default defineNuxtPlugin(async () => {
  // Lazy-load reactive-auth so its top-level customElements.define never runs during SSR
  // and the heavy auth bundle is only pulled when the app actually boots in the browser.
  const { ReactiveFetchManager, DPoPTokenProvider } = await import('@solid/reactive-authentication')

  // A headless code-getter: open the IdP authorize URL in a popup and resolve with the
  // callback URL the popup posts back. (A richer WebID-first dialog can replace this; the
  // MVP uses a minimal popup so login works without new UI.)
  const getCode = (authorizationUri: URL, signal: AbortSignal): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const popup = window.open(authorizationUri.toString(), 'solid-login', 'width=480,height=640')
      if (!popup) {
        reject(new Error('Solid login popup was blocked'))
        return
      }
      function cleanup() {
        window.removeEventListener('message', onMessage)
        signal.removeEventListener('abort', onAbort)
      }
      function onMessage(ev: MessageEvent) {
        if (ev.origin !== location.origin || typeof ev.data !== 'string')
          return
        cleanup()
        resolve(ev.data)
      }
      function onAbort() {
        cleanup()
        try {
          popup?.close()
        }
        catch {
          // popup already closed / cross-origin — ignore
        }
        reject(new Error('Solid login cancelled'))
      }
      window.addEventListener('message', onMessage)
      signal.addEventListener('abort', onAbort)
    })
  }

  // The published DPoPTokenProvider (0.1.3) is `(callbackUri, getCodeCallback,
  // getIssuerCallback)`. We resolve the issuer from the CONNECTED WebID's profile
  // (`solid:oidcIssuer`) — the WebID-first model — rather than guessing from the host.
  // The static client_id is published in /clientid.jsonld so the OP fetches our metadata.
  const getIssuer = async (_request: Request): Promise<URL> => {
    const webId = solidWebId.value
    if (!webId)
      throw new Error('Solid login: no WebID connected — call $solid.login(webId) first')
    const issuer = await resolveOidcIssuer(webId, solidFetch.value)
    return new URL(issuer)
  }

  let manager: { registerGlobally: () => void } | undefined
  try {
    const provider = new DPoPTokenProvider(callbackUrl(), getCode, getIssuer)
    manager = new ReactiveFetchManager([provider])
    manager.registerGlobally()
    // Once the global fetch is patched, it IS the authed pod fetch — and the DEFAULT pod fetch
    // (shared across users; it upgrades a pod 401 for the CURRENTLY interactive identity). Record
    // it as the default so logout / a new interactive login can RESET back to it, dropping any
    // restored per-session fetch (the cross-user-token-reuse finding).
    const patched = globalThis.fetch.bind(globalThis)
    setDefaultSolidFetch(patched)
    solidFetch.value = patched
  }
  catch (err) {
    console.warn('[solid] reactive-auth init failed (pod features disabled):', err)
  }

  /**
   * Establish pod state + mount KV storage for a CONNECTED WebID (shared by interactive
   * login and silent restore). FAIL-CLOSED: the owner-only WAC ACL on the `${base}kv/`
   * container is written BEFORE the KV storage is mounted / any KV value is written — if the
   * ACL cannot be established, `ensureKvAcl` rejects and we do NOT mount the storage, so
   * private client state (settings/drafts/emojis) can never land in a container without an
   * owner-only ACL. Also starts watching the mirrored keys so ongoing edits push to the pod.
   */
  async function mountPod(isCurrent?: () => boolean): Promise<void> {
    const base = solidPodBase.value
    if (!base)
      return
    const kvContainer = `${base}kv/`
    // Owner-only ACL FIRST — throws on failure (fail-closed; never mount on an unprotected container).
    await ensureKvAcl(kvContainer)
    // SILENT-RESTORE RACE (roborev HIGH): `ensureKvAcl` awaits, so a login()/logout() can race ahead
    // here. A now-stale restore must NOT install the pod storage singleton / start the mirror watcher
    // for the OLD user — re-check the captured generation and abort silently if it changed, leaving
    // the newer session's pod state intact. The interactive login() passes no guard (it is the
    // latest action) so its mount is unchanged.
    if (isCurrent && !isCurrent())
      return
    const storage = createPodStorage(kvContainer, solidFetch.value)
    // Thread the guard INTO setPodStorage so EVERY post-await shared/persistent write it performs —
    // each mirrored-key `localStorage` write inside the hydrate loop AND the pod-storage singleton
    // install — is itself generation-gated. A stale restore mirrors NO data and installs NO singleton
    // (setPodStorage refuses both the moment the generation changes).
    await setPodStorage(storage, isCurrent)
    // `setPodStorage` awaits a hydrate; re-check ONE more time before starting the mirror watcher so
    // a login()/logout() that raced during the hydrate does not leave a watcher running for a stale
    // (old/logged-out) session. setPodStorage already refused to install the singleton on a stale
    // restore (so there is nothing installed to tear down here); we simply do not start the watcher.
    if (isCurrent && !isCurrent())
      return
    // Persist ongoing settings/drafts/emoji edits to the pod (not just the initial hydrate).
    watchMirroredKeys()
  }

  /** Connect a pod by WebID (interactive login path): establish state, then mount the pod. */
  async function login(webId: string): Promise<void> {
    // Invalidate any silent restore in flight (roborev HIGH — restore-in-flight race): a restore
    // that resolves AFTER this interactive login must be DISCARDED, never clobber THIS login's
    // fetch / pod with a stale restored user's DPoP fetch.
    bumpRestoreGeneration()
    // Drop any restored per-session fetch BEFORE this (possibly different) user's profile is
    // resolved / pod is mounted — an interactive login / account switch must NOT carry the prior
    // restored user's DPoP token. The interactive identity uses the reactive-auth patched global
    // fetch (which upgrades the 401 for THIS login).
    resetSolidFetchToDefault()
    await connectSolid(webId)
    await mountPod()
  }

  /** Disconnect the pod (Elk's Mastodon session is untouched). */
  function logout(): void {
    clearPodStorage()
    // disconnectSolid() itself resets the pod fetch to the default (dropping the restored
    // per-session DPoP fetch) — see its security note — so a later login can't reuse the token.
    disconnectSolid()
  }

  // ---- Silent session restore on load (cross-app UX invariant #1) ----
  // SILENT ONLY: redeem the persisted DPoP-bound refresh token via a token-endpoint fetch
  // (no popup, no redirect, no iframe). On ANY restore failure we leave the user logged-out
  // and DEFER interactive login to an explicit user action — we never auto-open the popup
  // (calling the interactive `login()` here is exactly the bug this fixes). `silentRestore`
  // returns the restored WebID + the DPoP-authenticated fetch on success, else null
  // (logged-out, no popup).
  solidRestoring.value = true
  // Capture the restore generation BEFORE the (async) restore begins. If an interactive login()
  // or a logout()/disconnectSolid() happens WHILE the restore is in flight, it bumps the
  // generation — and the late-resolving restore below is then STALE and MUST be discarded, so a
  // prior restored user's DPoP fetch can never clobber the interactive login/logout (roborev
  // HIGH — restore-in-flight cross-user race).
  const restoreGen = beginRestoreGeneration()
  silentRestore()
    .then(async (restored) => {
      if (!restored)
        return // nothing to restore / failed → stay logged-out, NO popup
      // GUARD (pre-adoption): a login()/logout() raced ahead of this restore → DISCARD the stale
      // restored result. Do NOT adopt its fetch, do NOT connect/mount — the interactive action wins.
      if (!isRestoreGenerationCurrent(restoreGen))
        return
      // A silent restore succeeded AND no login/logout has raced it (so far). ADOPT the restored
      // DPoP-AUTHENTICATED fetch as the pod fetch BEFORE establishing pod state / mounting storage,
      // so every subsequent pod request carries the restored DPoP authorization with NO interactive
      // popup (the cross-app invariant + the roborev HIGH). `connectSolid` + `mountPod` read
      // `solidFetch.value` (resolveStorageRoot, createPodStorage, ensureKvAcl), so it MUST be the
      // authed fetch by the time they run — not the bare/unauthenticated global fetch.
      solidFetch.value = restored.fetch

      // GENERATION-GATE EVERY POST-AWAIT SHARED-STATE WRITE (roborev HIGH — the last race window).
      // The pre-adoption check above is insufficient on its own: `connectSolid()` and `mountPod()`
      // each `await` (and write shared state — solidWebId/solidPodBase/the persisted pointer, and the
      // pod-storage singleton — AFTER their OWN internal awaits too), so a login()/logout() can fire
      // anywhere in this window and still be clobbered by this stale restore (writing the OLD user's
      // WebID/pod-base/pod storage). We therefore (a) pass the captured generation INTO connectSolid
      // + mountPod so each of their post-internal-await writes is itself gated, AND (b) re-check
      // between them here so a stale restore stops advancing the moment it loses the race. CRUCIALLY
      // we do NOT disconnect on a stale restore — that would tear down the CURRENT (newer) session.
      const isCurrent = () => isRestoreGenerationCurrent(restoreGen)
      await connectSolid(restored.webId, isCurrent)
      if (!isCurrent())
        return // a login()/logout() raced during connectSolid() → leave the newer state intact
      await mountPod(isCurrent)
    })
    .catch((err) => {
      // A FAILURE in the restore connect/mount flow. CRITICAL (roborev HIGH): only a CURRENT
      // restore's genuine failure may clean up. If a login()/logout() raced ahead (the generation
      // changed), this restore is STALE — its failure is irrelevant and `disconnectSolid()` would
      // bump the generation + TEAR DOWN the NOW-CURRENT session (the newer login's fetch/WebID/pod).
      // So on a stale restore we return SILENTLY, never touching the current session. Only when the
      // restore is STILL CURRENT do we fail-closed and tear down our own partial state.
      if (!isRestoreGenerationCurrent(restoreGen)) {
        // Stale restore failed — the newer login/logout already owns the session; do NOT disconnect.
        return
      }
      console.warn('[solid] silent restore could not complete; staying logged-out:', err)
      disconnectSolid()
    })
    .finally(() => {
      solidRestoring.value = false
    })

  return {
    provide: {
      solid: {
        login,
        logout,
        clientIdUrl,
      },
    },
  }
})
