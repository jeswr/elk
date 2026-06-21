// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Pod-backed unstorage for Elk — persist settings/drafts to the user's Solid pod.
 *
 * THE SHOWCASE: Elk's client state (settings, drafts, custom emojis) is held in the
 * browser via VueUse `useLocalStorage` (keyed per-user). This module mounts the
 * `@jeswr/unstorage-solid` KV-over-LDP driver — which IS an unstorage driver — at a
 * pod-backed namespace, fed the Solid session's authed `fetch`. We then MIRROR the
 * existing localStorage keys into that unstorage instance, so the same settings/drafts
 * persist to the pod with NO rewrites of Elk's `useLocalStorage` call sites (that
 * minimal-call-site property is the whole point of the unstorage-solid showcase).
 *
 * Why a mirror rather than swapping Elk's storage wholesale: Elk reads its state
 * synchronously from localStorage on boot (instant paint — cross-app UX invariant #3);
 * a pod is async + remote. The mirror keeps the synchronous local read AND adds durable
 * cross-device pod persistence behind it (stale-while-revalidate). On connect we PULL
 * the pod copy (if any) into localStorage, then PUSH local changes to the pod as they
 * occur. The pod is the cross-device source of truth; localStorage is the instant cache.
 *
 * Browser-only. Mounted from the Solid client plugin once a pod session connects.
 */

import type { Storage } from 'unstorage'
import solidDriver from '@jeswr/unstorage-solid'
import { createStorage } from 'unstorage'

/**
 * The Elk localStorage keys mirrored to the pod. Deliberately a SHORT list — the
 * user's own settings + drafts + emojis, which are portable and worth carrying across
 * devices. Volatile / device-local caches (servers list, nodes, notification dedupe)
 * are intentionally NOT mirrored.
 */
export const MIRRORED_KEYS = [
  'elk-settings',
  'elk-drafts',
  'elk-custom-emojis',
] as const

export type MirroredKey = (typeof MIRRORED_KEYS)[number]

/** Map an Elk localStorage key to its unstorage key (no `:`/path separators clash). */
function podKey(localStorageKey: string): string {
  // unstorage uses `:` as its path separator; Elk keys use `-`, so they map 1:1 with no
  // collision. We keep the full key as the leaf so the pod resource name is recognisable.
  return localStorageKey
}

/**
 * Create the pod-backed unstorage instance for `base`, using the injected authed
 * `fetch`. `base` is the pod container Elk owns (e.g.
 * `https://alice.pod/elk/kv/`) — it MUST end with `/` and be owner-private (the ACL is
 * written by the mirror controller before any value lands).
 */
export function createPodStorage(base: string, fetchImpl: typeof globalThis.fetch): Storage {
  if (!base.endsWith('/'))
    throw new Error(`createPodStorage: base must end with "/" (got ${base})`)
  return createStorage({
    driver: solidDriver({ base, fetch: fetchImpl }),
  })
}

/**
 * Read a mirrored value from localStorage as a parsed JSON object (or `null`). VueUse
 * stores these keys as JSON strings; we round-trip via JSON so the pod copy is the same
 * shape Elk reads back locally.
 */
export function readLocal(key: MirroredKey): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (raw == null)
      return null
    return JSON.parse(raw)
  }
  catch {
    return null
  }
}

/** Write a value into localStorage as JSON (the shape VueUse `useLocalStorage` reads). */
export function writeLocal(key: MirroredKey, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  }
  catch {
    // localStorage unavailable — pod copy still authoritative for next load
  }
}

/**
 * Pull each mirrored key from the pod into localStorage (the connect-time hydrate). Used
 * when a pod copy should win on a fresh device. Missing pod keys are left untouched (the
 * local default / existing value stands). Returns the set of keys actually hydrated.
 *
 * SILENT-RESTORE RACE (roborev HIGH — the DEEPEST race window): each `writeLocal` is a
 * persistent `localStorage` write that lands the RESTORED user's mirrored data into local
 * state, and it runs AFTER an `await storage.getItem(...)`. A login()/logout() racing the
 * in-flight silent restore can fire during ANY of those awaits, so a now-stale restore must
 * NOT mirror the OLD user's `elk-settings`/`elk-drafts`/`elk-custom-emojis` over the newer
 * session's local state. The OPTIONAL `isCurrent` guard (the captured restore generation) is
 * therefore checked BEFORE EACH awaited pod read AND BEFORE EACH `localStorage` write; the
 * MOMENT it goes stale the hydrate ABORTS — it writes nothing further and returns the keys
 * hydrated so far (the caller — `setPodStorage` — then refuses to install/keep the singleton
 * and never starts the watcher). The interactive login()/manual hydrate path passes no guard
 * (it is itself the latest action), so its behaviour is unchanged.
 */
export async function hydrateFromPod(storage: Storage, isCurrent?: () => boolean): Promise<MirroredKey[]> {
  const hydrated: MirroredKey[] = []
  for (const key of MIRRORED_KEYS) {
    // BEFORE the awaited pod read: a stale restore must not even read the OLD user's pod.
    if (isCurrent && !isCurrent())
      return hydrated
    try {
      const value = await storage.getItem(podKey(key))
      // BEFORE the localStorage write: a login()/logout() may have raced during getItem().
      // If so, abort immediately — never mirror the stale restored user's data into local state.
      if (isCurrent && !isCurrent())
        return hydrated
      if (value != null) {
        writeLocal(key, value)
        hydrated.push(key)
      }
    }
    catch {
      // a single key failing to hydrate must not abort the others
    }
  }
  return hydrated
}

/**
 * Push the current localStorage value of each mirrored key to the pod (the change-time
 * persist). Only pushes keys that have a local value. Returns the set of keys pushed.
 */
export async function pushToPod(storage: Storage): Promise<MirroredKey[]> {
  const pushed: MirroredKey[] = []
  for (const key of MIRRORED_KEYS) {
    const value = readLocal(key)
    if (value == null)
      continue
    try {
      await storage.setItem(podKey(key), value)
      pushed.push(key)
    }
    catch {
      // a single key failing to push must not abort the others
    }
  }
  return pushed
}

/** Push a single mirrored key's current local value to the pod (debounced caller). */
export async function pushKeyToPod(storage: Storage, key: MirroredKey): Promise<boolean> {
  const value = readLocal(key)
  if (value == null)
    return false
  try {
    await storage.setItem(podKey(key), value)
    return true
  }
  catch {
    return false
  }
}
