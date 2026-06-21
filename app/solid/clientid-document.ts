// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * The origin-aware Solid Client Identifier Document for Elk.
 *
 * THE INVARIANT (Solid-OIDC): the served `client_id` MUST equal the served URL
 * byte-for-byte at whatever origin the app is deployed to. A hard-coded origin breaks
 * Solid login on local/preview/fork/alt-prod deploys (the plugin computes
 * `/clientid.jsonld` + `/callback.html` from the CURRENT origin, so a doc baked with a
 * different origin can never match). So the document is generated from THIS function for a
 * single configured origin, and served origin-aware by the `/clientid.jsonld` server route
 * (which derives the origin from the configured `NUXT_PUBLIC_ELK_ORIGIN` env, else the
 * incoming request origin). There is no committed static copy to drift.
 *
 * This module is pure (no I/O) so it is shared by the server route AND the federation
 * contract tests, and is trivially unit-testable for the byte-for-byte origin contract.
 */

/** The federation sector + shape IRIs Elk registers under (origin-independent w3id IRIs). */
export const ELK_FED_SECTOR = 'https://w3id.org/jeswr/sectors/social#sector'
export const ELK_FED_NOTE_SHAPE = 'https://w3id.org/jeswr/sectors/social/shapes#NoteShape'

/**
 * Normalise an origin string to a bare `scheme://host[:port]` with NO trailing slash, so
 * `${origin}/clientid.jsonld` is well-formed regardless of how the caller passed it.
 * Throws on a non-http(s) / unparseable origin (fail-closed — a bad origin must not yield
 * a malformed client_id).
 */
export function normaliseOrigin(origin: string): string {
  const u = new URL(origin)
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new Error(`clientid origin must be http(s) (got ${origin})`)
  return u.origin
}

/**
 * Build Elk's Client Identifier Document for `origin`. Every origin-bearing field
 * (`client_id`, `client_uri`, `logo_uri`, `redirect_uris`) is derived from the SAME
 * `origin`, so the served `client_id` equals the served URL byte-for-byte at that origin.
 * The `@context`, federation block, and OAuth metadata are origin-independent.
 */
export function buildClientIdDocument(origin: string): Record<string, unknown> {
  const o = normaliseOrigin(origin)
  return {
    '@context': [
      'https://www.w3.org/ns/solid/oidc-context.jsonld',
      {
        fedapp: 'https://w3id.org/jeswr/fed#',
        acl: 'http://www.w3.org/ns/auth/acl#',
        as: 'https://www.w3.org/ns/activitystreams#',
        sectors: 'https://w3id.org/jeswr/sectors/',
        App: 'fedapp:App',
        sector: { '@id': 'fedapp:sector', '@type': '@id' },
        access: { '@id': 'fedapp:access', '@type': '@id', '@container': '@set' },
        consumes: { '@id': 'fedapp:consumes', '@type': '@id', '@container': '@set' },
        produces: { '@id': 'fedapp:produces', '@type': '@id', '@container': '@set' },
      },
    ],
    'client_id': `${o}/clientid.jsonld`,
    'client_name': 'Elk (Solid edition)',
    'client_uri': `${o}/`,
    'logo_uri': `${o}/elk.svg`,
    'redirect_uris': [`${o}/`, `${o}/callback.html`],
    'grant_types': ['authorization_code', 'refresh_token'],
    'response_types': ['code'],
    'scope': 'openid profile offline_access webid',
    'token_endpoint_auth_method': 'none',

    '@type': 'App',
    'sector': ELK_FED_SECTOR,
    'access': ['acl:Read', 'acl:Write', 'acl:Control'],
    'produces': [ELK_FED_NOTE_SHAPE, 'as:Note'],
    'consumes': [ELK_FED_NOTE_SHAPE, 'as:Note'],
  }
}

/** Serialise the document as canonical pretty JSON (the bytes the route serves). */
export function serializeClientIdDocument(origin: string): string {
  return `${JSON.stringify(buildClientIdDocument(origin), null, 2)}\n`
}
