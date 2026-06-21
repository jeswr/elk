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
| **Pod persistence** of settings/drafts/emojis | `storage.ts` + `controller.ts` | Mounts the `@jeswr/unstorage-solid` driver in a browser `createStorage()` at the pod base `…/elk/kv/`, fed the Solid session's authed `fetch`. Elk's existing `useLocalStorage` keys (`elk-settings`, `elk-drafts`, `elk-custom-emojis`) are **mirrored** into it — pull-on-connect, debounced-push-on-change — so the synchronous local read (instant paint) is kept AND the pod becomes the cross-device source of truth. No `useLocalStorage` call sites were rewritten. |
| **Solid login** (second identity) | `session.ts` + `plugins/solid.client.ts` | `@solid/reactive-authentication` `ReactiveFetchManager.registerGlobally()` patches the global `fetch` to attach DPoP-bound tokens on a pod `401`. The WebID's `solid:oidcIssuer` is resolved from its profile (WebID-first), and the app authenticates with a **static Client Identifier Document** (`/clientid.jsonld`) so the consent screen shows "Elk". Mastodon OAuth is untouched. |
| **Silent session restore** | `session.ts` + the plugin | The connected WebID is persisted (localStorage); on load the plugin reconnects silently (reactive-auth's `prompt=none` path) and re-mounts pod storage, falling back to manual login only on genuine failure (cross-app UX invariant #1). |
| **Mirror own content to the pod** | `mirror.ts` + `controller.ts` | When the user **posts** a status, it is written to an owner-private `pc:ChatRoom`-style timeline (`…/elk/timeline/`) as a `@jeswr/solid-chat-interop` **CanonicalMessage** (AS2.0 shape, `serializeAs2`). The **owner-only WAC ACL is written FIRST** (`acl.ts`, `n3.Writer`, fail-closed) — there is never a window where mirrored content is unprotected. Only the user's OWN content is mirrored. |
| **Federation registration** | `public/clientid.jsonld`, `public/federation/registry.ttl` | The Client ID doc carries an `fedapp:App` self-registration block (`fedapp:sector` = the social sector, `fedapp:produces` = the social `NoteShape` / `as:Note`). A `federation-registry` `fedreg:Membership(status:Active)` entry (built with `buildRegistry`) lists Elk as a federation member. |

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

- **App (client_id):** `https://elk.jeswr.org/clientid.jsonld` — `fedapp:App`
- **Sector:** `https://w3id.org/jeswr/sectors/social#sector`
- **Produces / consumes:** `https://w3id.org/jeswr/sectors/social/shapes#NoteShape`, `as:Note`
- **Registry:** `https://elk.jeswr.org/federation/registry`
- **Membership:** `https://elk.jeswr.org/federation/registry#elk` — `fedreg:status fedreg:Active`,
  `fedreg:app` → the client_id. `assertedBy` is a **PLACEHOLDER** maintainer WebID
  (`https://jeswr.org/profile/card#me`) — see follow-ups.

## Gate (scope)

The Solid integration modules are linted (`eslint app/solid app/plugins/solid.client.ts`),
type-checked (`nuxt typecheck`, full tree) and unit-tested with a **dedicated, fast vitest
project** (`app/solid/vitest.config.ts`, node env — Elk's root vitest boots the heavy Nuxt
test environment, which the pure Solid logic does not need):

```sh
npx vitest run --config app/solid/vitest.config.ts   # 36 tests across acl/mirror/storage/federation
```

The pure logic (status→CanonicalMessage mapping, owner-only ACL writer, the localStorage↔pod
mirror, the federation artifacts) is exhaustively unit-tested with stubbed `fetch`. The
ACL-first / fail-closed contract is tested (the message PUT never runs if the ACL write
fails). **Elk's full upstream build + its Nuxt-bound test suite were NOT re-run** as part of
this change — they are large and out of scope for the integration; the gate is scoped to the
added modules plus the full-tree typecheck.

## Follow-ups

- **Offline-first** via `@jeswr/solid-offline` (service-worker pod cache + change
  invalidation) — documented follow-up, not in the MVP.
- **`assertedBy` maintainer WebID** — the membership doc uses a placeholder; replace with the
  real registry-operator WebID before the membership is authoritative.
- **Bookmark mirror** — the post path is wired; bookmarking can call `mirrorOwnStatus`
  similarly from `app/composables/masto/status.ts` (the same controller seam).
- **Login UI** — the plugin exposes `$solid.login(webId)` / `$solid.logout()` and uses a
  minimal popup `getCode`; a WebID-first login surface (per the `solid-reactive-authentication`
  skill's UX spec, with `RememberedAccount` from `@jeswr/solid-session-restore`) is a UI task.
- **`/clientid.jsonld` host** — the doc hard-codes `https://elk.jeswr.org`; align with the
  actual deploy origin (the `client_id` must equal the served URL byte-for-byte).
- **Full upstream build/test** — run Elk's own `pnpm build` + Nuxt test suite once before any
  upstream PR.
