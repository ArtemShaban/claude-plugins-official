# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading, `message_thread_id` (forum topic id from the inbound meta; omit for General / DM) and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `download_attachment` | Download a file of an inbound message (`attachment_file_id` from the inbound meta) to the local inbox; returns the path to Read. Telegram caps bot downloads at 20 MB. A voice the plugin is re-fetching itself (`voice_pending="1"`, see «Voice journal») is refused at once with a fixed error — its text comes as a late message. |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |
| `secretary_watch` | This fork only: subscribe to / unsubscribe from a chat on the owner's secretary list (see «Secretary» below). |

The plugin sends no typing indicator on receipt; in this fork "typing…" is driven from outside the plugin.

## «Да / Нет» buttons (this fork, D-890)

`reply` with `yes_no: true` puts one row of two buttons, «Да» «Нет», under a binary question
(on the last chunk of a long text). On where the core setting `yes-no-buttons` is on —
core default (`tools/config-defaults.json`) or the person's sam-data override, resolved by
`python3 ~/Workspace/ClaudeProjects/sam-core/tools/sam_data.py config-get yes-no-buttons`;
off, or not resolvable → the text goes plain and the result says the buttons are off. Refused together with `checklist`, `files`, `voice`,
`as_owner_to`.

A press counts only from the owner (`user.telegram_chat_id`; the lock's owner in locked
mode) or a co-owner, in their own DM or a group of the access list that lets them in (the
group's gate lets their reaction through: `allowFrom` empty or naming them, not
`wakeOnMention:false`, not `team:true`; D-1049). The send asks the same rule (`yes-no.ts` `pressCounts` /
`buttonsCanCount`): into a chat where no such press could count the text goes plain and the
result says a press would not count in this chat. Each press writes one line to
`buttons.log` in the state dir (chat kind and id, topic, message id, data, who = owner /
co-owner / other, outcome, whether the toast, edit or notification failed — never text, a
username, a token or another person's id). It reaches the session as the same `event="reaction"` envelope his
👍/👎 makes (`reaction_added` 👍 for «Да», 👎 for «Нет»; `chat_id` = the chat it was pressed in) plus `via="button"`; the buttons
turn into one inert «✅ Да» / «❌ Нет». Captions and toasts follow config `user.language` as it is at
that moment (ru / en / id, else en; `ui-lang.ts`); the envelope stays «Да» / «Нет» in every language. A press never feeds the secretary preview or the
signed approval channel. Core's 👍 check (`tools/owner_approval.py`) refuses an envelope with
`via` by default (Telegram access, door teardown); only `admin invite-mint` opts in, where
«Да» counts as his 👍 and a later «Нет» revokes it. Code: `yes-no.ts`.

### «Готово» button

`reply` with `done_button: "<label>"` puts one button under a message that asks the person
to do something with their own hands — «Готово», or a label that fits the task («Вошёл»,
«Оплатил»); one line, at most 32 characters. Same switch (`yes-no-buttons`) and the same
press rules as «Да / Нет»; off → plain text, the result says «button off, answer by text».
Refused together with `yes_no`, `checklist`, `files`, `voice`, `as_owner_to`. A press
arrives as the same reaction envelope with `reaction_added` ✅ and `via="button"` — never
👍, so «done» can never pass as «yes» — and the button turns into an inert «✅ <label>».
✅ is not a reaction a person can set by hand (Bot API `ReactionTypeEmoji` list).

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## Voice journal

Every inbound voice the bridge tries to transcribe leaves one line in
`~/.claude/channels/telegram/voice.log` (`TELEGRAM_STATE_DIR`; mode 0600, append-only,
no rotation) — the plugin's stderr is not kept anywhere durable. One line, key=value:

```
2026-11-09T01:17:47.123Z pid=735 chat=22276 msg=44440 size=12345 dur_s=7 dl=ok dl_ms=400 tr=empty tr_ms=2800 tr_len=0 outcome=placeholder:empty total_ms=3300 dl_att=1 dl_win=1 gf_ms=310 fx_ms=90 dl_phase=done probe_ms=- late_tries=-
```

`dl` / `tr` = `ok` · `none` (no file: over the cap, no file_path) · `empty` (no words) · an
error class (`timeout`, `network`, `http_<code>`, `exit_<code>`, `sys_<CODE>`, `error`); `-` = the
leg did not run. `outcome` = `bridge` (the session got the transcript) or
`placeholder:<no_cmd|download|transcribe|empty|timeout>` (it got `(voice message)`, or the caption alone) or, for a
voice re-fetched late (below), its one closing line `late:<bridge|failed|abandoned|undelivered>`. Never the
transcript, the caption, a path or an error text. Code: `voice-delivery.ts` (`formatVoiceLine`).

Download keys (D-1066), appended to the same line:
`dl_att=<1|-> dl_win=<1|-> gf_ms=<getFile ms> fx_ms=<file GET ms>
dl_phase=<done|getfile|headers|body> probe_ms=<ms|timeout|error|-> late_tries=<1..6|->`. Since D-1087 there is one
attempt, so `dl_att` is always 1. `dl_phase` = where the download was when the voice stopped waiting; `probe_ms` =
one bare TCP connect to api.telegram.org:443, made on its own when the file GET has no headers after 8 s (it starts
nothing else). Reading a stall: `probe_ms` fast + `getfile` → Telegram's side; `probe_ms` slow / `timeout` → our
network path. The core control-plane leg `tg-voice-delivery` reads this file.

**Late re-fetch (D-1087).** A voice whose download ended without a file on a Telegram/network-side class (`timeout`,
`network`, `error`, `sys_*`, `http_5xx`, `http_429`; never `none` or another 4xx), with a transcribe command set, is
delivered in its place as the placeholder with `voice_pending="1"` and the author/trust keys (every voice placeholder
carries `voice_author`, `voice_author_id` when known, `voice_author_origin`, `voice_trust`). The re-fetch is armed only
after the session accepted that placeholder's wake. The plugin then runs the same download + transcribe again at +2,
+5, +10, +20, +40 and +60 min, in memory, outside the chat's queue (texts sent after the voice are never held); someone
else's voice is fetched through the chat store with one Bot API request per try (no inbox fallback on a late try). The
whole re-fetch ends 70 min after the placeholder: then a whisper job still queued never starts and a running one is
killed, and the lost notice goes out; a transcript that arrives before +70 min is still delivered. A notification the
session has still not answered at +70 min (or 30 s after it started, if it started later) closes the voice as
`late:undelivered` (a later answer changes nothing). A message's retry is reserved per chat+message, so two
messages sharing one Telegram file_id are both re-fetched; a placeholder wake the session did not accept writes
`late:undelivered` at once and arms nothing. A transcript → one more notification with the same `message_id` and `ts`, `transcript_source="bridge"`, the
author keys and `voice_late_s=<seconds since the voice>`. A file that came but whisper failed or gave nothing, six
failed tries, or the 70-min end → one notification with `voice_lost="1"`. Each such voice gets one closing line, written
once the session accepted that notification: `late:bridge` / `late:failed`; `late:undelivered` when the session did
not accept it; `late_tries` = the tries run, `total_ms` = ms since the voice arrived, the dl/tr keys of the last try. A
plugin stop writes `late:abandoned` per voice still waiting (not persisted across restarts).
What the agent says to the person on these three attributes: core `.claude/rules/telegram.md`.

## File downloads

Every Telegram file download (the voice route, photos, `download_attachment`, the chat-store keeper) goes through
one helper, `tg-download.ts` (`downloadTelegramFile`): one attempt, getFile then the file GET (D-1087 removed the
8 s second attempt: it won 0 of 14 — Telegram's stall is per file; the 8 s TCP probe stays as a diagnostic). It reads
at most 20 MiB (the Bot API limit), judged on the bytes actually read: over it → `too_big` and the body is cancelled.
A second request for the same `file_id` while it is in flight joins it and gets the same answer. A hard cap of 180 s
aborts it. The voice waits for its file at most 120 s (`DOWNLOAD_TIMEOUT_MS`, ≈ Telegram's own getFile cut; owner tg
49565), then gets the whisper budget on top.
It is the only place that builds the file URL (it carries the bot token); its errors carry only a closed class.

## History: the archive, not the Bot API

Telegram's Bot API exposes **neither** message history nor search, and there is no
`fetch_messages` tool. This fork keeps the history itself: every allowed chat goes to the
inbound archive and our sends to the chat store (both below), and files are kept on arrival.
The assistant reads earlier context there with the core chat reader
(`python3 tools/chat_thread.py --group <chat_id> [--topic <id|general>] [--since <ISO>]`, skill
`telegram-bot`) instead of asking you to paste it. `download_attachment` fetches the file of an
inbound message by its `attachment_file_id`.

## Inbound archive (this fork, D-520)

Every message from an allowed DM person or an allowed group member — delivered,
buffered, or allowed but not woken (no mention, no `contextBuffer`) — is appended
as one JSON line to `~/Workspace/ClaudeProjects/sam-data/state/tg-archive/<chat>/<YYYY-MM>.jsonl`
(`tg-archive.ts`; fields `ts`, `chat_id`, `msg_id`, `sender_id`, `senderName`, `kind`,
`text`, optional `thread_id`, `file_id`, and — the same names and values as the envelope —
`reply_to_message_id` / `reply_to_text` / `reply_to_user` / `reply_to_quote`,
`forward_origin` / `forward_author` / `forward_author_id` / `forward_date` (every kind,
voice too), plus `sender_display` (first + last name) and `via_bot` (an inline-bot result), and `archive_only: true` on his own
voice / photo that did not wake the session — text and labels only, no media bytes). `thread_id` is the forum topic id: the reader's `--topic` filters by it.
The topic's name, once the plugin has seen it (topic created, renamed, or the topic root riding on a message),
goes as `topic_name` into the row and the wake of a forum-topic message (`is_topic_message`; `<>[];"` and every
control / format / line-separator character → `_`, ≤128), and is kept per group in `<chat>/topics.jsonl`
(append-only, one `{"thread", "name", "ts"}` line per learned name, one O_APPEND write — safe for several bot
processes sharing the archive; groups in `access.groups` only). The reader folds the whole log (renames are rare, so the file stays small); per topic the
line with the newest valid Telegram date wins (malformed or future dates are ignored), a root name only fills a gap.
A team group (`team: true`, see ACCESS.md) archives every member and wakes only on an
explicit, typed (not forwarded, not via an inline bot) `@<bot>` in the own message of the install
owner or of an authorized client co-owner (`/etc/sam-telegram-access/co-owners`); any other content
kind there (dice, game, story, paid media, …) gets one archive line and never wakes.
Append-only, no cap; dir 0700, files 0600; the folder holds a `.gitignore` of `*`
so it never enters git. Senders the gate does not allow leave nothing. No
sam-data folder → archive off (one stderr line at start); a write error → one
stderr line, delivery unchanged.

## Both sides and the files in the chat store (this fork, D-883)

`chat-store.ts`. Owner rule: keep every message in and out.

- **Our sends.** One transformer on `bot.api` (ctx.api inherits it): after a successful
  `send*` (not `sendChatAction`), `editMessageText` or `editMessageCaption` whose result is a
  message, one line goes to `<root>/<chat>/<YYYY-MM>.out.jsonl` — `<root>` = `state/tg-business`
  when the call carried `business_connection_id` (the secretary: approvals, direct sends),
  else `state/tg-archive` (reply tool, previews, reports, echoes; only chats the archive itself
  keeps — allowed DM people and configured groups, so a pairing reply to a stranger is not
  stored). Fields `ts`, `chat_id`, `msg_id`, `direction:"out"`, `via` (`secretary` | `bot`),
  `kind`, `text` (caption for media; `start=<INVITE>` redaction), optional `file_id`,
  `thread_id` (the forum topic of the sent message, its `message_thread_id`, so a topic read
  includes our replies), `of_msg_id` (edits), `backfilled`. A sibling file: readers of `YYYY-MM.jsonl` see no change.
  A failed send writes nothing; a write error is one stderr JSON line
  `{ts, component, error_class, action_taken}` and the send's result is returned unchanged.
- **Kept files.** Every incoming file of a stored line (tg-archive: delivered, buffered or
  allowed-but-not-woken; tg-business: listed chats) and every file we send is saved to
  `<root>/<chat>/files/<msg_id>.<ext>` (one `getFile` + download, ≤ 20 MB, 0600, idempotent,
  never blocks delivery, and independent of the archive append). His own voice and photo are
  not copied when they are DELIVERED (they woke the session) — delivery keeps them (inbox +
  owner-log-media); his archive-only ones (no `@` in a team group, any group drop or buffer)
  are kept here like anyone's. Someone else's voice or photo is delivered from the kept path
  (`attachment_path` / `image_path`); his own keep the inbox path. Retention (90 days for other
  people's files) is core's nightly job, not the plugin's.
- **Start-up catch-up** (once per process, background): kept files for stored lines of the last
  90 days that have none (his own voice / photo only when its archive line carries
  `archive_only: true` — set in the same append when it did not wake the session; a delivered
  one has no such field and stays skipped), and one `backfilled: true` out line per secretary draft with
  `status: "sent"` not yet in its `.out.jsonl`.

## Secretary in the owner's Telegram (this fork, Telegram Business, D-637)

Off unless the owner's sam-data `config.json` has `"overrides": {"telegram-secretary": true}`
(exactly boolean `true`; read on every event, so switching off needs no restart).
The owner connects this bot to his own account in Telegram → Settings → Telegram
Business → Chatbots (no login of the assistant into his account, no new secret).
`secretary.ts`:

- **Inbound.** A `business_message` is used only when Telegram's `getBusinessConnection`
  says the connection is the owner's (`user.id` = sam-data `user.telegram_chat_id`)
  and enabled, and only for chats in the top-level `telegram_secretary_chats`
  (`{"<chat id>": "<name>"}`; his own id, `access.json` `allowFrom` ids and
  non-positive ids are dropped with one stderr line). Each message → one JSON
  line in `sam-data/state/tg-business/<chat>/<YYYY-MM>.jsonl` (the archive line
  shape; text and labels only; dir 0700, files 0600, `.gitignore` `*`). Before
  the line is written, an invite payload — `start=` followed by 20 or more of
  `[A-Za-z0-9_-]` — becomes `start=<INVITE>` (the link stays in his Telegram; the
  key is never stored); every other byte is kept. A chat not on the list leaves
  `{name, first_seen}` in `state.json` `unlisted` and the same line, parked, in
  `sam-data/state/tg-business/unlisted/<chat>/<YYYY-MM>.jsonl` — no wake; core
  `tools/chat_thread.py --tg` reads it only once the chat is on the list. Never replies, never marks read.
- **Watch (wake).** `secretary_watch` with `chat: "<listed chat id>"`, `watch: true`
  subscribes (`state.json` `watches: {"<chat id>": {"since": "<ISO>"}}`; refused
  when the switch is off or the chat is not on the filtered list); `watch: false`
  unsubscribes (always allowed). After a line from the OTHER side of a watched
  chat is stored (not his own messages), the plugin wakes the session once
  through its channel notification: meta exactly `event: "secretary"` + `ts`
  (no `chat_id` / `message_id` / `user_id`, so nothing acks or captures it as his
  message), content one fixed English line with the chat id, message id, kind
  and store file path — never a byte of the message text. A failed wake is one
  stderr line; the stored line stays. Unwatched or unlisted chats never wake.
- **Preview setting (D-876).** `"overrides": {"telegram-secretary-preview": true}` (exactly
  boolean `true`; read on every call) turns the preview flow below ON. Absent, `false` or any
  other value (the default, same on every install) → **direct mode**, like WhatsApp: the same
  `reply` + `as_owner_to` call sends the text at once and shows no preview. Whether he said
  «да» (or a grant names the person) is the agent's rule (skill `telegram-secretary`), not a
  plugin check.
- **Direct send (preview OFF).** After the same refusals as a draft (switch off, `chat_id` not his
  DM, chat not on the list, `files` / `checklist` / `voice`, empty text, text over one message,
  no verified Business connection), the plugin re-checks the connection with
  `getBusinessConnection` (his and enabled) and calls `sendMessage(chat, text,
  {business_connection_id})` once, byte-for-byte, no parse mode, no retry. Sent or failed, it
  writes one `state.json` `drafts["direct:<chat>:<msg id | time>"]` record (`status`,
  `sent_msg_id` | `error`, `approval: {kind: "direct"}`); a failed record write is one stderr
  line. He gets no notice in his DM (he sees the message in his own Telegram). The tool result is
  «secretary: delivered in the owner's name to <name>, business message N» — it must not start
  with `sent` or hold `id:` (the core owner-log hook would log it as a message in his DM).
- **Draft (preview ON).** `reply` with `as_owner_to: "<listed chat id>"` and `chat_id` = the
  owner's DM shows him one literal preview («Отправить от твоего имени → <name>: …»)
  and records a pending draft keyed by the preview id in `state.json`. Refused
  with `files` / `checklist` / `voice`, empty text, a preview over one message,
  or an unlisted chat. `edit_message` on a preview is refused.
- **Send (preview ON).** Only the plugin sends, only after the owner's net-added 👍 on the
  preview in his DM, or his own non-forwarded reply «да» to it: the draft text
  byte-for-byte, no parse mode, once (`sending` is saved before the call), then
  «Отправил: <name>.» or «Не ушло: <reason>. Ничего не отправлено.» under the
  preview. The business path uses only `getBusinessConnection` and `sendMessage`.
  Chat, text and status of the send come from the plugin's own memory (filled
  only when it showed the preview), never from `state.json`, which is a record
  only; the connection is re-checked with `getBusinessConnection` right before
  the send. A chat removed from the list → «Не ушло: <name> больше нет в списке».
  After a plugin restart an old preview is stale: his 👍 / «да» sends nothing
  and he is told once to make a new draft.
