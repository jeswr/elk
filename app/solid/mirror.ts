// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Mirror the user's own social content to their Solid pod as canonical chat messages.
 *
 * When the user POSTS a status or BOOKMARKS one, Elk writes that status into the user's
 * pod as a `@jeswr/solid-chat-interop` {@link CanonicalMessage} (the AS2.0 write shape),
 * under an owner-private `pc:ChatRoom`-style timeline container. This makes the user's
 * own fediverse output ALSO live in their personal data store — readable by every other
 * suite app (Pod Manager, pod-chat, solid-issues) through the same canonical model,
 * not siloed in a single Mastodon server.
 *
 * SECURITY / PRIVACY (load-bearing):
 * - The timeline container is OWNER-PRIVATE. The owner-only WAC ACL is written FIRST
 *   (before any message resource) via `writeOwnerOnlyAcl` — there is never a window
 *   where mirrored content exists unprotected. Elk never broadens access / auto-shares.
 * - Only the USER'S OWN content is mirrored — the user's own posts and the user's own
 *   bookmarks (their curated saves), never arbitrary third-party statuses from the feed.
 * - The status HTML `content` is mapped to a `mediaType: text/html` body verbatim; we do
 *   NOT execute or re-render it on write. (Untrusted HTML is the author's own here, but
 *   the mediaType is recorded honestly so readers know it is HTML, not plain text.)
 *
 * The status→CanonicalMessage mapping mirrors the shape `@jeswr/solid-granary` uses for
 * AS2 social objects (granary maps `format=as2` → CanonicalMessage; a Mastodon Status is
 * the same AS2-shaped object), kept as a thin, well-tested pure function.
 *
 * Browser-only side (the pod write); the mapping is pure and unit-tested.
 */

import type { CanonicalMessage } from '@jeswr/solid-chat-interop'
import { serializeAs2 } from '@jeswr/solid-chat-interop'
import { writeOwnerOnlyAcl } from './acl'

/** The minimal Mastodon-status shape the mapping needs (a structural subset). */
export interface MirrorableStatus {
  /** Status id (local to the source server). */
  id: string
  /** The canonical ActivityPub URI of the status (a global IRI). */
  uri?: string
  /** The status's web URL (used as a fallback derivedFrom). */
  url?: string | null
  /** HTML-encoded status content. */
  content: string
  /** ISO-8601 created timestamp. */
  createdAt: string
  /** The reply-target status URI/URL, if this is a reply. */
  inReplyToUri?: string | null
}

/** The room/timeline name Elk uses under the pod base. */
export const TIMELINE_CONTAINER = 'timeline/'

/** Strip leading slashes from a slug (module-scoped to avoid per-call recompilation). */
const LEADING_SLASHES = /^\/+/
/** Collapse slug characters not safe in a resource name to `-`. */
const UNSAFE_SLUG_CHARS = /[^\w.-]+/g

/** http(s)-IRI filter — a mirrored IRI field must be an absolute http(s) IRI or dropped. */
function httpIri(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string')
    return undefined
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:' ? value : undefined
  }
  catch {
    return undefined
  }
}

