// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Adapt a Mastodon `mastodon.v1.Status` (the masto.js shape Elk uses) to the structural
 * {@link MirrorableStatus} subset the pod mirror needs. Kept separate from `mirror.ts` so
 * the mirror's mapping stays decoupled from masto.js's full type (and unit-testable on the
 * minimal shape). Pure + side-effect-free.
 */

import type { MirrorableStatus } from './mirror'

/** The masto.js Status fields we read (a structural subset — avoids a hard masto type dep). */
export interface MastoStatusLike {
  id: string
  uri?: string
  url?: string | null
  content: string
  createdAt: string
  inReplyToId?: string | null
  // Some servers expose the reply target's account; we only carry the reply URI when known.
  inReplyToAccountId?: string | null
}

/**
 * Map a masto.js status to {@link MirrorableStatus}. The Mastodon API gives an
 * `inReplyToId` (a LOCAL id, not a global IRI) — we do NOT fabricate a reply IRI from it
 * (that would be a guessed, possibly-wrong URI); `inReplyToUri` is left undefined unless a
 * global URI is available. The mirror drops non-IRI reply values anyway.
 */
export function toMirrorableStatus(status: MastoStatusLike): MirrorableStatus {
  return {
    id: status.id,
    uri: status.uri,
    url: status.url ?? null,
    content: status.content,
    createdAt: status.createdAt,
    // Only carry a reply target when it is a global IRI (the masto reblog/uri path can
    // supply one); a bare local inReplyToId is not an IRI, so omit it.
    inReplyToUri: null,
  }
}
