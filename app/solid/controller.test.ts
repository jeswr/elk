// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Controller tests — the SECURITY-CRITICAL kv/ owner-only-ACL contract (roborev Medium #1)
// and the mirrored-key change→pod-sync wiring (roborev Medium #2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPodStorage,
  ensureKvAcl,
  kvAclEnsured,
  podConnected,
  schedulePodSync,
  setPodStorage,
  unwatchMirroredKeys,
  watchMirroredKeys,
} from './controller'
import {
  beginRestoreGeneration,
  bumpRestoreGeneration,
  isRestoreGenerationCurrent,
  solidFetch,
  solidPodBase,
  solidWebId,
} from './session'
import { MIRRORED_KEYS } from './storage'

const WEBID = 'https://alice.pod.example/profile/card#me'
const POD_BASE = 'https://alice.pod.example/elk/'
const KV_CONTAINER = `${POD_BASE}kv/`
const KV_ACL = `${KV_CONTAINER}.acl`

// ---- a minimal in-memory localStorage + window for the node env ----
function installDom(): { store: Map<string, string>, listeners: Map<string, Set<EventListener>> } {
  const store = new Map<string, string>()
  const listeners = new Map<string, Set<EventListener>>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
  ;(globalThis as any).window = {
    addEventListener: (type: string, cb: EventListener) => {
      if (!listeners.has(type))
        listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
    },
    removeEventListener: (type: string, cb: EventListener) => {
      listeners.get(type)?.delete(cb)
    },
    dispatchEvent: (ev: Event) => {
      listeners.get(ev.type)?.forEach(cb => cb(ev))
      return true
    },
  }
  return { store, listeners }
}

function uninstallDom(): void {
  delete (globalThis as any).localStorage
  delete (globalThis as any).window
}

/** Build a fake unstorage instance recording setItem calls (optionally seeded with pod data). */
function fakeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    getItem: vi.fn(async (k: string) => (data.has(k) ? data.get(k) : null)),
    setItem: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
    _data: data,
  }
}

