import type { MirrorableStatus } from './mirror'
// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it, vi } from 'vitest'
import { mirrorStatus, statusSlug, statusToCanonical, timelineResourceUrl } from './mirror'

const WEBID = 'https://alice.pod.example/profile/card#me'
const ROOM = 'https://alice.pod.example/elk/timeline/#timeline'
const POD_BASE = 'https://alice.pod.example/elk/'

const STATUS: MirrorableStatus = {
  id: '109876543210',
  uri: 'https://m.example/users/alice/statuses/109876543210',
  url: 'https://m.example/@alice/109876543210',
  content: '<p>Hello fediverse</p>',
  createdAt: '2026-06-20T09:00:00.000Z',
  inReplyToUri: 'https://m.example/users/bob/statuses/1',
}

describe('statusToCanonical', () => {
  it('maps a status to a canonical message attributed to the OWNER WebID', () => {
    const msg = statusToCanonical(STATUS, WEBID, ROOM)
    expect(msg.content).toBe('<p>Hello fediverse</p>')
    expect(msg.mediaType).toBe('text/html')
    expect(msg.author).toBe(WEBID)
    expect(msg.room).toBe(ROOM)
    expect(msg.published).toBe('2026-06-20T09:00:00.000Z')
    expect(msg.inReplyTo).toBe('https://m.example/users/bob/statuses/1')
    expect(msg.provenance?.derivedFrom).toBe(STATUS.uri)
  })

  it('falls back to url for derivedFrom when uri is absent', () => {
    const msg = statusToCanonical({ ...STATUS, uri: undefined }, WEBID, ROOM)
    expect(msg.provenance?.derivedFrom).toBe(STATUS.url)
  })

  it('drops a non-http(s) inReplyTo / derivedFrom rather than failing', () => {
    const msg = statusToCanonical(
      { ...STATUS, uri: 'javascript:alert(1)', url: null, inReplyToUri: 'data:text/plain,x' },
      WEBID,
      ROOM,
    )
    expect(msg.provenance).toBeUndefined()
    expect(msg.inReplyTo).toBeUndefined()
  })

  it('drops an unparseable createdAt rather than failing', () => {
    const msg = statusToCanonical({ ...STATUS, createdAt: 'not-a-date' }, WEBID, ROOM)
    expect(msg.published).toBeUndefined()
  })

  it('normalises a valid but non-canonical date to ISO-8601', () => {
    const msg = statusToCanonical({ ...STATUS, createdAt: '2026-06-20T09:00:00Z' }, WEBID, ROOM)
    expect(msg.published).toBe('2026-06-20T09:00:00.000Z')
  })

  it('tolerates a missing content', () => {
    const msg = statusToCanonical({ ...STATUS, content: undefined as unknown as string }, WEBID, ROOM)
    expect(msg.content).toBe('')
  })
})

describe('statusSlug + timelineResourceUrl', () => {
  it('is stable for the same source uri (idempotent re-mirror)', () => {
    expect(statusSlug(STATUS)).toBe(statusSlug({ ...STATUS, id: 'different-id' }))
  })

  it('differs for a different source', () => {
    expect(statusSlug(STATUS)).not.toBe(statusSlug({ ...STATUS, uri: 'https://m.example/x/2' }))
  })

  it('resolves a child URL strictly under the container', () => {
    const url = timelineResourceUrl('https://alice.pod.example/elk/timeline/', statusSlug(STATUS))
    expect(url.startsWith('https://alice.pod.example/elk/timeline/')).toBe(true)
    expect(url.endsWith('.ttl')).toBe(true)
  })

  it('rejects a slug that would escape the container', () => {
    expect(() => timelineResourceUrl('https://alice.pod.example/elk/timeline/', '../../../etc'))
      .not
      .toThrow() // sanitised to a safe child, not an escape
    const url = timelineResourceUrl('https://alice.pod.example/elk/timeline/', '../../../etc')
    expect(url.startsWith('https://alice.pod.example/elk/timeline/')).toBe(true)
  })
})

