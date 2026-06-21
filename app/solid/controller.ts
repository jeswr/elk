// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The Solid integration controller — the single, app-wide seam the rest of Elk calls.
 *
 * Holds the live pod-backed unstorage instance (once a pod is connected) and exposes the
 * two integration points Elk's existing code touches:
 *   - {@link mirrorOwnStatus} — fire-and-forget mirror of the user's own status to the pod
 *     (called from the post/bookmark paths; a single non-blocking line at the call site).
 *   - {@link schedulePodSync} — debounced push of a mirrored localStorage key to the pod
 *     (called when settings/drafts change).
 *
 * Everything here is a NO-OP when no pod is connected, so the call sites are safe to add
 * unconditionally: Elk works exactly as before for users who never connect a Solid pod.
 * Errors are swallowed at this boundary (logged, never thrown) — mirroring is an additive
 * convenience and must NEVER break posting or settings.
 */

import type { Storage } from 'unstorage'
import type { MirrorableStatus } from './mirror'
import type { MirroredKey } from './storage'
import { writeOwnerOnlyAcl } from './acl'
import { mirrorStatus } from './mirror'
import { solidFetch, solidPodBase, solidWebId } from './session'
import { hydrateFromPod, MIRRORED_KEYS, pushKeyToPod } from './storage'

/** The live pod KV storage instance, set by the plugin on connect, cleared on disconnect. */
let podStorage: Storage | null = null

/** Per-session memo: containers whose owner-only ACL has already been ensured this session. */
const aclEnsured = new Set<string>()

/**
 * Per-session memo of the in-flight (or settled) owner-only-ACL write for a KV container,
 * so the ACL is established AT MOST ONCE per container per session (a single PUT, even
 * under a burst of concurrent first writes) AND so a fail-closed failure is re-attempted
 * on the NEXT call rather than cached as "done". Keyed by the container URL.
 */
const kvAclPromises = new Map<string, Promise<void>>()

/** Debounce timers per mirrored key, so rapid settings edits coalesce into one pod write. */
const pushTimers = new Map<MirroredKey, ReturnType<typeof setTimeout>>()

/** The `storage`-event listener wired by {@link watchMirroredKeys} (for teardown). */
let mirroredKeyListener: ((ev: StorageEvent) => void) | null = null

/**
 * Establish the owner-only WAC ACL on a KV container BEFORE any KV resource is created —
 * the same fail-closed owner-only writer (`writeOwnerOnlyAcl` + `buildOwnerOnlyAclTurtle`)
 * the timeline mirror uses. Idempotent + memoised per container per session: the PUT runs
 * AT MOST ONCE even under a burst of concurrent first writes (callers `await` the one
 * shared promise). FAIL-CLOSED: on a non-2xx / network failure the rejection propagates AND
 * the memo entry is dropped, so private KV data is NEVER written into a container whose
 * owner-only ACL could not be established, and the next call re-attempts the ACL.
 *
 * @param kvContainer the KV container URL (MUST end with `/`)
 */
export function ensureKvAcl(kvContainer: string): Promise<void> {
  const existing = kvAclPromises.get(kvContainer)
  if (existing)
    return existing
  const webId = solidWebId.value
  if (!webId) {
    // No connected WebID ⇒ cannot establish an owner-only ACL ⇒ fail closed (never write).
    return Promise.reject(new Error('ensureKvAcl: no connected WebID — cannot establish owner-only ACL'))
  }
  const promise = writeOwnerOnlyAcl(solidFetch.value, kvContainer, webId)
    .then(() => {
      aclEnsured.add(kvContainer)
    })
    .catch((err) => {
      // Fail-closed: drop the memo so the next attempt re-tries the ACL, and re-throw so
      // the caller does NOT proceed to write KV data into an unprotected container.
      kvAclPromises.delete(kvContainer)
      throw err
    })
  kvAclPromises.set(kvContainer, promise)
  return promise
}

/** Whether the owner-only ACL has been established for `kvContainer` this session. */
export function kvAclEnsured(kvContainer: string): boolean {
  return aclEnsured.has(kvContainer)
}

/**
 * Install the live pod storage instance + hydrate mirrored keys from the pod.
 *
 * NOTE: this does NOT reset the per-session ACL memo (`aclEnsured` / `kvAclPromises`) — the
 * plugin establishes the kv/ owner-only ACL via {@link ensureKvAcl} BEFORE calling this, so
 * clearing the memo here would erase that just-established flag (and could green-light a
 * redundant ACL re-PUT). The memo's lifecycle boundary is connect/disconnect: it is reset by
 * {@link clearPodStorage} on disconnect (a different WebID ⇒ a different container URL, so a
 * carried-over memo can never apply a stale ACL decision to the wrong pod).
 *
 * SILENT-RESTORE RACE (roborev HIGH — the DEEPEST race window): both the pod-storage singleton
 * install (`podStorage = storage`) AND the per-mirrored-key `localStorage` writes inside
 * {@link hydrateFromPod} are shared/persistent state mutations that run during/after `await`s. A
 * login()/logout() racing the in-flight silent restore must not let a now-stale restore install
 * the OLD user's storage singleton or mirror their data over the newer session. We therefore:
 *   1. HYDRATE FIRST, with the `isCurrent` guard threaded INTO the hydrate loop so it checks
 *      BEFORE each awaited pod read AND BEFORE each `localStorage` write, aborting the moment the
 *      restore goes stale (no further mirrored-key write happens).
 *   2. Install the singleton (`podStorage = storage`) ONLY if STILL current after the hydrate —
 *      the unavoidable side-effect is done as LATE as possible, immediately preceded by an
 *      `isCurrent()` check, minimizing the stale-write window. If the restore went stale we leave
 *      `podStorage` untouched (we never installed it) and the caller does NOT start the watcher.
 * The interactive login() path passes no guard (it is itself the latest action) so it always
 * hydrates + installs unchanged.
 */
