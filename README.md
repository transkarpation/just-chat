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
  format; several files can go in one message with an optional text caption;
  images open in a PhotoSwipe gallery, video/audio play inline.
- **Mentions** — `@`-autocomplete in the composer, sent as XEP-0372
  references next to a plain-text body; highlighted rendering, louder
  notification sound and a "mentioned you" browser notification.
- **Reactions** — emoji reactions on any message (XEP-0444); a hover picker
  and reaction chips with per-emoji counts. See [Reactions](#reactions).
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
  with the uploaded file's metadata. This client extends the format (while
  staying compatible with the single-file shape): one `<data>` element per
  attached file, and the body may carry a text caption instead of the
  literal `media` — see [Media messages](#media-messages).
- **Delete message** = `<body xmlns="wow"/>` + `<delete id="<archive-id>"/>`;
  the room reflects it to everyone and MAM keeps a tombstone.
- **Mentions** = XEP-0372 `<reference type="mention" begin end uri="xmpp:…"/>`
  elements; they survive both live reflection and the MAM archive.
- **Reactions** = XEP-0444 `<reactions id="<archive-id>"><reaction>…</reaction></reactions>`
  carrying a reactor's full emoji set (an empty element clears it). Archived
  as **standalone entries**, not a rewrite of the target — see
  [Reactions](#reactions).
- **Delivery receipts** = bodyless groupchat message with
  `<received xmlns="urn:xmpp:receipts" id="<archive-id>"/>` and a `<store>`
  hint — see [Delivery & read receipts](#delivery--read-receipts).
- **Read markers** = bodyless groupchat message with
  `<displayed xmlns="urn:xmpp:chat-markers:0" id="<archive-id>"/>` and a
  `<store>` hint — see [Delivery & read receipts](#delivery--read-receipts).
- **Voluntary leave** is signalled with `<status>left-room</status>`
  inside the unavailable presence — on the wire a plain leave is otherwise
  indistinguishable from a connection drop.

## Media messages

Attachments are uploaded to `POST /v1/files/` first; the chat message then
only carries their metadata. The classic Ethora shape is one file per
message: the body is the literal `media` and the metadata sits in a single
`<data isMediafile="true" …>` element. This client extends that in two
backward-compatible ways — several files ride in one message as **one
`<data>` element each**, and the body may carry a **text caption** instead
of the literal `media`:

```xml
<message id="send-media-message:fcc6…" type="groupchat" to="room@conference…">
  <body>look at these two</body>            <!-- caption; "media" = no caption -->
  <store xmlns="urn:xmpp:hints"/>
  <data isMediafile="true" expiresAt="0"
        location="https://files…/a62a….jpg" locationPreview="https://files…/6a51….jpg"
        mimetype="image/jpeg" originalName="one.jpg" size="68980"
        isReply="false" showInChannel="false" mainMessage="" push="true"/>
  <data isMediafile="true" expiresAt="0"
        location="https://files…/b73b….jpg" locationPreview="https://files…/7b62….jpg"
        mimetype="image/jpeg" originalName="two.jpg" size="41656"
        isReply="false" showInChannel="false" mainMessage="" push="true"/>
</message>
```

Verified live against the QA ejabberd: a multi-`<data>` stanza survives both
the MUC reflection and the MAM archive with all elements and the caption
intact.

Client handling:

- **Sending**: files picked via 📎 are uploaded immediately and staged next
  to the composer (thumbnails/chips with a remove button); Send ships them
  all in a single message with the typed text as the caption.
- **Receiving**: the parser collects *all* `<data isMediafile="true">`
  children into the message's `media` list, so the official single-file
  format is just the one-element case. A body other than `media` is the
  caption.
- **Rendering**: images form a fixed-width (400px) collage — 2 side by
  side, 3 as one tall + two stacked, 4 as a 2×2 grid, more than 4 as a 2×2
  grid with a “+N” veil (the hidden ones are reachable by swiping in the
  PhotoSwipe gallery). Non-image files are listed below the images with a
  download button that fetches the file as a blob (no tab flash);
  video/audio play inline. The caption renders under the attachments.

## Reactions

Emoji reactions follow XEP-0444, sent as a groupchat stanza referencing the
target message's archive id. The `<reactions>` element carries the reactor's
**complete** current set of reactions (adding or removing one re-sends the
whole set); an empty element clears them. The emoji travel as shortcodes
(`fire`, `heart`, …); a `<store>` hint archives the stanza.

```xml
<message id="message-reaction:1783874025962" type="groupchat" to="room@conference…">
  <reactions id="1783612069420353" from="…@xmpp…" xmlns="urn:xmpp:reactions:0">
    <reaction>fire</reaction>
  </reactions>
  <data senderFirstName="Emily" senderLastName="Johnson"/>
  <store xmlns="urn:xmpp:hints"/>
</message>

<!-- removing all of this user's reactions: an empty <reactions/> -->
<reactions id="1783612069420353" from="…@xmpp…" xmlns="urn:xmpp:reactions:0"/>
```

Verified live against the QA ejabberd: the room reflects the reaction to every
occupant, and MAM archives **each reaction change as its own standalone entry**
(with its own `<stanza-id>`) — it does *not* rewrite the target message. So the
current reactions are reconstructed by replaying those entries.

Client handling:

- **State**: per message, a map `reactor nickname → their emoji shortcodes`.
  Because MAM keeps every change as a separate, out-of-order-loadable entry,
  each reactor's set is applied **last-writer-wins** by the reaction stanza's
  own archive id, so paging older history never resurrects a stale set. A
  reaction whose target message is not loaded yet is parked (like a receipt)
  and applied when the message arrives.
- **Sending** (`setRoomReaction`): clicking a chip or a picker emoji toggles it
  in the user's set and sends the new full set; applied optimistically, then
  the server echo (with a real archive id) overrides it.
- **Rendering**: a hover 🙂 picker on every message; chips under the bubble
  show each emoji with a count, the user's own reactions highlighted, and the
  reactors' names in the tooltip. Unknown incoming shortcodes render as their
  raw text, so reactions from other clients degrade gracefully.

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
