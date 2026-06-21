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
import { mirrorStatus } from './mirror'
import { solidFetch, solidPodBase, solidWebId } from './session'
import { hydrateFromPod, pushKeyToPod } from './storage'

/** The live pod KV storage instance, set by the plugin on connect, cleared on disconnect. */
let podStorage: Storage | null = null

/** Per-session memo: containers whose owner-only ACL has already been ensured this session. */
const aclEnsured = new Set<string>()

/** Debounce timers per mirrored key, so rapid settings edits coalesce into one pod write. */
const pushTimers = new Map<MirroredKey, ReturnType<typeof setTimeout>>()

/** Install the live pod storage instance + hydrate mirrored keys from the pod. */
export async function setPodStorage(storage: Storage): Promise<void> {
  podStorage = storage
  aclEnsured.clear()
  try {
    await hydrateFromPod(storage)
  }
  catch {
    // hydrate best-effort; a fresh device with no pod copy is fine
  }
}

/** Tear down the pod storage instance (on Solid disconnect / logout). */
export function clearPodStorage(): void {
  podStorage = null
  aclEnsured.clear()
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
