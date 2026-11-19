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

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from 'fs'
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
// the creation time, older than any rename).
//
// Store (Codex rr1 f3 / f9): <chat dir>/topics.jsonl, APPEND-ONLY — one learned name = one line
// {"thread","name","ts"} written by ONE write(2) on an O_APPEND fd, never a read-modify-write, so any number of
// processes sharing the archive root (several bot tokens, each its own TELEGRAM_STATE_DIR) never lose each
// other's line and need no lock. Each record starts with "\n", so a torn or corrupt line never swallows the next
// one. The reader folds the lines in file order: per thread the entry with the greatest VALID ts wins (canonical
// ISO, finite, not after now + TOPIC_TS_FUTURE_MS; equal ts → the later line). A same-name event with a newer ts is
// appended too, so the watermark advances and an older different-name event cannot win later.

export const TOPIC_NAME_CAP = 128
/** r1 f6: only the newest TOPICS_MAX_BYTES of topics.jsonl are read (the oldest lines drop off) — ~1000 events. */
export const TOPICS_MAX_BYTES = 256 * 1024
/** rr1 f9: a stored or incoming ts further in the future than this is invalid (clock-skew allowance). */
export const TOPIC_TS_FUTURE_MS = 5 * 60_000

/** The slice of a Telegram message the topic-name helpers read (grammY Message is assignable). */
export type TopicMessage = {
  date?: number
  message_thread_id?: number
  is_topic_message?: boolean
  forum_topic_created?: { name?: string }
  forum_topic_edited?: { name?: string }
  reply_to_message?: { date?: number; forum_topic_created?: unknown }
}

type TopicEntry = { name: string; ts: string }
type TopicStore = Record<string, TopicEntry>

export function topicsFilePath(root: string, chatId: string): string {
  return join(archiveChatDir(root, chatId), 'topics.jsonl')
}

const nonEmpty = (s: unknown): string | undefined => (typeof s === 'string' && s !== '' ? s : undefined)
const rootName = (msg: TopicMessage | undefined): string | undefined =>
  nonEmpty((msg?.reply_to_message?.forum_topic_created as { name?: unknown } | undefined)?.name)
const isoOf = (date: number | undefined): string => {
  const d = new Date((date ?? 0) * 1000)
  return Number.isFinite(d.getTime()) ? d.toISOString() : ''
}
const THREAD_KEY = /^[1-9]\d{0,15}$/

/** rr1 f9: ms of a canonical ISO ts (`toISOString()` round-trips) not after now + TOPIC_TS_FUTURE_MS; else undefined. */
function validTsMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined
  const ms = Date.parse(ts)
  if (!Number.isFinite(ms) || ms > Date.now() + TOPIC_TS_FUTURE_MS) return undefined
  return new Date(ms).toISOString() === ts ? ms : undefined
}

/**
 * r1 f1: the name goes verbatim into a `<channel>` attribute — on top of safeName, `"` and every control /
 * format / line- or paragraph-separator character (U+0085, U+2028, U+2029, bidi, zero-width) → `_`.
 */
