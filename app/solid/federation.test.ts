// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Federation-registration contract tests — verify Elk's committed federation artifacts
// (the clientid.jsonld fedapp block + the fedreg:Membership doc) are well-formed and
// agree with each other. These lock the federation IRIs so a refactor cannot silently
// break Elk's self-registration / membership.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listMembers } from '@jeswr/federation-registry'
import { describe, expect, it } from 'vitest'

const CLIENT_ID = 'https://elk.jeswr.org/clientid.jsonld'
const SOCIAL_SECTOR = 'https://w3id.org/jeswr/sectors/social#sector'
const NOTE_SHAPE = 'https://w3id.org/jeswr/sectors/social/shapes#NoteShape'

function readPublic(rel: string): string {
  const url = new URL(`../../public/${rel}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

describe('clientid.jsonld fedapp self-registration', () => {
  const doc = JSON.parse(readPublic('clientid.jsonld'))

  it('declares an fedapp:App in the social sector', () => {
    expect(doc['@type']).toBe('App')
    expect(doc.sector).toBe(SOCIAL_SECTOR)
  })

  it('client_id equals its own served URL (Solid-OIDC rule)', () => {
    expect(doc.client_id).toBe(CLIENT_ID)
  })

  it('requests the WAC modes Elk needs (Read/Write/Control for owner-private mirror)', () => {
    expect(doc.access).toContain('acl:Read')
    expect(doc.access).toContain('acl:Write')
    expect(doc.access).toContain('acl:Control')
  })

  it('produces the social Note shape (chat-interop CanonicalMessage / as:Note)', () => {
    expect(doc.produces).toContain(NOTE_SHAPE)
    expect(doc.produces).toContain('as:Note')
  })

  it('lists the OAuth callback in redirect_uris and webid scope (Solid login)', () => {
    expect(doc.redirect_uris).toContain('https://elk.jeswr.org/callback.html')
    expect(doc.scope.split(' ')).toContain('webid')
  })
})

describe('federation-registry membership', () => {
  it('parses to exactly one valid, Active member naming Elk + an assertedBy authority', async () => {
    const body = readPublic('federation/registry.ttl')
    const fetchStub = (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/turtle' },
    })) as unknown as typeof fetch

    const members = await listMembers('https://elk.jeswr.org/federation/registry', {
      fetch: fetchStub,
    })
    expect(members).toHaveLength(1)
    const m = members[0]
    expect(m.valid).toBe(true)
    expect(m.membership?.status).toBe('Active')
    expect(m.membership?.app).toBe(CLIENT_ID)
    expect(m.membership?.assertedBy).toBeTruthy()
  })
})
