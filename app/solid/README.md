<!-- AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate. -->
# Elk × Solid — pod-backed persistence + a second (Solid) identity

This directory adds an OPTIONAL [Solid](https://solidproject.org) integration to Elk: a
user can connect their personal **Solid pod** alongside their Mastodon login (two
identities). It is **entirely additive** — every module is a no-op for users who never
connect a pod, so Elk behaves exactly as upstream for them.

It is the cleanest showcase of [`@jeswr/unstorage-solid`](https://github.com/jeswr/unstorage-solid):
Elk's settings/drafts go through a KV layer, so backing that KV with a pod persists them
to the user's own data store with minimal call-site changes.

## What it does

| Feature | Module | How |
|---|---|---|
| **Pod persistence** of settings/drafts/emojis | `storage.ts` + `controller.ts` | Mounts the `@jeswr/unstorage-solid` driver in a browser `createStorage()` at the pod base `…/elk/kv/`, fed the Solid session's authed `fetch`. The **owner-only WAC ACL on `…/elk/kv/` is established FIRST** (`ensureKvAcl`, memoised + fail-closed) before the storage is mounted, so private client state never lands in an unprotected container. Elk's existing `useLocalStorage` keys (`elk-settings`, `elk-drafts`, `elk-custom-emojis`) are **mirrored** into it — pull-on-connect, then **debounced-push-on-change** (a `watchMirroredKeys` listener on the `storage` event VueUse dispatches, so ongoing edits — not just the initial hydrate — persist) — so the synchronous local read (instant paint) is kept AND the pod becomes the cross-device source of truth. No `useLocalStorage` call sites were rewritten. |
| **Solid login** (second identity) | `session.ts` + `plugins/solid.client.ts` | `@solid/reactive-authentication` `ReactiveFetchManager.registerGlobally()` patches the global `fetch` to attach DPoP-bound tokens on a pod `401`. The WebID's `solid:oidcIssuer` is resolved from its profile (WebID-first), and the app authenticates with an **origin-aware Client Identifier Document** (`/clientid.jsonld`, see below) so the consent screen shows "Elk". Mastodon OAuth is untouched. |
| **Silent session restore** | `session.ts` (`silentRestore`) + the plugin | On load the plugin attempts a **SILENT-only** restore: it redeems the persisted DPoP-bound refresh token via a token-endpoint `fetch` (`@jeswr/solid-session-restore` `restoreSession`/`decideSilentRestore`) — **no popup, no redirect, no iframe**. On success it mounts pod storage; on ANY failure it leaves the user **logged-out** and defers interactive login to an explicit user action (it never auto-opens the login popup). Cross-app UX invariant #1. |
| **Mirror own content to the pod** | `mirror.ts` + `controller.ts` | When the user **posts** a status, it is written to an owner-private `pc:ChatRoom`-style timeline (`…/elk/timeline/`) as a `@jeswr/solid-chat-interop` **CanonicalMessage** (AS2.0 shape, `serializeAs2`). The **owner-only WAC ACL is written FIRST** (`acl.ts`, `n3.Writer`, fail-closed) — there is never a window where mirrored content is unprotected. Only the user's OWN content is mirrored. |
| **Federation registration** | `clientid-document.ts` (served via `server/routes/clientid.jsonld.get.ts`), `public/federation/registry.ttl` | The Client ID doc carries an `fedapp:App` self-registration block (`fedapp:sector` = the social sector, `fedapp:produces` = the social `NoteShape` / `as:Note`). A `federation-registry` `fedreg:Membership(status:Active)` entry lists Elk as a federation member. |

### Origin-aware Client Identifier Document

Solid-OIDC requires the served `client_id` to equal the served URL **byte-for-byte**. The plugin
computes `/clientid.jsonld` + `/callback.html` from the **current origin**, so a doc baked with a
fixed origin breaks login on local/preview/fork/alt-prod. The doc is therefore generated from the
pure `buildClientIdDocument(origin)` template (`clientid-document.ts`) and **served origin-aware**
by the `/clientid.jsonld` server route, which uses the configured `NUXT_PUBLIC_ELK_ORIGIN` env when
set (pin a canonical origin behind a CDN / when the public URL differs from the request host),
else the incoming request's own origin. There is **no committed static `public/clientid.jsonld`**
(it would shadow the route and re-introduce the drift). The federation contract tests assert the
byte-for-byte origin invariant across several origins.

## Architecture — why a mirror, not a storage swap

Elk reads its client state **synchronously** from `localStorage` on boot (instant paint).
A pod is async + remote. So we do not replace Elk's storage; we **mirror** the localStorage
keys to the pod behind the existing synchronous read (stale-while-revalidate): `localStorage`
stays the instant cache, the pod is the durable cross-device copy. This keeps the showcase's
defining property — `@jeswr/unstorage-solid` registered as a real unstorage driver — while
honouring Elk's instant-load UX.

`controller.ts` is the single seam the rest of Elk calls (`mirrorOwnStatus`,
`schedulePodSync`); everything is a no-op when no pod is connected, so the call sites are
safe to add unconditionally. The only edit to Elk's own code is **one fire-and-forget line**
in `app/composables/masto/publish.ts` after a successful post.

## Federation IRIs registered

The LIVE production origin is `https://elk-solid.vercel.app` (deployed 2026-07-06,
`NUXT_PUBLIC_ELK_ORIGIN` pinned; the served doc is origin-aware — at any other deploy
origin every origin-bearing IRI below is rebased to that origin). `elk.jeswr.org` is the
eventual custom domain — regenerate the membership when it lands:

- **App (client_id):** `https://elk-solid.vercel.app/clientid.jsonld` — `fedapp:App`
- **Sector:** `https://w3id.org/jeswr/sectors/social#sector`
- **Produces / consumes:** `https://w3id.org/jeswr/sectors/social/shapes#NoteShape`, `as:Note`
- **Registry:** `https://elk-solid.vercel.app/federation/registry`
- **Membership:** `https://elk-solid.vercel.app/federation/registry#elk` — `fedreg:status fedreg:Active`,
  `fedreg:app` → the client_id, `fedreg:assertedBy` → the maintainer WebID
  (`https://jeswr.org/#me`).

## Gate (scope)

The Solid integration modules are linted (`eslint app/solid app/plugins/solid.client.ts`),
type-checked (`nuxt typecheck`, full tree) and unit-tested with a **dedicated, fast vitest
project** (`app/solid/vitest.config.ts`, node env — Elk's root vitest boots the heavy Nuxt
test environment, which the pure Solid logic does not need):

```sh
npx vitest run --config app/solid/vitest.config.ts   # 57 tests across acl/mirror/storage/controller/session/federation
```

The pure logic (status→CanonicalMessage mapping, owner-only ACL writer, the localStorage↔pod
mirror, the origin-aware client-id template, the federation artifacts) is exhaustively
unit-tested with stubbed `fetch`. The security-critical contracts are tested: the **kv/ +
timeline ACL-first / fail-closed** invariant (a value/message PUT never runs if the ACL write
fails), the **ongoing change→pod-sync** wiring (a mirrored-key edit triggers a debounced pod
write), and the **silent-restore-never-popups** invariant (the restore path uses only the
refresh-grant seam and never opens an interactive popup). **Elk's full upstream build + its
Nuxt-bound test suite were NOT re-run** as part of this change — they are large and out of
scope for the integration; the gate is scoped to the added modules plus the full-tree typecheck.

## Deploying to Vercel (the prebuilt path — REQUIRED)

A remote Vercel build (`vercel deploy` without `--prebuilt`) ships a BROKEN app: Elk's
build runs the vite client build twice (prerender pass, then the final PWA pass) with a
diverging chunk-hash subtree, and the final `.vercel/output/static/_nuxt` snapshot keeps
only the second pass — so the prerendered HTML's entry + ~20 chunks 404 in production
(observed live 2026-07-06, ~100 missing chunks). Until that upstream quirk is fixed,
deploy PREBUILT from a local build:

```sh
NUXT_PUBLIC_ELK_ORIGIN=https://elk-solid.vercel.app NUXT_STORAGE_DRIVER=memory \
  NITRO_PRESET=vercel pnpm build
# verify every /_nuxt chunk referenced by .vercel/output/static/**/*.html exists;
# copy any missing (content-hash-named, so byte-identical) from a plain-build's
# .output/public/_nuxt/ into .vercel/output/static/_nuxt/
npx vercel deploy --prebuilt --prod --yes
```

Production project `elk-solid` env: `NUXT_PUBLIC_ELK_ORIGIN` (pins the served
`client_id` origin), `NUXT_STORAGE_DRIVER=memory` (serverless FS is read-only; durable
Mastodon app-registration storage — Vercel KV / Cloudflare KV — is a follow-up).

## Follow-ups

- **Offline-first** via `@jeswr/solid-offline` (service-worker pod cache + change
  invalidation) — documented follow-up, not in the MVP.
- ~~**`assertedBy` maintainer WebID**~~ — DONE (go-live 2026-07-06): the membership is asserted
  by the maintainer WebID `https://jeswr.org/#me`.
- **Bookmark mirror** — the post path is wired; bookmarking can call `mirrorOwnStatus`
  similarly from `app/composables/masto/status.ts` (the same controller seam).
- **Login UI** — the plugin exposes `$solid.login(webId)` / `$solid.logout()` and uses a
  minimal popup `getCode` (interactive login only, never on restore); a WebID-first login
  surface (per the `solid-reactive-authentication` skill's UX spec, with `RememberedAccount`
  from `@jeswr/solid-session-restore`) is a UI task.
- **Login-time credential persistence** — silent restore redeems a DPoP-bound refresh token
  from the `@jeswr/solid-session-restore` IndexedDB store. reactive-auth's MVP popup flow does
  not yet persist one there, so a silent restore currently resolves to logged-out (no popup —
  the correct fail-closed behaviour). Wiring the login path to persist a `PersistedSession`
  (the package's `IndexedDbSessionStore`) makes the silent reconnect actually succeed.
- **Full upstream build/test** — run Elk's own `pnpm build` + Nuxt test suite once before any
  upstream PR.
