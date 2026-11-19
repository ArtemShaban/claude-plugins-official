// tg-archive.ts — the inbound ARCHIVE (D-520): one JSON line per incoming
// message from an allowed DM person or an allowed group member, kept for good.
//
// Owner (tg 25504): «просто надо хранить "в архиве" все входящие из все
// разрешенных групп/людей из телеграмма». Spec: sam-data
// dev/analysis/2026-10-01-tg-inbound-archive-spec.md.
//
// Store: <sam-data>/state/tg-archive/<safeChatId>/<YYYY-MM>.jsonl (month of the
// message ts, UTC). Append-only — one appendFileSync per message, never a
// read-modify-write, so there is no cap and nothing is ever trimmed. Dir 0700,
// file 0600 (same modes as the group buffer). The folder ignores itself in git
// (a `.gitignore` holding `*`): the lines are other people's verbatim text,
// which no scrubber here cleans — it must never reach a git history.
//
// Who is "allowed" is decided by gate() in server.ts (the ONE allowlist); this
// module only writes. Pure fs, no grammy import, so it is unit-testable.

import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { MessageOrigin } from 'grammy/types'
import { groupBufferPath } from './group-buffer'
import { clipUtf16, safeName } from './text-clip'
import { forwardDateMeta, forwardOriginMeta, samDataDir } from './voice-delivery'

export type ArchiveLine = {
  /** ISO UTC of the message date — the group buffer's exact value. */
  ts: string
  chat_id: string
  msg_id?: number
  sender_id: string
  /** username, else the numeric id — the group buffer's exact value. */
  senderName: string
  /** 'text' or the attachment kind (photo, document, voice, ...). */
  kind: string
  /** text / caption / kind label — the group buffer's exact value. */
  text: string
  thread_id?: number
  file_id?: string
  // Team-group spec §2.3 (owner tg 49424 «полная мета-информация … как в личке»): additive, every chat.
  // Same names and values as the envelope's (messageContextMeta below — the one computation).
  reply_to_message_id?: string
  reply_to_text?: string
  reply_to_user?: string
  reply_to_quote?: string
  forward_origin?: string
  forward_author?: string
  forward_author_id?: string
  forward_date?: string
  /** first + last name of the sender, sanitized (← «кто писал»). */
  sender_display?: string
  /** r1 f1: an inline-bot result — «@<bot username>», else the bot's id; that bot wrote the text. */
  via_bot?: string
  /**
   * rr3-1 (AC-05): his own voice / photo that did NOT wake the session (no `@` in a team group, any group
   * drop / buffer). Delivery does not keep it, so the store must — written in the same append as the row,
   * so catch-up can always tell it from a delivered one. Absent on every other line.
   */
  archive_only?: true
  /** Topic-name spec §2.3: the forum topic's name when the plugin knows it (topicNameMeta); same value as the wake. */
  topic_name?: string
}

/** The slice of a Telegram message messageContextMeta reads (grammY Message is assignable). */
export type ContextMessage = {
  reply_to_message?: {
    message_id: number
    text?: string
    caption?: string
    from?: { id: number; username?: string }
    forum_topic_created?: unknown
  }
  quote?: { text?: string }
  forward_origin?: MessageOrigin
}

/**
 * reply_to_* + the quote + forward_* of one inbound message — ONE computation shared by the envelope
 * (server.ts) and the archive line (DRY, spec §2.3). Snippets sanitized + clipped (uploader-controlled
 * text must not break out of the <channel> tag). A reply target carrying `forum_topic_created` is the
 * forum topic's root (Telegram sets it on topic messages that reply to nothing), not a reply → no
 * reply_to_*. `envelopeKind === 'voice'` → no forward_origin/author labels (the voice envelope carries
 * voice_author_*); the archive passes no kind, so it gets them for every kind. forward_date always.
 */
export function messageContextMeta(msg: ContextMessage | undefined, envelopeKind?: string): Record<string, string> {
  const meta: Record<string, string> = {}
  const repliedTo = msg?.reply_to_message
  if (repliedTo != null && repliedTo.forum_topic_created == null) {
    meta.reply_to_message_id = String(repliedTo.message_id)
    const repliedSnippet = clipUtf16(safeName(repliedTo.text ?? repliedTo.caption), 300)
    if (repliedSnippet) meta.reply_to_text = repliedSnippet
    if (repliedTo.from) meta.reply_to_user = repliedTo.from.username ?? String(repliedTo.from.id)
  }
  const quotedSnippet = clipUtf16(safeName(msg?.quote?.text), 300)
  if (quotedSnippet) meta.reply_to_quote = quotedSnippet
  return {
    ...meta,
    ...forwardOriginMeta(msg?.forward_origin, envelopeKind),
    ...forwardDateMeta(msg?.forward_origin),
  }
}

