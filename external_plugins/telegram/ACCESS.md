# Telegram — Access & Delivery

A Telegram bot is publicly addressable. Anyone who finds its username can DM it, and without a gate those messages would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `/telegram:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/telegram/access.json`. The `/telegram:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `TELEGRAM_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Numeric user ID (e.g. `412587349`) |
| Group key | Supergroup ID (negative, `-100…` prefix) |
| `ackReaction` quirk | Fixed whitelist only; non-whitelisted emoji silently do nothing |
| Config file | `~/.claude/channels/telegram/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/telegram:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful if the bot's username is guessable and pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and groups. |

```
/telegram:access policy allowlist
```

## User IDs

Telegram identifies users by **numeric IDs** like `412587349`. Usernames are optional and mutable; numeric IDs are permanent. The allowlist stores numeric IDs.

Pairing captures the ID automatically. To find one manually, have the person message [@userinfobot](https://t.me/userinfobot), which replies with their ID. Forwarding any of their messages to @userinfobot also works.

```
/telegram:access allow 412587349
/telegram:access remove 412587349
```

## Groups

Groups are off by default. Opt each one in individually.

**Step zero, before anything else: make the bot a group ADMIN.** Telegram's server-side bot privacy mode blocks a plain-member bot from receiving ordinary group messages — it only ever gets @mentions, replies to its own messages, and commands. Admin status (any minimal rights are enough) bypasses privacy mode entirely for that group and is the surgical fix. Skip this and BOTH `seenGroups` discovery below AND all subsequent group reading will silently see nothing — even though the bot is in the group and people are sending messages. (Live-confirmed 2026-07-06: a plain-member bot produced zero `seenGroups` breadcrumb for a test message; promoting it to admin made discovery work immediately, no restart needed.) The alternative is disabling privacy mode globally via [@BotFather](https://t.me/BotFather) (`/setprivacy` → Disable — see "Privacy mode" below) — but that applies to *every* group the bot is ever added to, not just this one; admin-per-group is the preferred, scoped choice unless you specifically want the global behavior.

```
/telegram:access group add -1001654782309
```

Supergroup IDs are negative numbers with a `-100` prefix, e.g. `-1001654782309`. They're not shown in the Telegram UI. To find one, either add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily (it dumps a JSON blob including the chat ID) — doesn't touch this plugin at all — or add your bot to the group **as an admin** (see above), have anyone send one message, and run `/telegram:access` to read the auto-recorded breadcrumb in `seenGroups` (chatId + title + last sender). The bot doesn't need to be configured yet for `seenGroups` to pick it up — every message from an unconfigured group is still dropped (unchanged), but the sighting is recorded — provided privacy mode isn't blocking it from reaching the bot in the first place.

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/telegram:access group add -1001654782309 --no-mention
/telegram:access group add -1001654782309 --allow 412587349,628194073
/telegram:access group rm -1001654782309
```

**Privacy mode.** Telegram bots default to a server-side privacy mode that filters group messages before they reach your code: only @mentions and replies are delivered. This matches the default `requireMention: true`, so it's normally invisible. Using `--no-mention` requires disabling privacy mode as well: message [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Without that step, Telegram never delivers the messages regardless of local config.

## Post-gating (read-only groups)

A group configured with `--gated-post` (or `postPolicy: "gated"` set directly)
is **read-only**: the assistant still receives every message from it exactly
as before, but the `reply`/`react`/`edit_message` tools refuse to send
anything there — the call errors out instead of posting. This matters for any
group with a third party in it (a friend, a shared channel) where the
assistant reading is fine but it must never autonomously post to someone who
never paired with it, even if the group's own message content tries to talk
it into replying (prompt injection from an untrusted sender).

```
/telegram:access group add -1001654782309 --gated-post   # read-only from the start
/telegram:access group post-policy -1001654782309 open    # owner's explicit go, one message
/telegram:access group post-policy -1001654782309 gated   # back to read-only
```

Treat flipping to `open` as a one-shot approval for the message(s) about to
be sent, not a standing setting — flip it back to `gated` afterward for a
group with a third party in it.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the bot:

- A structured `@botusername` mention
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/telegram:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/telegram:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Telegram accepts only a **fixed whitelist** of reaction emoji; anything else is silently ignored. The full Bot API list:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram:access set ackReaction 👀
/telegram:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Telegram rejects messages over 4096 characters.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Skill reference

| Command | Effect |
| --- | --- |
| `/telegram:access` | Print current state: policy, allowlist, pending pairings, enabled groups. |
| `/telegram:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Telegram. |
| `/telegram:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/telegram:access allow 412587349` | Add a user ID directly. |
| `/telegram:access remove 412587349` | Remove from the allowlist. |
| `/telegram:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/telegram:access group add -1001654782309` | Enable a group. Flags: `--no-mention` (also requires disabling privacy mode), `--allow id1,id2`, `--gated-post` (read-only from the start). |
| `/telegram:access group rm -1001654782309` | Disable a group. |
| `/telegram:access group post-policy -1001654782309 open\|gated` | Toggle whether the assistant may post in this group (see Post-gating above). |
| `/telegram:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Config file

`~/.claude/channels/telegram/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Numeric user IDs allowed to DM.
  "allowFrom": ["412587349"],

  // Groups the bot is active in. Empty object = DM-only.
  "groups": {
    "-1001654782309": {
      // true: respond only to @mentions and replies.
      // false also requires disabling privacy mode via BotFather.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": [],
      // "open" (default, field omittable) or "gated" — see Post-gating above.
      "postPolicy": "open"
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji from Telegram's fixed whitelist. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Telegram rejects > 4096.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline",

  // Auto-recorded sightings of groups NOT in "groups" yet (see "find one" above).
  // Not hand-edited; the server writes it, /telegram:access reads it.
  "seenGroups": {
    "-1001654782309": {
      "title": "MAG & HIU взаимозачёт",
      "lastSenderId": "628194073",
      "lastSenderName": "timur",
      "lastSeenAt": "2026-07-06T09:14:00.000Z",
      "hits": 1
    }
  }
}
```
