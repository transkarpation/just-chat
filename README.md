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
- **Delivery & read receipts** — own messages go `…` (sending) → `✓`
  (reached the server) → gray `✓✓` (delivered to at least one member) →
  blue `✓✓` (read by at least one member); the tooltip shows both counts.
  See [Delivery & read receipts](#delivery--read-receipts).
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
- **Delivery receipts** = bodyless groupchat message with
  `<received xmlns="urn:xmpp:receipts" id="<archive-id>"/>` and a `<store>`
  hint — see [Delivery & read receipts](#delivery--read-receipts).
- **Read markers** = bodyless groupchat message with
  `<displayed xmlns="urn:xmpp:chat-markers:0" id="<archive-id>"/>` and a
  `<store>` hint — see [Delivery & read receipts](#delivery--read-receipts).
- **Voluntary leave** is signalled with `<status>left-room</status>`
  inside the unavailable presence — on the wire a plain leave is otherwise
  indistinguishable from a connection drop.

## Delivery & read receipts

Message status shown under every own message: `…` sending → `✓` reached
the server → gray `✓✓` delivered to at least one member → blue `✓✓` read
by at least one member. Hovering the ticks shows both counts, e.g.
`Read by 2 · Delivered to 5` (reading implies receiving, so
delivered ≥ read). Everything below was verified live against the QA
ejabberd before being relied upon.

### `✓` — the server echo (no extra stanzas)

A MUC room reflects every groupchat message back to its sender, and this
ejabberd **preserves the stanza `id`** in that reflection. The client uses
that instead of a separate ack:

```xml
<!-- out -->
<message id="local-3f2a…" type="groupchat" to="room@conference…">
  <body>hello</body>
</message>

<!-- in: the echo confirms delivery to the server -->
<message id="local-3f2a…" type="groupchat" from="room@conference…/me">
  <body>hello</body>
  <stanza-id xmlns="urn:xmpp:sid:0" id="1783689048683297"/>
</message>
```

Client handling: `sendRoomMessage()` appends the message to state
immediately with `pending: true` and a `local-…` placeholder id. When the
echo arrives, the live handler matches it by the preserved stanza `id`
(`confirmMessage()`), swaps the pending copy for the confirmed one — its
real id is the `<stanza-id>` archive id — and the `…` becomes `✓`. A failed
send removes the optimistic copy.

### Gray `✓✓` — delivery receipts (XEP-0184 in a MUC)

When a client receives a live message from someone else, it answers into
the room with a bodyless stanza referencing the message's archive id:

```xml
<message type="groupchat" to="room@conference…">
  <received xmlns="urn:xmpp:receipts" id="1783689048683297"/>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

The room reflects it to every occupant (the sender's `✓` turns into `✓✓`
live) and the `<store>` hint makes MAM archive it, so the state survives
page reloads.

Client handling:

- **Sending**: on every live foreign message; plus a catch-up pass in
  `loadLastMessages()` for messages that arrived while the client was
  offline. No duplicates: a receipt is always archived *after* its message,
  so if ours exists it is inside the same MAM window we just loaded.
- **Receiving**: live receipts and archived ones (they come out of MAM as
  entries of their own) land in the message's `receivedBy` list. A receipt
  can reference a message from an older, not-yet-loaded page — those are
  parked in `pendingReceipts` and applied when paging reaches the message.

### Blue `✓✓` — read markers (XEP-0333 watermarks)

“Read” is signalled with a `displayed` marker. Watermark semantics: one
marker on the newest seen message means *everything up to and including it
has been read*, so opening a chat with any backlog costs a single stanza:

```xml
<message type="groupchat" to="room@conference…">
  <displayed xmlns="urn:xmpp:chat-markers:0" id="1783689048683297"/>
  <store xmlns="urn:xmpp:hints"/>
</message>
```

Client handling:

- **Sending** (`markRoomDisplayed()`): when a chat is opened, when a live
  message arrives in the currently open chat with the tab visible, and on
  `visibilitychange` when the user returns to the tab. It targets the
  newest non-own message and no-ops if the own watermark already covers it,
  if the tab is hidden, or while offline.
- **Receiving**: markers (live and from MAM) update a per-room map
  `displayedUpTo[nickname] = newest marked archive id`. A message counts as
  read by everyone whose watermark is `>=` its archive id — archive ids are
  chronologically sortable, so this is a plain comparison, with no
  per-message bookkeeping.
- **Rendering** (`deliveryStats()`): readers = watermarks covering the
  message; delivered = readers ∪ explicit receipts. `read > 0` paints the
  ticks blue.

### Caveats

- Receipts and markers count as MAM entries, which dilutes paging — that is
  why the sidebar-preview loader fetches 10 entries per room instead of 1.
- Only this client emits receipts/markers. Official Ethora clients don't,
  so their users never bump the counters — which is also why the group-chat
  rule is “at least one” rather than “all members”.