describe('ensureKvAcl — owner-only ACL on the kv/ container (Medium #1, fail-closed)', () => {
  beforeEach(() => {
    solidWebId.value = WEBID
    solidPodBase.value = POD_BASE
  })
  afterEach(() => {
    clearPodStorage()
    solidWebId.value = null
    solidPodBase.value = null
    vi.restoreAllMocks()
  })

  it('writes an OWNER-ONLY ACL (accessTo + default, Read/Write/Control) to kv/.acl', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    solidFetch.value = fetchImpl as unknown as typeof fetch

    await ensureKvAcl(KV_CONTAINER)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(KV_ACL)
    expect(init.method).toBe('PUT')
    const body = String(init.body)
    // Owner-only: the owner WebID, accessTo + default (container + descendants), all 3 modes.
    expect(body).toContain(WEBID)
    expect(body).toContain('accessTo')
    expect(body).toContain('default')
    expect(body).toContain('Read')
    expect(body).toContain('Write')
    expect(body).toContain('Control')
    // Nothing public.
    expect(body).not.toContain('agentClass')
    expect(body).not.toContain('AuthenticatedAgent')
    expect(kvAclEnsured(KV_CONTAINER)).toBe(true)
  })

  it('is memoised: a burst of concurrent first writes issues the ACL PUT exactly once', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    solidFetch.value = fetchImpl as unknown as typeof fetch

    await Promise.all([ensureKvAcl(KV_CONTAINER), ensureKvAcl(KV_CONTAINER), ensureKvAcl(KV_CONTAINER)])
    // And a later call too — still one PUT for the session.
    await ensureKvAcl(KV_CONTAINER)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fail-closed: a non-2xx ACL PUT REJECTS so the caller never writes KV data', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403, statusText: 'Forbidden' }))
    solidFetch.value = fetchImpl as unknown as typeof fetch

    await expect(ensureKvAcl(KV_CONTAINER)).rejects.toThrow(/ACL write failed/)
    expect(kvAclEnsured(KV_CONTAINER)).toBe(false)

    // The memo was DROPPED on failure → the next attempt re-tries the ACL (not cached as done).
    const ok = vi.fn(async () => new Response(null, { status: 201 }))
    solidFetch.value = ok as unknown as typeof fetch
    await ensureKvAcl(KV_CONTAINER)
    expect(ok).toHaveBeenCalledTimes(1)
    expect(kvAclEnsured(KV_CONTAINER)).toBe(true)
  })

  it('fail-closed: rejects when there is NO connected WebID (cannot establish owner ACL)', async () => {
    solidWebId.value = null
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    solidFetch.value = fetchImpl as unknown as typeof fetch
    await expect(ensureKvAcl(KV_CONTAINER)).rejects.toThrow(/no connected WebID/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('establishes the ACL BEFORE the first KV write (mountPod-equivalent ordering)', async () => {
    // Simulate the plugin's mountPod ordering: ensureKvAcl MUST resolve before setItem runs.
    const order: string[] = []
    const fetchImpl = vi.fn(async () => {
      order.push('acl-put')
      return new Response(null, { status: 201 })
    })
    solidFetch.value = fetchImpl as unknown as typeof fetch
    const storage = fakeStorage()
    storage.setItem.mockImplementation(async (k: string, v: unknown) => {
      order.push(`kv-write:${k}`)
      storage._data.set(k, v)
    })

    // The plugin does: await ensureKvAcl(kv) → setPodStorage(storage) → write.
    await ensureKvAcl(KV_CONTAINER)
    await setPodStorage(storage as never)
    await storage.setItem('elk-settings', { fontSize: '15px' })

    expect(order[0]).toBe('acl-put')
    expect(order).toContain('kv-write:elk-settings')
    expect(order.indexOf('acl-put')).toBeLessThan(order.indexOf('kv-write:elk-settings'))
  })

  it('a FAILED ACL prevents the KV write (the caller bails before mounting/writing)', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403, statusText: 'Forbidden' }))
    solidFetch.value = fetchImpl as unknown as typeof fetch
    const storage = fakeStorage()

    // mountPod-equivalent: if ensureKvAcl throws, the caller never reaches setItem.
    let wrote = false
    try {
      await ensureKvAcl(KV_CONTAINER)
      await storage.setItem('elk-settings', { a: 1 })
      wrote = true
    }
    catch {
      // expected — fail-closed
    }
    expect(wrote).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('the kv-ACL memo SURVIVES setPodStorage (mountPod order: ensureKvAcl → setPodStorage)', async () => {
    // Regression: setPodStorage must NOT reset the just-established kv-ACL flag, and a
    // re-ensure after mount must NOT issue a second ACL PUT (idempotent within the session).
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    solidFetch.value = fetchImpl as unknown as typeof fetch
    const storage = fakeStorage()

    await ensureKvAcl(KV_CONTAINER)
    await setPodStorage(storage as never)
    expect(kvAclEnsured(KV_CONTAINER)).toBe(true)

    await ensureKvAcl(KV_CONTAINER) // re-ensure after mount
    expect(fetchImpl).toHaveBeenCalledTimes(1) // still ONE PUT
  })
})

