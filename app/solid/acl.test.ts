// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
import { describe, expect, it, vi } from 'vitest'
import { buildOwnerOnlyAclTurtle, writeOwnerOnlyAcl } from './acl'

const CONTAINER = 'https://alice.pod.example/elk/timeline/'
const WEBID = 'https://alice.pod.example/profile/card#me'

describe('buildOwnerOnlyAclTurtle', () => {
  it('grants ONLY the owner Read/Write/Control over the container + descendants', async () => {
    const ttl = await buildOwnerOnlyAclTurtle(CONTAINER, WEBID)
    expect(ttl).toContain('acl:Authorization')
    expect(ttl).toContain(WEBID)
    expect(ttl).toContain(CONTAINER)
    expect(ttl).toContain('acl:Read')
    expect(ttl).toContain('acl:Write')
    expect(ttl).toContain('acl:Control')
    // accessTo + default ⇒ applies to the container AND everything under it.
    expect(ttl).toContain('acl:accessTo')
    expect(ttl).toContain('acl:default')
  })

  it('grants nothing public — no foaf:Agent / acl:agentClass', async () => {
    const ttl = await buildOwnerOnlyAclTurtle(CONTAINER, WEBID)
    expect(ttl).not.toContain('agentClass')
    expect(ttl).not.toContain('foaf:Agent')
    expect(ttl).not.toContain('AuthenticatedAgent')
  })

  it('rejects a non-slash-terminated container', async () => {
    await expect(buildOwnerOnlyAclTurtle('https://alice.pod.example/elk/timeline', WEBID))
      .rejects
      .toThrow(/must end with/)
  })

  it('rejects a non-http(s) WebID', async () => {
    await expect(buildOwnerOnlyAclTurtle(CONTAINER, 'mailto:alice@example.com'))
      .rejects
      .toThrow(/http\(s\) IRI/)
  })
})

describe('writeOwnerOnlyAcl', () => {
  it('puts the ACL to the container .acl resource as text/turtle', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }))
    await writeOwnerOnlyAcl(fetchImpl as unknown as typeof fetch, CONTAINER, WEBID)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${CONTAINER}.acl`)
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/turtle')
  })

  it('throws (fail-closed) when the ACL PUT is not 2xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403, statusText: 'Forbidden' }))
    await expect(writeOwnerOnlyAcl(fetchImpl as unknown as typeof fetch, CONTAINER, WEBID))
      .rejects
      .toThrow(/ACL write failed/)
  })
})
