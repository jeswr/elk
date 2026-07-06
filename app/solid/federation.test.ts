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
import { buildClientIdDocument, serializeClientIdDocument } from './clientid-document'

// The LIVE production origin (Vercel). `elk.jeswr.org` is the eventual custom domain —
// regenerate the membership + this constant when it lands.
const CLIENT_ID = 'https://elk-solid.vercel.app/clientid.jsonld'
const SOCIAL_SECTOR = 'https://w3id.org/jeswr/sectors/social#sector'
const NOTE_SHAPE = 'https://w3id.org/jeswr/sectors/social/shapes#NoteShape'

function readPublic(rel: string): string {
  const url = new URL(`../../public/${rel}`, import.meta.url)
  return readFileSync(fileURLToPath(url), 'utf8')
}

describe('clientid.jsonld fedapp self-registration (origin-aware template)', () => {
  // The doc is generated origin-aware by the `/clientid.jsonld` server route from this same
  // pure template; the canonical prod membership origin is exercised here.
  const doc = buildClientIdDocument('https://elk-solid.vercel.app') as Record<string, any>

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
    expect(doc.redirect_uris).toContain('https://elk-solid.vercel.app/callback.html')
    expect(doc.scope.split(' ')).toContain('webid')
  })

  it('is ORIGIN-AWARE: the served client_id equals the served URL byte-for-byte at any origin', () => {
    // The Solid-OIDC invariant: the doc generated for an origin names itself at that origin,
    // so it can never drift from the URL the plugin computes from `location.origin`.
    for (const origin of ['https://elk.jeswr.org', 'http://localhost:3000', 'https://elk-preview.vercel.app']) {
      const d = buildClientIdDocument(origin) as Record<string, any>
      expect(d.client_id).toBe(`${origin}/clientid.jsonld`)
      expect(d.client_uri).toBe(`${origin}/`)
      expect(d.redirect_uris).toContain(`${origin}/`)
      expect(d.redirect_uris).toContain(`${origin}/callback.html`)
      // The served bytes parse back to a doc whose client_id is its own served URL.
      const parsed = JSON.parse(serializeClientIdDocument(origin))
      expect(parsed.client_id).toBe(`${origin}/clientid.jsonld`)
    }
  })

  it('rejects a non-http(s) origin (fail-closed — never a malformed client_id)', () => {
    expect(() => buildClientIdDocument('ftp://elk.example')).toThrow(/http\(s\)/)
  })
})

describe('federation-registry membership', () => {
  it('parses to exactly one valid, Active member naming Elk + an assertedBy authority', async () => {
    const body = readPublic('federation/registry.ttl')
    const fetchStub = (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/turtle' },
    })) as unknown as typeof fetch

    const members = await listMembers('https://elk-solid.vercel.app/federation/registry', {
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