/** Validate + normalise an ISO-8601 timestamp; drop (don't fail) an unparseable one. */
function isoDate(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * Map a Mastodon-style status to a canonical chat message. PURE + side-effect-free, so
 * it is exhaustively unit-testable without a pod. `authorWebId` is the OWNER's Solid
 * WebID (this is the user's OWN content, attributed to their WebID — not the Mastodon
 * acct). `roomIri` is the timeline collection IRI.
 *
 * Untrusted-input hardening: IRI-valued fields are http(s)-filtered; a bad value is
 * DROPPED, never fatal. Content is carried as `text/html` (the Mastodon status shape).
 */
export function statusToCanonical(
  status: MirrorableStatus,
  authorWebId: string,
  roomIri: string,
): CanonicalMessage {
  const msg: CanonicalMessage = {
    content: typeof status.content === 'string' ? status.content : '',
    mediaType: 'text/html',
  }
  const author = httpIri(authorWebId)
  if (author)
    msg.author = author
  const room = httpIri(roomIri)
  if (room)
    msg.room = room
  const published = isoDate(status.createdAt)
  if (published)
    msg.published = published
  const inReplyTo = httpIri(status.inReplyToUri)
  if (inReplyTo)
    msg.inReplyTo = inReplyTo
  // Record the source permalink as PROV-O derivedFrom so a re-mirror is idempotent and
  // the origin is traceable (the status's canonical AP uri preferred, web url fallback).
  const derivedFrom = httpIri(status.uri) ?? httpIri(status.url)
  if (derivedFrom)
    msg.provenance = { derivedFrom }
  return msg
}

/**
 * A stable, filesystem-safe resource slug for a status — derived from its source uri/url
 * (so a re-mirror of the SAME status overwrites in place, idempotent) else its id. FNV-1a
 * over the seed; a naming token, not a security primitive.
 */
export function statusSlug(status: MirrorableStatus): string {
  const seed = httpIri(status.uri) ?? httpIri(status.url) ?? status.id ?? ''
  let h = 0x811C9DC5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `status-${h.toString(16).padStart(8, '0')}.ttl`
}

/**
 * Validate + normalise a pod-base URL into a canonical container address: an absolute
 * http(s) URL with exactly one trailing `/`, no query, no fragment.
 *
 * SECURITY (untrusted-RDF hardening): `podBase` is derived (via `resolveStorageRoot` +
 * the `ELK_POD_NAMESPACE` suffix) from the user's WebID profile — attacker-influenced
 * input, not trusted config. The naive `podBase.endsWith('/') ? podBase : podBase + '/'`
 * this replaces trusts the RAW string: a value like `https://evil.example/foo?x=/` (or
 * `#/`) already "ends with /" via its query/fragment while its actual path does not, so
 * the old check silently accepted it and the caller then concatenated
 * `TIMELINE_CONTAINER` onto a completely different resource than intended. Parsing via
 * `new URL()` and rejecting any `search`/`hash` closes that: the trailing slash can only
 * come from the real pathname.
 *
 * @throws Error if `podBase` is not a parseable absolute http(s) URL, or carries a
 * query/fragment.
 */
function normalizePodBase(podBase: string): string {
  let url: URL
  try {
    url = new URL(podBase)
  }
  catch {
    throw new TypeError(`mirrorStatus: podBase is not a valid absolute URL: ${podBase}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError(`mirrorStatus: podBase must be http(s), got: ${podBase}`)
  if (url.search !== '' || url.hash !== '')
    throw new TypeError(`mirrorStatus: podBase must not carry a query/fragment: ${podBase}`)
  if (!url.pathname.endsWith('/'))
    url.pathname = `${url.pathname}/`
  return url.toString()
}

/** Join a container (ending `/`) and a slug into a child resource URL that cannot escape it. */
export function timelineResourceUrl(container: string, slug: string): string {
  const base = container.endsWith('/') ? container : `${container}/`
  const cleaned = slug.replace(LEADING_SLASHES, '').replace(UNSAFE_SLUG_CHARS, '-')
  if (cleaned.length === 0)
    throw new Error(`statusSlug produced an empty slug for container ${base}`)
  const resolved = new URL(cleaned, base).toString()
  if (!resolved.startsWith(base) || resolved === base)
    throw new Error(`slug "${slug}" does not resolve to a child of ${base}`)
  return resolved
}

/** Options for {@link mirrorStatus}. */
export interface MirrorStatusOptions {
  /** The authed (DPoP/WebID) fetch — every pod request goes through it. */
  fetch: typeof globalThis.fetch
  /** The owner's Solid WebID — author + ACL grantee. */
  webId: string
  /** The pod base container Elk owns (ends with `/`), e.g. `https://alice.pod/elk/`. */
  podBase: string
  /**
   * When `true` (default), ensure the owner-only ACL is written on the timeline
   * container before the message. Set `false` only if the caller has already guaranteed
   * the container is owner-private this session (the controller dedups it).
   */
  ensureAcl?: boolean
}

/** The outcome of a single mirror write. */
export interface MirrorResult {
  /** The resource URL written. */
  url: string
  /** `true` on a 2xx PUT. */
  written: boolean
  /** HTTP status, when received. */
  status?: number
}

/**
 * Mirror one status to the pod timeline. Writes the owner-only ACL FIRST (when
 * `ensureAcl`), then PUTs the status as an AS2 canonical message. Returns the result;
 * throws on ACL failure (fail-closed — never write data into an unprotected container).
 */
export async function mirrorStatus(
  status: MirrorableStatus,
  options: MirrorStatusOptions,
): Promise<MirrorResult> {
  const { fetch: fetchImpl, webId, podBase, ensureAcl = true } = options
  const base = normalizePodBase(podBase)
  // Resolve the sub-container via `new URL(child, base)`, never string concatenation — a
  // `podBase` that carries a query/fragment forged its trailing "/" (see
  // `normalizePodBase`'s reject rule); resolving through URL rather than concatenation means
  // a malformed base can no longer smuggle the mirror write onto an unintended resource.
  const container = new URL(TIMELINE_CONTAINER, base).toString()

  if (ensureAcl) {
    // Fail-closed: if the ACL cannot be written, do NOT write the message.
    await writeOwnerOnlyAcl(fetchImpl, container, webId)
  }

  const room = `${container}#timeline`
  const msg = statusToCanonical(status, webId, room)
  const url = timelineResourceUrl(container, statusSlug(status))
  const subject = `${url}#it`
  const body = await serializeAs2(msg, subject)

  const res = await fetchImpl(url, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle' },
    body,
  })
  return { url, written: res.status >= 200 && res.status < 300, status: res.status }
}
