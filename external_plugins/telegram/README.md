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
  only `{name, first_seen}` in `state.json` `unlisted`. Never replies, never marks read.
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
- **Draft.** `reply` with `as_owner_to: "<listed chat id>"` and `chat_id` = the
  owner's DM shows him one literal preview («Отправить от твоего имени → <name>: …»)
  and records a pending draft keyed by the preview id in `state.json`. Refused
  with `files` / `checklist` / `voice`, empty text, a preview over one message,
  or an unlisted chat. `edit_message` on a preview is refused.
- **Send.** Only the plugin sends, only after the owner's net-added 👍 on the
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