/** «кто писал»: first + last name, sanitized and clipped; {} when Telegram gives no name. */
export function senderDisplayMeta(from: { first_name?: string; last_name?: string } | undefined): { sender_display?: string } {
  const name = [from?.first_name, from?.last_name].filter(s => typeof s === 'string' && s.trim()).join(' ')
  const v = clipUtf16(safeName(name), 128)
  return v && v.trim() ? { sender_display: v } : {}
}

/** r1 f1: the archive's `via_bot` («@username», else the id) of an inline-bot result; nothing otherwise. */
export function viaBotMeta(viaBot: { id?: number; username?: string } | undefined): { via_bot?: string } {
  if (viaBot == null) return {}
  const u = safeName(viaBot.username)
  const v = u ? `@${clipUtf16(u, 64)}` : viaBot.id != null ? String(viaBot.id) : 'unknown'
  return { via_bot: v }
}

/** <sam-data>/state/tg-archive, or undefined when the install has no sam-data folder. */
export function archiveRoot(home: string): string | undefined {
  const data = samDataDir(home)
  return existsSync(data) ? join(data, 'state', 'tg-archive') : undefined
}

/** The buffer's safeChatId, reused through its exported path helper (group-buffer.ts stays untouched). */
export function archiveChatDir(root: string, chatId: string): string {
  return join(root, basename(groupBufferPath('', chatId), '.jsonl'))
}

export function archiveFilePath(root: string, chatId: string, ts: string): string {
  return join(archiveChatDir(root, chatId), `${ts.slice(0, 7)}.jsonl`)
}

/** D-883: our own sends to this chat — a sibling file, so readers of exact `YYYY-MM.jsonl` names see no change. */
export function outFilePath(root: string, chatId: string, ts: string): string {
  return join(archiveChatDir(root, chatId), `${ts.slice(0, 7)}.out.jsonl`)
}

