# just-chat

A single-page chat client built with SvelteKit 5 (runes) on top of the
[Ethora / Dappros Platform](https://ethora.com): REST API for accounts and
chat management, ejabberd (XMPP over WebSocket) for real-time messaging.

## Features

- **Auth** — email sign-in and sign-up (`/login`, `/register`) with automatic
  login after registration; session and XMPP credentials in localStorage.
- **Chats** — public, group and direct (1-1) chats; create, delete (owner),
  leave; shareable room links that auto-join new members; mediated MUC
  invites accepted automatically.
- **Members** — the owner adds/removes members (`/v2/chats/users-access`);
  removed clients are kicked out instantly (XEP-0045 status codes 110+321);
  a voluntary leave is broadcast via a `<status>` marker so other clients
  drop the leaver from the member list without waiting for the backend.
- **Messaging** — live groupchat over XMPP with MAM (XEP-0313) history
  paging; links are clickable, room links open in-app.
- **Media** — file upload (`/v1/files/`) sent in the Ethora media-stanza
  format; images open in a PhotoSwipe gallery, video/audio play inline.
- **Mentions** — `@`-autocomplete in the composer, sent as XEP-0372
  references next to a plain-text body; highlighted rendering, louder
  notification sound and a "mentioned you" browser notification.
- **Message deletion** — own messages, via the Ethora `<delete>` stanza;
  MAM tombstones are filtered out of history.
- **Presence** — online occupants per room, message sounds (quiet tick for
  background messages, chime for mentions), browser notifications when the
  tab is hidden.
- **Sender identity** — names/avatars come from `/chats/my` members; senders
  who left are resolved via `/v2/chats/users` and labeled "(former member)",
  deleted accounts show as "Deleted user".

## Stack

SvelteKit 2 / Svelte 5 (SPA, `ssr = false`) · Tailwind CSS v4 · Bits UI ·
axios · @xmpp/client · PhotoSwipe

## Getting started

```sh
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PUBLIC_API_BASE_URL` | Ethora REST API base, e.g. `https://api.chat.ethora.com` |
| `PUBLIC_APP_ID` | Ethora application id (sent on login/registration) |
| `PUBLIC_XMPP_WS` | XMPP WebSocket endpoint, e.g. `wss://xmpp.chat.ethora.com/ws` |
| `PUBLIC_XMPP_HOST` | XMPP domain, e.g. `xmpp.chat.ethora.com` |
| `PUBLIC_XMPP_CONFERENCE` | MUC service domain, e.g. `conference.xmpp.chat.ethora.com` |
| `USER_EMAIL` / `USER_PASSWORD` | optional test credentials for local scripts |

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | dev server on `http://localhost:5173` |
| `npm run build` / `npm run preview` | production build / preview |
| `npm run check` | typecheck with `svelte-check` |

## Project layout

```
src/
├── lib/
│   ├── api/            # axios client + REST wrappers (auth, chats, files, users)
│   ├── components/     # dialogs (create chat, manage members, confirm)
│   ├── state/          # Svelte 5 $state modules (chats, messages, xmpp, user lookups)
│   ├── xmpp/client.ts  # XMPP connection, MUC, MAM, stanza conventions
│   ├── lightbox.ts     # PhotoSwipe wrapper
│   └── sound.ts        # synthesized notification sounds (Web Audio)
└── routes/
    ├── login, register # public auth pages
    └── (protected)/    # chat UI + profile, guarded by localStorage token
```

## Protocol notes (Ethora conventions)

Learned against the QA backend and verified live; the wire format matters
for interop with official Ethora clients:

- **Membership** = MUC/Sub subscription (`urn:xmpp:mucsub:0`), not the join
  presence. Unsubscribing **requires the `nick` attribute**, otherwise the
  backend keeps the membership. Backend membership changes propagate to
  `/chats/my` asynchronously (~10–60 s), so the UI updates local state first.
- **Media message** = body `media` + `<store>` hint + `<data isMediafile="true" …>`
  with the uploaded file's metadata.
- **Delete message** = `<body xmlns="wow"/>` + `<delete id="<archive-id>"/>`;
  the room reflects it to everyone and MAM keeps a tombstone.
- **Mentions** = XEP-0372 `<reference type="mention" begin end uri="xmpp:…"/>`
  elements; they survive both live reflection and the MAM archive.
- **Voluntary leave** is signalled with `<status>svelt-check:left-room</status>`
  inside the unavailable presence — on the wire a plain leave is otherwise
  indistinguishable from a connection drop.