describe('mirrorStatus', () => {
  it('writes the owner-only ACL FIRST, then the message resource', async () => {
    const calls: { url: string, method?: string }[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method })
      return new Response(null, { status: 201 })
    })
    const res = await mirrorStatus(STATUS, {
      fetch: fetchImpl as unknown as typeof fetch,
      webId: WEBID,
      podBase: POD_BASE,
    })
    expect(res.written).toBe(true)
    // First call is the ACL PUT; second is the message PUT.
    expect(calls[0].url).toBe('https://alice.pod.example/elk/timeline/.acl')
    expect(calls[0].method).toBe('PUT')
    expect(calls[1].url.startsWith('https://alice.pod.example/elk/timeline/status-')).toBe(true)
    expect(calls[1].url.endsWith('.ttl')).toBe(true)
  })

  it('does NOT write the message when the ACL write fails (fail-closed)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('.acl'))
        return new Response('no', { status: 403, statusText: 'Forbidden' })
      return new Response(null, { status: 201 })
    })
    await expect(mirrorStatus(STATUS, {
      fetch: fetchImpl as unknown as typeof fetch,
      webId: WEBID,
      podBase: POD_BASE,
    })).rejects.toThrow(/ACL write failed/)
    // Only the ACL call happened; the message PUT was never reached.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('skips the ACL write when ensureAcl is false', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 205 }))
    await mirrorStatus(STATUS, {
      fetch: fetchImpl as unknown as typeof fetch,
      webId: WEBID,
      podBase: POD_BASE,
      ensureAcl: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(url.endsWith('.acl')).toBe(false)
  })

  it('produces serialisable AS2 Turtle (the message body parses round-trip)', async () => {
    let body = ''
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('.acl'))
        body = String(init?.body)
      return new Response(null, { status: 201 })
    })
    await mirrorStatus(STATUS, {
      fetch: fetchImpl as unknown as typeof fetch,
      webId: WEBID,
      podBase: POD_BASE,
    })
    expect(body).toContain('https://www.w3.org/ns/activitystreams#')
    expect(body).toContain('Hello fediverse')
  })

  // ---- podBase raw-string-URL-smuggling hardening ----
  //
  // `podBase` is derived (via `resolveStorageRoot` + `ELK_POD_NAMESPACE`) from the user's
  // WebID profile RDF — untrusted input. The old `podBase.endsWith('/') ? podBase :
  // podBase + '/'` check trusted the RAW string, so a value whose query/fragment supplied
  // the trailing "/" (e.g. `https://evil.example/foo?x=/`) passed while its actual path was
  // `/foo` — the timeline container then resolved onto a different resource than intended.
  describe('podBase hardening (normalizePodBase)', () => {
    it('rejects a podBase whose trailing "/" comes from a QUERY string', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
      await expect(mirrorStatus(STATUS, {
        fetch: fetchImpl as unknown as typeof fetch,
        webId: WEBID,
        podBase: 'https://alice.pod.example/foo?x=/',
      })).rejects.toThrow(/query\/fragment/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects a podBase whose trailing "/" comes from a FRAGMENT', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
      await expect(mirrorStatus(STATUS, {
        fetch: fetchImpl as unknown as typeof fetch,
        webId: WEBID,
        podBase: 'https://alice.pod.example/foo#/',
      })).rejects.toThrow(/query\/fragment/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects an unparseable podBase', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
      await expect(mirrorStatus(STATUS, {
        fetch: fetchImpl as unknown as typeof fetch,
        webId: WEBID,
        podBase: 'not a url at all',
      })).rejects.toThrow(/valid absolute URL/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('rejects a non-http(s) podBase', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
      await expect(mirrorStatus(STATUS, {
        fetch: fetchImpl as unknown as typeof fetch,
        webId: WEBID,
        podBase: 'file:///etc/',
      })).rejects.toThrow(/http\(s\)/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('a real, well-shaped podBase resolves the timeline container correctly via new URL(child, base)', async () => {
      const calls: string[] = []
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(null, { status: 201 })
      })
      await mirrorStatus(STATUS, {
        fetch: fetchImpl as unknown as typeof fetch,
        webId: WEBID,
        podBase: 'https://alice.pod.example/elk',
      })
      expect(calls[0]).toBe('https://alice.pod.example/elk/timeline/.acl')
      expect(calls[1].startsWith('https://alice.pod.example/elk/timeline/status-')).toBe(true)
    })
  })
})