/** Root (0700, ignores itself in git) + this chat's dir (0700); returns the chat dir. Shared by every store writer. */
export function ensureChatDir(root: string, chatId: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const ignore = join(root, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
  const dir = archiveChatDir(root, chatId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Append one line. Throws on a real fs failure — the caller (server.ts) logs and carries on. */
export function appendArchive(root: string, line: ArchiveLine): void {
  ensureChatDir(root, line.chat_id)
  appendFileSync(archiveFilePath(root, line.chat_id, line.ts), JSON.stringify(line) + '\n', { mode: 0o600 })
}

// ── Forum topic names (spec sam-data dev/analysis/2026-11-19-tg-topic-name-spec.md, owner tg 49767 / 49776) ──
// Bot API has no method to fetch a topic's name, so it is learned from what the bot already receives: the
// service messages forum_topic_created / forum_topic_edited{name}, and the topic root riding on a topic message
// as reply_to_message. The root carries the CREATION name, so it only fills a gap (its ts = the root's own date,
// the creation time, older than any rename); created / edited overwrite unless the stored entry is newer by
// Telegram date. Store: <chat dir>/topics.json {"<thread id>": {name: raw, ts: ISO}}, read on each lookup (no
// cache), written whole-file (unique temp + rename) only when the name changes — so a rename survives a restart.
//
// One writer (Codex r1 f3): Telegram serves getUpdates to exactly ONE consumer per bot token (a second gets
// 409 Conflict), and server.ts replaces a stale poller at start (PID_FILE, «replacing stale poller»), so one
// process learns a chat's names. Inside it every read-modify-write below is synchronous — no await between the
// read and the rename — so two handlers never interleave. The newer-date rule keeps an old event from winning
// if one ever arrives late.

export const TOPIC_NAME_CAP = 128
/** r1 f6: a bigger topics.json is not read (one diagnostic, empty store) — room for ~1000 topics of 128-char names. */
export const TOPICS_MAX_BYTES = 256 * 1024

/** The slice of a Telegram message the topic-name helpers read (grammY Message is assignable). */
export type TopicMessage = {
  date?: number
  message_thread_id?: number
  is_topic_message?: boolean
  forum_topic_created?: { name?: string }
  forum_topic_edited?: { name?: string }
  reply_to_message?: { date?: number; forum_topic_created?: unknown }
}

type TopicEntry = { name: string; ts?: string }
type TopicStore = Record<string, TopicEntry>

export function topicsFilePath(root: string, chatId: string): string {
  return join(archiveChatDir(root, chatId), 'topics.json')
}

const nonEmpty = (s: unknown): string | undefined => (typeof s === 'string' && s !== '' ? s : undefined)
const rootName = (msg: TopicMessage | undefined): string | undefined =>
  nonEmpty((msg?.reply_to_message?.forum_topic_created as { name?: unknown } | undefined)?.name)
const isoOf = (date: number | undefined): string => new Date((date ?? 0) * 1000).toISOString()
const THREAD_KEY = /^[1-9]\d{0,15}$/

/**
 * r1 f1: the name goes verbatim into a `<channel>` attribute — on top of safeName, `"` and every control /
 * format / line- or paragraph-separator character (U+0085, U+2028, U+2029, bidi, zero-width) → `_`.
 */
export function safeAttr(s: string | undefined): string | undefined {
  return safeName(s)?.replace(/["\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '_')
}

/**
 * The chat's stored topics: only numeric thread keys with a non-empty string name (r1 f6). No file → {};
 * over TOPICS_MAX_BYTES, unreadable or not a JSON object → {} + one log line (overwritten on the next change);
 * invalid entries are dropped with one log line and never written back.
 */
export function readTopics(root: string, chatId: string, log: (line: string) => void): TopicStore {
  const p = topicsFilePath(root, chatId)
  if (!existsSync(p)) return {}
  try {
    const size = statSync(p).size
    if (size > TOPICS_MAX_BYTES) {
      log(`telegram channel: topics.json too large (${size} B > ${TOPICS_MAX_BYTES} B, ${p}) — read as empty`)
      return {}
    }
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (v == null || typeof v !== 'object' || Array.isArray(v)) {
      log(`telegram channel: topics.json is not an object (${p}) — read as empty`)
      return {}
    }
    const out: TopicStore = {}
    let dropped = 0
    for (const [k, e] of Object.entries(v)) {
      const rec = e != null && typeof e === 'object' && !Array.isArray(e) ? (e as { name?: unknown; ts?: unknown }) : undefined
      const name = THREAD_KEY.test(k) ? nonEmpty(rec?.name) : undefined
      if (name == null) {
        dropped++
        continue
      }
      out[k] = typeof rec?.ts === 'string' ? { name, ts: rec.ts } : { name }
    }
    if (dropped) log(`telegram channel: topics.json — ${dropped} invalid entries ignored (${p})`)
    return out
  } catch (err) {
    log(`telegram channel: topics.json unreadable (${p}): ${err}`)
    return {}
  }
}

/** Write the store with one entry set; never throws (a failure is one log line — fail-open, owner channel). */
function writeTopic(root: string, chatId: string, store: TopicStore, threadId: number, entry: TopicEntry, log: (line: string) => void): void {
  try {
    store[String(threadId)] = entry
    const p = join(ensureChatDir(root, chatId), 'topics.json')
    const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 })
      renameSync(tmp, p)
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp)
    }
  } catch (err) {
    log(`telegram channel: topics.json write failed (chat=${chatId} thread=${threadId}): ${err}`)
  }
}

/** A topic service message (created / edited): learned from, never archived, never a wake. */
export function isTopicServiceMessage(msg: TopicMessage | undefined): boolean {
  return msg?.forum_topic_created != null || msg?.forum_topic_edited != null
}

/**
 * Learn from a topic service message: created / edited-with-a-name → stored, unless the stored entry has a newer
 * Telegram date; an icon-only edit → nothing. No archive root or no thread id → nothing. The caller checks the
 * chat is in access.groups. Never throws.
 */
export function learnTopicName(root: string | undefined, chatId: string, msg: TopicMessage | undefined, log: (line: string) => void): void {
  const threadId = msg?.message_thread_id
  if (!root || msg == null || threadId == null || !isTopicServiceMessage(msg)) return
  const name = nonEmpty(msg.forum_topic_created?.name) ?? nonEmpty(msg.forum_topic_edited?.name)
  if (name == null) return
  const ts = isoOf(msg.date)
  const store = readTopics(root, chatId, log)
  const current = store[String(threadId)]
  if (current != null && (current.name === name || (current.ts != null && current.ts > ts))) return
  writeTopic(root, chatId, store, threadId, { name, ts }, log)
}

/**
 * `{topic_name}` of an ordinary inbound message — ONE store read for the archive row and the wake (r1 f5).
 * Only a real forum-topic message (`is_topic_message === true`, r1 f2) with a thread id and an archive root;
 * otherwise {}. Name = stored, else the root's creation name; `learn` (chat in access.groups) stores the root's
 * name when nothing is stored. Sanitized by safeAttr, clipped at 128 without a lone surrogate, dropped when
 * empty after trim. Never throws.
 */
export function inboundTopicName(
  root: string | undefined,
  chatId: string,
  msg: TopicMessage | undefined,
  learn: boolean,
  log: (line: string) => void,
): { topic_name?: string } {
  const threadId = msg?.message_thread_id
  if (!root || msg == null || threadId == null || msg.is_topic_message !== true) return {}
  const store = readTopics(root, chatId, log)
  const stored = store[String(threadId)]?.name
  const fromRoot = rootName(msg)
  if (learn && stored == null && fromRoot != null) {
    writeTopic(root, chatId, store, threadId, { name: fromRoot, ts: isoOf(msg.reply_to_message?.date) }, log)
  }
  const v = clipUtf16(safeAttr(stored ?? fromRoot), TOPIC_NAME_CAP)
  return v && v.trim() ? { topic_name: v } : {}
}