export function safeAttr(s: string | undefined): string | undefined {
  return safeName(s)?.replace(/["\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '_')
}

/** The last diagnostic logged per store path — the same one is not repeated on every lookup (r1 f5). */
const lastDiag = new Map<string, string>()
function diag(p: string, line: string | undefined, log: (line: string) => void): void {
  if (line == null) {
    lastDiag.delete(p)
  } else if (lastDiag.get(p) !== line) {
    lastDiag.set(p, line)
    log(line)
  }
}

/**
 * The chat's topics, folded from topics.jsonl (newest TOPICS_MAX_BYTES only, r1 f6): numeric thread key,
 * non-empty string name, valid ts (rr1 f9) — anything else is skipped. No file → {}. Invalid lines / an
 * unreadable file → one log line per change of that state, not per lookup. Never throws.
 */
export function readTopics(root: string, chatId: string, log: (line: string) => void): TopicStore {
  const p = topicsFilePath(root, chatId)
  if (!existsSync(p)) return {}
  let text: string
  let clipped = false
  try {
    const fd = openSync(p, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(size, TOPICS_MAX_BYTES)
      const buf = Buffer.alloc(len)
      let got = 0
      while (got < len) {
        const n = readSync(fd, buf, got, len - got, size - len + got)
        if (n <= 0) break
        got += n
      }
      text = buf.subarray(0, got).toString('utf8')
      clipped = size > len
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    diag(p, `telegram channel: topics.jsonl unreadable (${p}): ${err}`, log)
    return {}
  }
  const lines = text.split('\n')
  if (clipped) lines.shift() // a line cut by the window start is not a record
  const out: TopicStore = {}
  const best: Record<string, number> = {}
  let dropped = 0
  for (const l of lines) {
    if (l.trim() === '') continue
    let rec: { thread?: unknown; name?: unknown; ts?: unknown } | undefined
    try {
      const v: unknown = JSON.parse(l)
      rec = v != null && typeof v === 'object' && !Array.isArray(v) ? (v as typeof rec) : undefined
    } catch {
      rec = undefined
    }
    const k = typeof rec?.thread === 'string' && THREAD_KEY.test(rec.thread) ? rec.thread : undefined
    const name = nonEmpty(rec?.name)
    const ms = validTsMs(rec?.ts)
    if (k == null || name == null || ms == null) {
      dropped++
      continue
    }
    if (!Object.hasOwn(best, k) || ms >= best[k]) {
      best[k] = ms
      out[k] = { name, ts: rec!.ts as string }
    }
  }
  diag(p, dropped ? `telegram channel: topics.jsonl — ${dropped} invalid lines ignored (${p})` : undefined, log)
  return out
}

/** Append one entry as one O_APPEND write; never throws (a failure is one log line — fail-open, owner channel). */
function appendTopic(root: string, chatId: string, threadId: number, entry: TopicEntry, log: (line: string) => void): void {
  try {
    const p = join(ensureChatDir(root, chatId), 'topics.jsonl')
    const buf = Buffer.from('\n' + JSON.stringify({ thread: String(threadId), name: entry.name, ts: entry.ts }), 'utf8')
    const fd = openSync(p, 'a', 0o600)
    try {
      const n = writeSync(fd, buf)
      if (n !== buf.length) throw new Error(`short write ${n}/${buf.length}`)
    } finally {
      closeSync(fd)
    }
  } catch (err) {
    log(`telegram channel: topics.jsonl write failed (chat=${chatId} thread=${threadId}): ${err}`)
  }
}

/** A topic service message (created / edited): learned from, never archived, never a wake. */
export function isTopicServiceMessage(msg: TopicMessage | undefined): boolean {
  return msg?.forum_topic_created != null || msg?.forum_topic_edited != null
}

/**
 * Learn from a topic service message: created / edited-with-a-name → stored, unless the stored entry has a newer
 * Telegram date (rr1 f9: an invalid or far-future date → nothing); an icon-only edit → nothing. No archive root or no thread id → nothing. The caller checks the
 * chat is in access.groups. Never throws.
 */
export function learnTopicName(root: string | undefined, chatId: string, msg: TopicMessage | undefined, log: (line: string) => void): void {
  const threadId = msg?.message_thread_id
  if (!root || msg == null || threadId == null || !isTopicServiceMessage(msg)) return
  const name = nonEmpty(msg.forum_topic_created?.name) ?? nonEmpty(msg.forum_topic_edited?.name)
  if (name == null) return
  const ts = isoOf(msg.date)
  const ms = validTsMs(ts)
  if (ms == null) return
  const current = readTopics(root, chatId, log)[String(threadId)]
  const curMs = current != null ? Date.parse(current.ts) : undefined
  // rr1 f9: an older event never wins; the same name with a newer ts is appended to advance the watermark
  if (curMs != null && (curMs > ms || (curMs === ms && current!.name === name))) return
  appendTopic(root, chatId, threadId, { name, ts }, log)
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
  const rootTs = isoOf(msg.reply_to_message?.date)
  if (learn && stored == null && fromRoot != null && validTsMs(rootTs) != null) {
    appendTopic(root, chatId, threadId, { name: fromRoot, ts: rootTs }, log)
  }
  const v = clipUtf16(safeAttr(stored ?? fromRoot), TOPIC_NAME_CAP)
  return v && v.trim() ? { topic_name: v } : {}
}
