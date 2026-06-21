// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate.
/**
 * Public surface of Elk's Solid integration (the `~/solid` barrel).
 *
 * See `app/solid/README.md` for the architecture. Import the controller seams + session
 * state from here; the plugin (`app/plugins/solid.client.ts`) wires them at boot.
 */

export { buildOwnerOnlyAclTurtle, writeOwnerOnlyAcl } from './acl'
export {
  clearPodStorage,
  ensureKvAcl,
  kvAclEnsured,
  mirrorOwnStatus,
  podConnected,
  schedulePodSync,
  setPodStorage,
  unwatchMirroredKeys,
  watchMirroredKeys,
} from './controller'
export type { MirrorableStatus, MirrorResult } from './mirror'
export { mirrorStatus, statusToCanonical } from './mirror'
export {
  connectSolid,
  disconnectSolid,
  ELK_POD_NAMESPACE,
  ELK_REMEMBERED_ACCOUNT_KEY,
  ELK_SESSION_DB_NAME,
  persistedSolidWebId,
  resolveOidcIssuer,
  resolveStorageRoot,
  silentRestore,
  solidConnected,
  solidFetch,
  solidPodBase,
  solidRestoring,
  solidWebId,
} from './session'
export { toMirrorableStatus } from './status-adapter'
export {
  createPodStorage,
  MIRRORED_KEYS,
  type MirroredKey,
} from './storage'