export async function setPodStorage(storage: Storage, isCurrent?: () => boolean): Promise<void> {
  // Hydrate FIRST (gated), reading into localStorage only while the restore is still current. We
  // do NOT install the singleton yet so a stale restore that aborts mid-hydrate leaves no storage
  // installed (nothing to tear down).
  try {
    await hydrateFromPod(storage, isCurrent)
  }
  catch {
    // hydrate best-effort; a fresh device with no pod copy is fine
  }
  // A login()/logout() may have raced during the hydrate — install the singleton ONLY if still
  // current. A stale restore installs NOTHING (the newer session's podStorage, if any, stands).
  if (isCurrent && !isCurrent())
    return
  podStorage = storage
}

/** Tear down the pod storage instance (on Solid disconnect / logout). */
export function clearPodStorage(): void {
  podStorage = null
  aclEnsured.clear()
  kvAclPromises.clear()
  unwatchMirroredKeys()
  for (const t of pushTimers.values())
    clearTimeout(t)
  pushTimers.clear()
}

/** True when a pod is connected and storage is live. */
export function podConnected(): boolean {
  return podStorage !== null && solidWebId.value !== null && solidPodBase.value !== null
}

/**
 * Mirror the user's OWN status to their pod timeline — fire-and-forget + non-blocking. A
 * no-op when no pod is connected. The owner-only ACL is ensured once per session per
 * container (the mirror writes it first on the first call). Never throws to the caller.
 */
export function mirrorOwnStatus(status: MirrorableStatus): void {
  if (!podConnected())
    return
  const webId = solidWebId.value
  const podBase = solidPodBase.value
  if (!webId || !podBase)
    return

  // Ensure the ACL on the FIRST mirror of the session; subsequent calls skip it (memo).
  const ensureAcl = !aclEnsured.has(podBase)
  void mirrorStatus(status, { fetch: solidFetch.value, webId, podBase, ensureAcl })
    .then((res) => {
      if (res.written)
        aclEnsured.add(podBase)
    })
    .catch((err) => {
      // Mirroring is additive — log, never surface to the posting flow.
      console.warn('[solid] mirror failed (non-fatal):', err instanceof Error ? err.message : err)
    })
}

/**
 * Schedule a debounced push of a mirrored localStorage key to the pod. Called when Elk
 * writes settings/drafts. A no-op when no pod is connected; coalesces bursts into one write.
 */
export function schedulePodSync(key: MirroredKey, delayMs = 1500): void {
  if (!podConnected() || !podStorage)
    return
  const existing = pushTimers.get(key)
  if (existing)
    clearTimeout(existing)
  pushTimers.set(key, setTimeout(() => {
    pushTimers.delete(key)
    const storage = podStorage
    if (!storage)
      return
    void pushKeyToPod(storage, key).catch((err) => {
      console.warn('[solid] pod sync failed (non-fatal):', err instanceof Error ? err.message : err)
    })
  }, delayMs))
}

/** True when `key` is one of the mirrored Elk localStorage keys. */
function isMirroredKey(key: string | null): key is MirroredKey {
  return key != null && (MIRRORED_KEYS as readonly string[]).includes(key)
}

/**
 * Start watching the mirrored localStorage keys so that ONGOING edits — not just the
 * connect-time hydrate — are pushed to the pod. Elk persists `elk-settings`/`elk-drafts`/
 * `elk-custom-emojis` through VueUse `useLocalStorage`, which (a) writes synchronously to
 * `localStorage` and (b) dispatches a `StorageEvent('storage', { key, … })` on `window` in
 * the SAME tab (the native `storage` event only fires in OTHER tabs; VueUse re-dispatches
 * one for the writing tab). We listen for that event and, on a write to a mirrored key,
 * call the debounced {@link schedulePodSync} — so a settings/draft change made anywhere in
 * the app is durably persisted to the pod, fixing the "only the initial hydrate persists"
 * gap. Cross-tab native `storage` events for the same keys are handled too (a write in
 * another tab is pushed from this one — harmless, idempotent, last-writer-wins).
 *
 * Idempotent (a second call replaces the prior listener); a no-op when there is no `window`
 * (SSR / node tests without a DOM). Torn down by {@link clearPodStorage} on disconnect.
 */
export function watchMirroredKeys(): void {
  if (typeof window === 'undefined')
    return
  unwatchMirroredKeys()
  const listener = (ev: StorageEvent): void => {
    // Only react to mirrored keys; ignore Elk's many other localStorage keys.
    if (isMirroredKey(ev.key))
      schedulePodSync(ev.key)
  }
  window.addEventListener('storage', listener, { passive: true })
  mirroredKeyListener = listener
}

/** Stop watching the mirrored localStorage keys (on disconnect / re-wire). */
export function unwatchMirroredKeys(): void {
  if (mirroredKeyListener && typeof window !== 'undefined')
    window.removeEventListener('storage', mirroredKeyListener)
  mirroredKeyListener = null
}
