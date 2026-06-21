// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
//
// Serve Elk's Solid Client Identifier Document ORIGIN-AWARE.
//
// Solid-OIDC requires the served `client_id` to equal the served URL byte-for-byte. The
// Solid plugin computes `/clientid.jsonld` (+ `/callback.html`) from the CURRENT origin, so
// a doc baked with a fixed origin breaks login on every other deploy (local / preview /
// fork / alt-prod). This route therefore generates the document for the SERVING origin:
//   1. the configured public origin `NUXT_PUBLIC_ELK_ORIGIN` (set it at deploy time to pin
//      a canonical origin behind a CDN / when the public URL differs from the request host); else
//   2. the incoming request's own origin (the sensible default — the doc is then always
//      self-consistent with the URL it was fetched from).
//
// There is NO static `public/clientid.jsonld` (it would shadow this route and re-introduce
// the hard-coded-origin drift this fixes); the bytes come solely from the shared, pure
// `buildClientIdDocument` template (also used by the federation contract tests).
import { serializeClientIdDocument } from '../../app/solid/clientid-document'

export default defineEventHandler((event) => {
  const configured = process.env.NUXT_PUBLIC_ELK_ORIGIN?.trim()
  // Derive the request origin (scheme + host) from the incoming request when not configured.
  const requestOrigin = getRequestURL(event).origin
  const origin = configured && configured.length > 0 ? configured : requestOrigin

  let body: string
  try {
    body = serializeClientIdDocument(origin)
  }
  catch (err) {
    // A misconfigured NUXT_PUBLIC_ELK_ORIGIN must surface loudly, not serve a malformed doc.
    throw createError({
      statusCode: 500,
      statusMessage: `Invalid Solid client_id origin: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  setHeader(event, 'content-type', 'application/ld+json')
  // The client_id document is small + origin-stable; allow brief caching, must-revalidate.
  setHeader(event, 'cache-control', 'public, max-age=0, must-revalidate')
  return body
})
