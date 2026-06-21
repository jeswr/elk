// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commitHydratedToLocal,
  createPodStorage,
  hydrateFromPod,
  MIRRORED_KEYS,
  pushKeyToPod,
  pushToPod,
  readLocal,
  writeLocal,
} from './storage'

// A minimal in-memory localStorage stub for the node test environment.
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  } as Storage
  return store
}

function uninstallLocalStorage(): void {
  delete (globalThis as { localStorage?: Storage }).localStorage
}

describe('readLocal / writeLocal', () => {
  beforeEach(() => installLocalStorage())
  afterEach(uninstallLocalStorage)

  it('round-trips JSON values', () => {
    writeLocal('elk-settings', { fontSize: '15px', language: 'en' })
    expect(readLocal('elk-settings')).toEqual({ fontSize: '15px', language: 'en' })
  })

  it('returns null for a missing key', () => {
    expect(readLocal('elk-drafts')).toBeNull()
  })

  it('returns null (not throw) for corrupt JSON', () => {
    globalThis.localStorage.setItem('elk-settings', '{not json')
    expect(readLocal('elk-settings')).toBeNull()
  })
})

describe('createPodStorage', () => {
  it('builds an unstorage instance for a slash-terminated base', () => {
    const storage = createPodStorage('https://alice.pod/elk/kv/', (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch)
    expect(typeof storage.getItem).toBe('function')
    expect(typeof storage.setItem).toBe('function')
  })

  it('rejects a base not ending in "/"', () => {
    expect(() => createPodStorage('https://alice.pod/elk/kv', fetch))
      .toThrow(/must end with/)
  })
})

describe('hydrateFromPod / pushToPod', () => {
  beforeEach(() => installLocalStorage())
  afterEach(uninstallLocalStorage)

  function fakeStorage(initial: Record<string, unknown> = {}) {
    const data = new Map<string, unknown>(Object.entries(initial))
    return {
      getItem: vi.fn(async (k: string) => (data.has(k) ? data.get(k) : null)),
      setItem: vi.fn(async (k: string, v: unknown) => void data.set(k, v)),
      _data: data,
    }
  }

  it('read phase: reads only the keys the pod actually has into a map — and writes NOTHING to localStorage', async () => {
    const storage = fakeStorage({ 'elk-settings': { fontSize: '18px' } })
    const read = await hydrateFromPod(storage as never)
    // The read phase returns a map of present pod keys only…
    expect([...read.keys()]).toEqual(['elk-settings'])
    expect(read.get('elk-settings')).toEqual({ fontSize: '18px' })
    expect(read.has('elk-drafts')).toBe(false)
    // …and is PURE: it must not touch localStorage (the commit phase does that, atomically).
    expect(readLocal('elk-settings')).toBeNull()
    expect(readLocal('elk-drafts')).toBeNull()
  })

  it('commit phase: commitHydratedToLocal synchronously writes the whole read map to localStorage', async () => {
    const storage = fakeStorage({ 'elk-settings': { fontSize: '18px' }, 'elk-drafts': { home: [1] } })
    const read = await hydrateFromPod(storage as never)
    const committed = commitHydratedToLocal(read)
    expect(committed.sort()).toEqual(['elk-drafts', 'elk-settings'])
    expect(readLocal('elk-settings')).toEqual({ fontSize: '18px' })
    expect(readLocal('elk-drafts')).toEqual({ home: [1] })
    expect(readLocal('elk-custom-emojis')).toBeNull()
  })

  it('read phase early-aborts the reads the moment isCurrent() goes stale (no later key read)', async () => {
    const storage = fakeStorage({ 'elk-settings': { a: 1 }, 'elk-drafts': { b: 2 }, 'elk-custom-emojis': { c: 3 } })
    let calls = 0
    // Current for the first key's pre-read guard, stale thereafter → reads key #1 only, then aborts
    // before reading keys #2/#3 (the pre-read guard short-circuits the next iterations).
    const isCurrent = () => ++calls <= 1
    const read = await hydrateFromPod(storage as never, isCurrent)
    expect(storage.getItem).toHaveBeenCalledTimes(1)
    expect([...read.keys()]).toEqual(['elk-settings'])
  })

  it('read phase with no guard reads EVERY key (non-vacuity for the early-abort test)', async () => {
    const storage = fakeStorage({ 'elk-settings': { a: 1 }, 'elk-drafts': { b: 2 }, 'elk-custom-emojis': { c: 3 } })
    const read = await hydrateFromPod(storage as never)
    expect(storage.getItem).toHaveBeenCalledTimes(3)
    expect([...read.keys()].sort()).toEqual(['elk-custom-emojis', 'elk-drafts', 'elk-settings'])
  })

  it('pushes only locally-present keys', async () => {
    writeLocal('elk-drafts', { home: [] })
    const storage = fakeStorage()
    const pushed = await pushToPod(storage as never)
    expect(pushed).toEqual(['elk-drafts'])
    expect(storage.setItem).toHaveBeenCalledWith('elk-drafts', { home: [] })
  })

  it('pushKeyToPod pushes one key and reports false for an absent one', async () => {
    writeLocal('elk-custom-emojis', { a: 1 })
    const storage = fakeStorage()
    expect(await pushKeyToPod(storage as never, 'elk-custom-emojis')).toBe(true)
    expect(await pushKeyToPod(storage as never, 'elk-drafts')).toBe(false)
  })

  it('a single failing key does not abort the rest', async () => {
    writeLocal('elk-settings', { a: 1 })
    writeLocal('elk-drafts', { b: 2 })
    const storage = {
      getItem: vi.fn(async () => null),
      setItem: vi.fn(async (k: string) => {
        if (k === 'elk-settings')
          throw new Error('boom')
      }),
    }
    const pushed = await pushToPod(storage as never)
    expect(pushed).toContain('elk-drafts')
    expect(pushed).not.toContain('elk-settings')
  })

  it('exposes the curated portable key set (no volatile caches)', () => {
    expect(MIRRORED_KEYS).toEqual(['elk-settings', 'elk-drafts', 'elk-custom-emojis'])
  })
})
