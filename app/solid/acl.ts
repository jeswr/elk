// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Owner-only WAC ACL writer for Elk's pod containers.
 *
 * OWNER-PRIVACY CONTRACT (load-bearing): every container Elk creates in the user's
 * pod is owner-PRIVATE by default — Elk mirrors the user's own social content, which
 * is theirs alone unless they explicitly choose to share it. The ACL grants ONLY the
 * owner WebID `acl:Read`/`acl:Write`/`acl:Control` over the container and its
 * descendants (`acl:accessTo` + `acl:default`). Nothing is public; Elk never broadens
 * access and never auto-shares.
 *
 * The ACL is built with `n3.Writer` + typed quads — NEVER hand-concatenated triples
 * (the suite house rule). We reuse `n3` via dynamic import (it ships with the @jeswr
 * RDF stack already in the dependency graph). The shape matches the proven
 * `@jeswr/matrix-chat-to-pod` owner-only ACL writer.
 *
 * The ACL MUST be written FIRST — before any data resource lands in the container —
 * so there is never a window where mirrored content exists without owner-only
 * protection.
 */

const ACL = 'http://www.w3.org/ns/auth/acl#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const HTTP_S_IRI = /^https?:\/\//

/**
 * Build an owner-only WAC ACL Turtle document for `container`, granting `ownerWebId`
 * Read/Write/Control over the container AND its descendants (`acl:accessTo` +
 * `acl:default`). Built with `n3.Writer` (typed quads, never hand-built triples).
 *
 * @param container the container URL (MUST end with `/`)
 * @param ownerWebId the owner's WebID IRI
 */
export async function buildOwnerOnlyAclTurtle(
  container: string,
  ownerWebId: string,
): Promise<string> {
  if (!container.endsWith('/'))
    throw new Error(`buildOwnerOnlyAclTurtle: container must end with "/" (got ${container})`)
  if (!HTTP_S_IRI.test(ownerWebId))
    throw new Error(`buildOwnerOnlyAclTurtle: ownerWebId must be an http(s) IRI (got ${ownerWebId})`)

  const { DataFactory, Store, Writer } = await import('n3')
  const { namedNode } = DataFactory
  const store = new Store()
  const auth = namedNode(`${container}.acl#owner`)
  store.addQuad(auth, namedNode(RDF_TYPE), namedNode(`${ACL}Authorization`))
  store.addQuad(auth, namedNode(`${ACL}agent`), namedNode(ownerWebId))
  store.addQuad(auth, namedNode(`${ACL}accessTo`), namedNode(container))
  store.addQuad(auth, namedNode(`${ACL}default`), namedNode(container))
  store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Read`))
  store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Write`))
  store.addQuad(auth, namedNode(`${ACL}mode`), namedNode(`${ACL}Control`))

  const writer = new Writer({ format: 'text/turtle', prefixes: { acl: ACL } })
  writer.addQuads([...store])
  return new Promise<string>((resolve, reject) => {
    writer.end((error: Error | null, result: string) => (error ? reject(error) : resolve(result)))
  })
}

/**
 * Write an owner-only ACL for `container` (PUT to `${container}.acl`) using the authed
 * `fetch`. Idempotent: re-writing the same ACL is harmless. Throws on a non-2xx so the
 * caller never proceeds to write data into an unprotected container.
 */
export async function writeOwnerOnlyAcl(
  fetchImpl: typeof globalThis.fetch,
  container: string,
  ownerWebId: string,
): Promise<void> {
  const aclUrl = `${container}.acl`
  const turtle = await buildOwnerOnlyAclTurtle(container, ownerWebId)
  const res = await fetchImpl(aclUrl, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle' },
    body: turtle,
  })
  if (!(res.status >= 200 && res.status < 300)) {
    throw new Error(`owner-only ACL write failed: PUT ${aclUrl} -> ${res.status} ${res.statusText}`)
  }
}
