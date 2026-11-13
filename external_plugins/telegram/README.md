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
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
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
mode) in his own DM. It reaches the session as the same `event="reaction"` envelope his
👍/👎 makes (`reaction_added` 👍 for «Да», 👎 for «Нет») plus `via="button"`; the buttons
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

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.

## Inbound archive (this fork, D-520)

Every message from an allowed DM person or an allowed group member — delivered,
buffered, or allowed but not woken (no mention, no `contextBuffer`) — is appended
as one JSON line to `~/Workspace/ClaudeProjects/sam-data/state/tg-archive/<chat>/<YYYY-MM>.jsonl`
(`tg-archive.ts`; fields `ts`, `chat_id`, `msg_id`, `sender_id`, `senderName`, `kind`,
`text`, optional `thread_id`, `file_id` — text and labels only, no media bytes).
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
  `of_msg_id` (edits), `backfilled`. A sibling file: readers of `YYYY-MM.jsonl` see no change.
  A failed send writes nothing; a write error is one stderr JSON line
  `{ts, component, error_class, action_taken}` and the send's result is returned unchanged.
- **Kept files.** Every incoming file of a stored line (tg-archive: delivered, buffered or
  allowed-but-not-woken; tg-business: listed chats) and every file we send is saved to
  `<root>/<chat>/files/<msg_id>.<ext>` (one `getFile` + download, ≤ 20 MB, 0600, idempotent,
  never blocks delivery). His own voice and photo in a bot chat are not copied — delivery keeps
  them (inbox + owner-log-media). Someone else's voice or photo is delivered from the kept path
  (`attachment_path` / `image_path`); his own keep the inbox path. Retention (90 days for other
  people's files) is core's nightly job, not the plugin's.
- **Start-up catch-up** (once per process, background): kept files for stored lines of the last
  90 days that have none, and one `backfilled: true` out line per secretary draft with
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
