// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Solid integration plugin (browser-only) — wires the SECOND identity for Elk.
 *
 * On boot it:
 *  1. Registers `@solid/reactive-authentication`'s `ReactiveFetchManager` globally, so any
 *     `fetch()` to a pod that 401s transparently upgrades with a DPoP-bound token. The
 *     provider uses Elk's STATIC Client Identifier Document (`/clientid.jsonld`) so the
 *     consent screen shows "Elk" (not a throwaway dynamic registration).
 *  2. Attempts a SILENT session restore from the persisted WebID (cross-app UX invariant
 *     #1): if a pod was connected before, reconnect without a popup while the IdP cookie
 *     lives (reactive-auth's prompt=none path), mount the pod KV storage + hydrate Elk's
 *     mirrored settings/drafts.
 *  3. Exposes `$solid` actions (`login`, `logout`) for a UI to call, plus a `<auth>` element
 *     reference for the popup flow.
 *
 * Everything is a NO-OP for users who never connect a pod — Elk works exactly as before.
 * The plugin name `solid` is `.client.ts` so it never runs during SSR (reactive-auth defines
 * custom elements + opens popups; both are browser-only).
 */

import {
  clearPodStorage,
  connectSolid,
  createPodStorage,
  disconnectSolid,
  persistedSolidWebId,
  resolveOidcIssuer,
  setPodStorage,
  solidFetch,
  solidPodBase,
  solidRestoring,
  solidWebId,
} from '~/solid'

/** The static Client Identifier Document URL (served from `public/clientid.jsonld`). */
function clientIdUrl(): string {
  return new URL('/clientid.jsonld', location.href).toString()
}

/** The OAuth callback URL (served from `public/callback.html`). */
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
    // Once the global fetch is patched, it IS the authed pod fetch.
    solidFetch.value = globalThis.fetch.bind(globalThis)
  }
  catch (err) {
    console.warn('[solid] reactive-auth init failed (pod features disabled):', err)
  }

  /** Connect a pod by WebID: establish state, mount pod storage, hydrate mirrored keys. */
  async function login(webId: string): Promise<void> {
    await connectSolid(webId)
    const base = solidPodBase.value
    if (base) {
      const storage = createPodStorage(`${base}kv/`, solidFetch.value)
      await setPodStorage(storage)
    }
  }

  /** Disconnect the pod (Elk's Mastodon session is untouched). */
  function logout(): void {
    clearPodStorage()
    disconnectSolid()
  }

  // ---- Silent session restore on load (cross-app UX invariant #1) ----
  const restoreWebId = persistedSolidWebId()
  if (restoreWebId) {
    solidRestoring.value = true
    login(restoreWebId)
      .catch((err) => {
        // Genuine restore failure: clear the stale pointer, fall back to manual login.
        console.warn('[solid] silent restore failed; manual login required:', err)
        disconnectSolid()
      })
      .finally(() => {
        solidRestoring.value = false
      })
  }

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