describe('watchMirroredKeys — ongoing edits push to the pod (Medium #2)', () => {
  let env: ReturnType<typeof installDom>
  beforeEach(() => {
    vi.useFakeTimers()
    env = installDom()
    solidWebId.value = WEBID
    solidPodBase.value = POD_BASE
  })
  afterEach(() => {
    clearPodStorage()
    solidWebId.value = null
    solidPodBase.value = null
    vi.useRealTimers()
    uninstallDom()
  })

  /** Fire the StorageEvent VueUse dispatches in-tab for a mirrored-key write. */
  function dispatchMirrorWrite(key: string, value: unknown): void {
    globalThis.localStorage.setItem(key, JSON.stringify(value))
    const ev = { type: 'storage', key } as unknown as StorageEvent
    ;(globalThis as any).window.dispatchEvent(ev)
  }

  it('a local change to a mirrored key causes a (debounced) pod write', async () => {
    const storage = fakeStorage()
    await setPodStorage(storage as never)
    watchMirroredKeys()

    dispatchMirrorWrite('elk-settings', { fontSize: '20px' })

    // Debounced: nothing yet before the timer fires.
    expect(storage.setItem).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1500)
    await Promise.resolve()

    expect(storage.setItem).toHaveBeenCalledWith('elk-settings', { fontSize: '20px' })
  })

  it('coalesces a burst of edits into ONE pod write (debounce)', async () => {
    const storage = fakeStorage()
    await setPodStorage(storage as never)
    watchMirroredKeys()

    dispatchMirrorWrite('elk-drafts', { home: [1] })
    dispatchMirrorWrite('elk-drafts', { home: [1, 2] })
    dispatchMirrorWrite('elk-drafts', { home: [1, 2, 3] })
    await vi.advanceTimersByTimeAsync(1500)
    await Promise.resolve()

    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledWith('elk-drafts', { home: [1, 2, 3] })
  })

  it('iGNORES non-mirrored localStorage keys (no spurious pod writes)', async () => {
    const storage = fakeStorage()
    await setPodStorage(storage as never)
    watchMirroredKeys()

    dispatchMirrorWrite('elk-servers', { not: 'mirrored' })
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.resolve()

    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('stops pushing after disconnect (clearPodStorage tears down the watcher)', async () => {
    const storage = fakeStorage()
    await setPodStorage(storage as never)
    watchMirroredKeys()
    clearPodStorage()

    dispatchMirrorWrite('elk-settings', { fontSize: '30px' })
    await vi.advanceTimersByTimeAsync(2000)
    await Promise.resolve()

    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('unwatchMirroredKeys removes the listener (no leak)', async () => {
    const storage = fakeStorage()
    await setPodStorage(storage as never)
    watchMirroredKeys()
    expect(env.listeners.get('storage')?.size).toBe(1)
    unwatchMirroredKeys()
    expect(env.listeners.get('storage')?.size ?? 0).toBe(0)
  })
})

// ---- roborev HIGH (the DEEPEST race window, definitive round): setPodStorage's hydrate writes
// the RESTORED user's mirrored keys (elk-settings/elk-drafts/elk-custom-emojis) into localStorage
// AFTER each awaited pod read, and installs the pod-storage singleton. A login()/logout() racing
// the in-flight silent restore must let a now-stale restore mirror NO data, install NO singleton,
// and start NO watcher. We drive the PRODUCTION setPodStorage(storage, isCurrent) over the SAME
// generation-guard primitives the plugin uses (beginRestoreGeneration before the restore;
// isRestoreGenerationCurrent threaded in as isCurrent; a login/logout bumps the generation). ----
describe('setPodStorage hydrate race — a login()/logout() DURING the hydrate writes NO stale mirrored keys / no singleton (roborev HIGH)', () => {
  let env: ReturnType<typeof installDom>
  beforeEach(() => {
    env = installDom()
    solidWebId.value = WEBID
    solidPodBase.value = POD_BASE
  })
  afterEach(() => {
    clearPodStorage()
    solidWebId.value = null
    solidPodBase.value = null
    uninstallDom()
    vi.restoreAllMocks()
  })

  /**
   * A fake unstorage whose getItem SUSPENDS on the FIRST mirrored-key read until released, so a
   * racing login()/logout() can be injected mid-hydrate. Records every setItem (it should never be
   * called here — hydrate writes localStorage via writeLocal, not the pod). `pod` seeds the pod's
   * mirrored values so a non-gated hydrate WOULD write them to localStorage.
   */
  function suspendableStorage(pod: Record<string, unknown>) {
    let release!: () => void
    const firstRead = new Promise<void>(r => (release = r))
    let firstReadStarted!: () => void
    const started = new Promise<void>(r => (firstReadStarted = r))
    let first = true
    const getItem = vi.fn(async (k: string) => {
      if (first) {
        first = false
        firstReadStarted()
        await firstRead
      }
      return k in pod ? pod[k] : null
    })
    return {
      storage: { getItem, setItem: vi.fn(async () => {}) },
      release,
      started, // resolves once the first getItem has begun (so we race AT the suspension point)
      getItem,
    }
  }

  it('a generation bump (login/logout) DURING the hydrate → NO mirrored-key localStorage write, singleton NOT installed, podConnected() false', async () => {
    // Seed the pod with the OLD (restored) user's mirrored data — a non-gated hydrate would mirror these.
    const { storage, release, started } = suspendableStorage({
      'elk-settings': { fontSize: '99px' },
      'elk-drafts': { home: ['stale'] },
      'elk-custom-emojis': { stale: true },
    })
    const restoreGen = beginRestoreGeneration()
    const isCurrent = () => isRestoreGenerationCurrent(restoreGen)

    const mounting = setPodStorage(storage as never, isCurrent)
    // Wait until the hydrate is suspended at its FIRST pod read, then race a login()/logout().
    await started
    bumpRestoreGeneration() // what login() / disconnectSolid() does first → the restore is now STALE
    release() // resume the suspended getItem; the post-await guard must now abort the hydrate
    await mounting

    // NO mirrored key was written to localStorage for the stale restore.
    expect(env.store.has('elk-settings')).toBe(false)
    expect(env.store.has('elk-drafts')).toBe(false)
    expect(env.store.has('elk-custom-emojis')).toBe(false)
    // The pod-storage singleton was NOT installed (setPodStorage refused on the stale restore).
    expect(podConnected()).toBe(false)
    // And the watcher would not be started either (the plugin re-checks isCurrent before watch).
    expect(isCurrent()).toBe(false)
  })

  it('happy path (no race): the hydrate fully mirrors the pod keys AND installs the singleton (guards NOT vacuous)', async () => {
    const { storage, release, started } = suspendableStorage({
      'elk-settings': { fontSize: '15px' },
      'elk-drafts': { home: ['draft1'] },
      'elk-custom-emojis': { a: 1 },
    })
    const restoreGen = beginRestoreGeneration()
    const isCurrent = () => isRestoreGenerationCurrent(restoreGen)

    const mounting = setPodStorage(storage as never, isCurrent)
    await started
    // NO race — nothing bumps the generation. Release and let the hydrate complete.
    release()
    await mounting

    // Every mirrored key was hydrated into localStorage (writeLocal stores JSON).
    expect(JSON.parse(env.store.get('elk-settings')!)).toEqual({ fontSize: '15px' })
    expect(JSON.parse(env.store.get('elk-drafts')!)).toEqual({ home: ['draft1'] })
    expect(JSON.parse(env.store.get('elk-custom-emojis')!)).toEqual({ a: 1 })
    // The singleton IS installed → podConnected() true (proving the install-gate is not always-skip).
    expect(podConnected()).toBe(true)
    expect(isCurrent()).toBe(true)
  })

  it('the FIRST awaited pod read is itself gated: a bump BEFORE release means getItem is not even re-read past the suspended one', async () => {
    // Proves the BEFORE-the-write guard AND the BEFORE-the-read guard both fire: after the stale
    // bump, the hydrate aborts at the post-read guard for key #1 and never reads keys #2/#3.
    const { storage, release, started, getItem } = suspendableStorage({
      'elk-settings': { x: 1 },
      'elk-drafts': { y: 2 },
      'elk-custom-emojis': { z: 3 },
    })
    const restoreGen = beginRestoreGeneration()
    const isCurrent = () => isRestoreGenerationCurrent(restoreGen)

    const mounting = setPodStorage(storage as never, isCurrent)
    await started
    bumpRestoreGeneration()
    release()
    await mounting

    // Only the FIRST (already-suspended) read ran; the loop aborted before reading keys #2 and #3
    // (the pre-read guard short-circuits the next iterations).
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(podConnected()).toBe(false)
  })

  it('non-vacuity: with the guard passed but the WHOLE hydrate current, all THREE keys are read (no premature abort)', async () => {
    // Confirms the gated path reads every key when current — so the abort in the race tests is
    // genuinely caused by the bump, not by the guard short-circuiting unconditionally.
    const { storage, release, started, getItem } = suspendableStorage({
      'elk-settings': { x: 1 },
      'elk-drafts': { y: 2 },
      'elk-custom-emojis': { z: 3 },
    })
    const restoreGen = beginRestoreGeneration()
    const isCurrent = () => isRestoreGenerationCurrent(restoreGen)
    const mounting = setPodStorage(storage as never, isCurrent)
    await started
    release()
    await mounting
    expect(getItem).toHaveBeenCalledTimes(3)
  })
})

// ---- roborev Medium (old singleton active during a new hydrate): an account-switch / interactive
// login installs a NEW pod storage while the PREVIOUS singleton + watcher are still live. If the new
// hydrate's await window leaves the old singleton active, a mirrored-key edit (or a pending debounced
// push) can be flushed to the PRIOR pod. setPodStorage must SYNCHRONOUSLY disable the previous
// singleton + watcher + pending timers BEFORE awaiting the new hydrate, and re-install (atomically)
// only on success. ----
describe('setPodStorage account-switch — clears the OLD singleton/watcher before the new hydrate (roborev Medium)', () => {
  let env: ReturnType<typeof installDom>
  beforeEach(() => {
    env = installDom()
    solidWebId.value = WEBID
    solidPodBase.value = POD_BASE
  })
  afterEach(() => {
    clearPodStorage()
    solidWebId.value = null
    solidPodBase.value = null
    uninstallDom()
    vi.restoreAllMocks()
  })

  /** A storage whose hydrate getItem SUSPENDS so we can act during the new hydrate's await window. */
  function suspendableEmptyStorage() {
    let release!: () => void
    const firstRead = new Promise<void>(r => (release = r))
    let firstReadStarted!: () => void
    const started = new Promise<void>(r => (firstReadStarted = r))
    let first = true
    return {
      storage: {
        getItem: vi.fn(async () => {
          if (first) {
            first = false
            firstReadStarted()
            await firstRead
          }
          return null
        }),
        setItem: vi.fn(async () => {}),
      },
      release,
      started,
    }
  }

  it('a settings edit DURING the new hydrate does NOT push to the OLD pod (old singleton/watcher cleared first)', async () => {
    vi.useFakeTimers()
    try {
      // FIRST user/pod is mounted with a live watcher.
      const oldStorage = fakeStorage()
      await setPodStorage(oldStorage as never) // installs old singleton + watcher (atomically)
      expect(env.listeners.get('storage')?.size).toBe(1)

      // Now an account-switch begins: setPodStorage for the NEW pod, whose hydrate suspends.
      const { storage: newStorage, release, started } = suspendableEmptyStorage()
      const mounting = setPodStorage(newStorage as never)
      await started // we are now inside the new hydrate's await window

      // The OLD singleton + watcher must already be disabled (synchronously, before the await).
      // A mirrored-key edit dispatched now must NOT be pushed to the OLD pod.
      globalThis.localStorage.setItem('elk-settings', JSON.stringify({ x: 1 }))
      ;(globalThis as any).window.dispatchEvent({ type: 'storage', key: 'elk-settings' } as unknown as StorageEvent)
      await vi.advanceTimersByTimeAsync(2000)
      await Promise.resolve()
      expect(oldStorage.setItem).not.toHaveBeenCalled() // nothing leaked to the prior pod

      // Finish the switch: the NEW singleton + watcher install atomically on success.
      release()
      await mounting
      expect(env.listeners.get('storage')?.size).toBe(1) // exactly one watcher (the new one)
      expect(podConnected()).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('a PENDING debounced push to the OLD pod is dropped when a switch begins (timers cleared)', async () => {
    vi.useFakeTimers()
    try {
      const oldStorage = fakeStorage()
      await setPodStorage(oldStorage as never)
      // Queue a debounced push to the OLD pod (timer not yet fired).
      schedulePodSync('elk-settings')

      // Begin the switch — setPodStorage must clear the pending timer synchronously, before any await.
      const { storage: newStorage, release } = suspendableEmptyStorage()
      const mounting = setPodStorage(newStorage as never)

      // Let the OLD debounce window fully elapse: the dropped timer must never fire to the old pod.
      await vi.advanceTimersByTimeAsync(5000)
      await Promise.resolve()
      expect(oldStorage.setItem).not.toHaveBeenCalled()

      release()
      await mounting
    }
    finally {
      vi.useRealTimers()
    }
  })
})

// ---- Non-vacuity of the ATOMIC final check (roborev HIGH): the synchronous batch-commit + install
// must be GATED by the single final isCurrent() — proven by the race test failing if the check is
// dropped. Here we assert the positive: when current, the commit + install happen; when made stale
// exactly at the final check (after all reads completed current), NOTHING is committed/installed. ----
describe('setPodStorage atomic final-check non-vacuity (roborev HIGH)', () => {
  let env: ReturnType<typeof installDom>
  beforeEach(() => {
    env = installDom()
    solidWebId.value = WEBID
    solidPodBase.value = POD_BASE
  })
  afterEach(() => {
    clearPodStorage()
    solidWebId.value = null
    solidPodBase.value = null
    uninstallDom()
    vi.restoreAllMocks()
  })

  it('stale EXACTLY at the final check (all reads were current) → NO commit, NO singleton, NO watcher', async () => {
    // The guard stays current through ALL the read-phase pre-read checks, then goes stale on the
    // FINAL check in setPodStorage — proving the final synchronous gate (not just the read guard)
    // is what blocks the commit + install of an all-keys-read map.
    const storage = fakeStorage({
      'elk-settings': { fontSize: '99px' },
      'elk-drafts': { home: ['stale'] },
      'elk-custom-emojis': { stale: true },
    })
    // MIRRORED_KEYS.length pre-read checks (all current) + 1 final check (stale).
    let calls = 0
    const isCurrent = () => ++calls <= MIRRORED_KEYS.length

    await setPodStorage(storage as never, isCurrent)

    // All 3 keys were READ (read-phase ran fully current)…
    expect(storage.getItem).toHaveBeenCalledTimes(MIRRORED_KEYS.length)
    // …but the final check went stale → NOTHING committed to localStorage, no singleton, no watcher.
    expect(env.store.has('elk-settings')).toBe(false)
    expect(env.store.has('elk-drafts')).toBe(false)
    expect(env.store.has('elk-custom-emojis')).toBe(false)
    expect(podConnected()).toBe(false)
    expect(env.listeners.get('storage')?.size ?? 0).toBe(0)
  })

  it('current at the final check → commits ALL keys + installs singleton + starts watcher (not vacuous)', async () => {
    const storage = fakeStorage({
      'elk-settings': { fontSize: '15px' },
      'elk-drafts': { home: ['d'] },
      'elk-custom-emojis': { a: 1 },
    })
    // Always current.
    await setPodStorage(storage as never, () => true)

    expect(JSON.parse(env.store.get('elk-settings')!)).toEqual({ fontSize: '15px' })
    expect(JSON.parse(env.store.get('elk-drafts')!)).toEqual({ home: ['d'] })
    expect(JSON.parse(env.store.get('elk-custom-emojis')!)).toEqual({ a: 1 })
    expect(podConnected()).toBe(true)
    expect(env.listeners.get('storage')?.size).toBe(1) // watcher started by the atomic block
  })
})

describe('schedulePodSync — no-op when no pod connected', () => {
  afterEach(() => clearPodStorage())
  it('does nothing when no pod storage is mounted', () => {
    // No setPodStorage → podStorage is null → schedulePodSync is a safe no-op.
    expect(() => schedulePodSync('elk-settings')).not.toThrow()
  })
})
