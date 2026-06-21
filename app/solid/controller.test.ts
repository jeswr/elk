// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Controller tests — the SECURITY-CRITICAL kv/ owner-only-ACL contract (roborev Medium #1)
// and the mirrored-key change→pod-sync wiring (roborev Medium #2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPodStorage,
  ensureKvAcl,
  kvAclEnsured,
  schedulePodSync,
  setPodStorage,
  unwatchMirroredKeys,
  watchMirroredKeys,
} from './controller'
import { solidFetch, solidPodBase, solidWebId } from './session'

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

/** Build a fake unstorage instance recording setItem calls. */
function fakeStorage() {
  const data = new Map<string, unknown>()
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

describe('schedulePodSync — no-op when no pod connected', () => {
  afterEach(() => clearPodStorage())
  it('does nothing when no pod storage is mounted', () => {
    // No setPodStorage → podStorage is null → schedulePodSync is a safe no-op.
    expect(() => schedulePodSync('elk-settings')).not.toThrow()
  })
})
