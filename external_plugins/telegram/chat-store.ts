// chat-store.ts — D-883: the chat store keeps BOTH sides and the files.
// Spec: sam-data dev/analysis/2026-10-29-d883-store-timeline-door-spec.md §2.A, §5.
// Owner (tg 39044): «надо хранить все входящие и исходящие».
//
// 1. Our sends. One grammY transformer on bot.api (ctx.api inherits it): after a
//    SUCCESSFUL send*/edit call whose result is a message, one out line goes to
//    <root>/<chat>/<YYYY-MM>.out.jsonl — root = state/tg-business when the payload
//    has business_connection_id (the secretary), else state/tg-archive. A sibling
//    file: every reader of the exact `YYYY-MM.jsonl` names sees no change. The
//    result is returned unchanged; a write failure is one stderr line (his
//    channel: fail-open, dev-rules §6). Text passes redactInvites (the secretary
//    store's own redactor).
// 2. Kept files. keep() saves a Telegram file to <root>/<chat>/files/<msg_id>.<ext>
//    (idempotent, ≤ 20 MB, tmp + rename, 0600). Never throws.
// 3. Start-up catch-up: kept files for stored lines of the last 90 days, and one
//    `backfilled` out line per secretary draft that was sent before this module.
//
// Pure fs + injected effects (the Bot API download is server.ts's), so it is unit-testable.

import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { Transformer } from 'grammy'
import { archiveChatDir, ensureChatDir, outFilePath, type ArchiveLine } from './tg-archive'
import { labelOf, redactInvites, type BusinessMessage, type Draft } from './secretary'

export const KEEP_MAX_BYTES = 20 * 1024 * 1024
export const CATCH_UP_DAYS = 90

/** One message we sent (spec §5). */
export type OutLine = {
  ts: string
  chat_id: string
  msg_id: number
  direction: 'out'
  via: 'secretary' | 'bot'
  kind: string
  text: string
  file_id?: string
  /** Set on an edit: the message that was edited. */
  of_msg_id?: number
  backfilled?: true
}

/** `{ts, component, error_class, action_taken}` (dev-rules §5). Only a closed class — never the error text (it can hold the token's URL). */
export function storeErrorLine(component: string, err: unknown, action: string, now: Date = new Date()): string {
  return JSON.stringify({ ts: now.toISOString(), component, error_class: errorClassOf(err), action_taken: action }) + '\n'
}

/** The closed error class of storeErrorLine: a short code, else a short name, else 'unknown'. */
export function errorClassOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  const name = (err as { name?: unknown } | null)?.name
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
    ? code
    : typeof name === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(name)
      ? name
      : 'unknown'
}

// ── 1. our sends ─────────────────────────────────────────────────────────

/** send* (not sendChatAction) and the two text edits. */
export function isOutMethod(method: string): boolean {
  return (method.startsWith('send') && method !== 'sendChatAction') || method === 'editMessageText' || method === 'editMessageCaption'
}

type Msg = BusinessMessage & { edit_date?: number }

function isMessage(r: unknown): r is Msg {
  const m = r as Msg | null
  return m != null && typeof m === 'object' && typeof m.message_id === 'number' && m.chat != null && typeof m.date === 'number'
}

/** The out lines of one successful call (several for sendMediaGroup, none for a non-message result). */
export function outLinesFor(method: string, payload: unknown, result: unknown, now: Date): { business: boolean; line: OutLine }[] {
  if (!isOutMethod(method)) return []
  const business = (payload as { business_connection_id?: unknown } | null)?.business_connection_id != null
  const edit = method.startsWith('edit')
  const msgs = (Array.isArray(result) ? result : [result]).filter(isMessage)
  return msgs.map(m => {
    const label = labelOf(m)
    const secs = edit ? m.edit_date : m.date
    const line: OutLine = {
      ts: typeof secs === 'number' && secs > 0 ? new Date(secs * 1000).toISOString() : now.toISOString(),
      chat_id: String(m.chat.id),
      msg_id: m.message_id,
      direction: 'out',
      via: business ? 'secretary' : 'bot',
      kind: label.kind,
      text: redactInvites(label.text),
      ...(label.file_id ? { file_id: label.file_id } : {}),
      ...(edit ? { of_msg_id: m.message_id } : {}),
    }
    return { business, line }
  })
}

/** Append one out line. Throws on a real fs failure. */
export function appendOut(root: string, line: OutLine): void {
  ensureChatDir(root, line.chat_id)
  appendFileSync(outFilePath(root, line.chat_id, line.ts), JSON.stringify(line) + '\n', { mode: 0o600 })
}

export type OutStoreDeps = {
  /** undefined → that store is off (no sam-data folder). */
  roots: { archive?: string; business?: string }
  log: (line: string) => void
  now?: () => Date
  /** An out line that carries a file (our photo / document / voice bubble). Must not throw. */
  onFile?: (root: string, line: OutLine) => void
  /**
   * tg-archive keeps only allowed people and groups (D-520, the ONE allowlist in server.ts):
   * a send to any other chat (the pairing reply to a stranger) writes nothing. Absent → all.
   */
  archiveAllows?: (chatId: string) => boolean
}

export function createOutStore(deps: OutStoreDeps): { transformer: Transformer } {
  const now = deps.now ?? (() => new Date())
  const transformer: Transformer = async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal)
    if (!isOutMethod(method) || !(res as { ok?: unknown })?.ok) return res
    try {
      for (const { business, line } of outLinesFor(method, payload, (res as { result?: unknown }).result, now())) {
        const root = business ? deps.roots.business : deps.roots.archive
        if (!root) continue
        if (!business && deps.archiveAllows && !deps.archiveAllows(line.chat_id)) continue
        appendOut(root, line)
        if (line.file_id) deps.onFile?.(root, line)
      }
    } catch (err) {
      try { deps.log(storeErrorLine('tg-out-store', err, `out line not written (${method}); the send itself is unaffected`, now())) } catch {}
    }
    return res
  }
  return { transformer }
}

// ── 2. kept files ────────────────────────────────────────────────────────

export type FetchedFile = { bytes: Uint8Array; ext: string }
/** What the Bot API download returns: the bytes, 'too_big' (> 20 MB), or undefined (no file path). */
export type Download = (fileId: string) => Promise<FetchedFile | 'too_big' | undefined>

export function keptFilesDir(root: string, chatId: string): string {
  return join(archiveChatDir(root, chatId), 'files')
}

/**
 * The kept file of this message, if any (`<msg_id>.<ext>`): a regular file (never a link, FIFO or directory, r2 n2) in
 * real store directories. Never the `<msg_id>.missing` reason file. An unsafe store path = not kept.
 */
export function keptFilePath(root: string, chatId: string, msgId: number): string | undefined {
  const dir = keptFilesDir(root, chatId)
  let names: string[]
  try {
    for (const d of [root, archiveChatDir(root, chatId), dir]) realDir(d)
    names = readdirSync(dir).sort()
  } catch {
    return undefined // absent, or not a real directory: nothing kept there that can be trusted
  }
  for (const n of names) {
    if (!n.startsWith(`${msgId}.`) || n === missingFileName(msgId)) continue
    const p = join(dir, n)
    if (lstatSync(p).isFile()) return p
  }
  return undefined
}

/**
 * archive-store-fixes §2.C (owner tg 39044): a file that was not kept leaves a durable named reason,
 * `files/<msg_id>.missing` = one JSON line `{ts, error_class}` — `too_big`, `no_file_path`, or the
 * closed class of storeErrorLine. stderr alone was persisted nowhere (video 41167). keptFilePath never
 * returns it, so catch-up still retries the row; a later success removes it.
 */
export function missingFileName(msgId: number): string {
  return `${msgId}.missing`
}


/**
 * The store's one safe-path rule (= core tools/lib/store_paths.py `real_dir`; r1 f14, r2 f14/n2): `path` is a real
 * directory — lstat, so never a link or a file. create → mkdir 0700 when absent (a concurrent EEXIST is fine);
 * priv → chmod 0700. Anything else throws `unsafe_path` (a closed class for storeErrorLine).
 */
export function realDir(path: string, opts: { create?: boolean; priv?: boolean } = {}): string {
  if (opts.create) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
    }
  }
  if (!lstatSync(path).isDirectory()) throw Object.assign(new Error('unsafe store path'), { code: 'unsafe_path' })
  if (opts.priv) chmodSync(path, 0o700)
  return path
}

/**
 * The `files` dir every kept file and reason file is written to: the store root (r2 f14: the root itself too),
 * the chat dir and `files` — each a real directory, forced to 0700, before anything is created inside. Anything
 * else throws `unsafe_path`: nothing is created outside the store.
 */
export function privateFilesDir(root: string, chatId: string): string {
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 })
  realDir(root, { priv: true })
  realDir(archiveChatDir(root, chatId), { create: true, priv: true })
  const files = realDir(keptFilesDir(root, chatId), { create: true, priv: true })
  ensureChatDir(root, chatId) // the root's .gitignore, as every store writer
  return files
}

/** His own voice and photo in a bot chat: delivery already keeps them (inbox + owner-log-media, D-197). */
export function isOwnDeliveredMedia(kind: string, senderId: string, ownerId: string | undefined): boolean {
  return ownerId != null && senderId === ownerId && (kind === 'voice' || kind === 'photo')
}

export type Keeper = {
  /** Path of the kept file, or undefined (too big / no file / failure — one stderr line). Never throws. */
  keep(root: string, chatId: string, msgId: number, fileId: string, sizeHint?: number): Promise<string | undefined>
}

export function createKeeper(deps: { download: Download; log: (line: string) => void; maxBytes?: number; now?: () => Date }): Keeper {
  const max = deps.maxBytes ?? KEEP_MAX_BYTES
  const now = deps.now ?? (() => new Date())
  const inFlight = new Map<string, Promise<string | undefined>>()
  const fail = (err: unknown, action: string) => {
    try { deps.log(storeErrorLine('tg-keep-file', err, action, now())) } catch {}
  }
  /** The durable reason (§2.C). Never throws: a failure here is one more stderr line. */
  const markMissing = (root: string, chatId: string, msgId: number, errorClass: string) => {
    try {
      const dir = privateFilesDir(root, chatId)
      const tmp = join(dir, `.${msgId}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      writeFileSync(tmp, JSON.stringify({ ts: now().toISOString(), error_class: errorClass }) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(tmp, join(dir, missingFileName(msgId)))
    } catch (err) {
      fail(err, `reason file of msg ${msgId} not written`)
    }
  }

  /** r1 f12: bytes are kept → no reason file may stay. A failed removal is loud; the bytes stay either way. */
  const clearMissing = (root: string, chatId: string, msgId: number) => {
    try {
      unlinkSync(join(keptFilesDir(root, chatId), missingFileName(msgId)))
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') fail(err, `stale reason file of msg ${msgId} not removed; the kept file stays`)
    }
  }

  async function run(root: string, chatId: string, msgId: number, fileId: string, sizeHint?: number): Promise<string | undefined> {
    try {
      const have = keptFilePath(root, chatId, msgId)
      if (have) {
        clearMissing(root, chatId, msgId)
        return have
      }
      const tooBig = { code: 'too_big' }
      if (sizeHint != null && sizeHint > max) {
        fail(tooBig, `file of msg ${msgId} not kept (> 20 MB)`)
        markMissing(root, chatId, msgId, 'too_big')
        return undefined
      }
      const got = await deps.download(fileId)
      if (got === undefined) {
        markMissing(root, chatId, msgId, 'no_file_path')
        return undefined
      }
      if (got === 'too_big' || got.bytes.length > max) {
        fail(tooBig, `file of msg ${msgId} not kept (> 20 MB)`)
        markMissing(root, chatId, msgId, 'too_big')
        return undefined
      }
      const dir = privateFilesDir(root, chatId) // r2 f14/n2: bytes only into real store dirs
      const ext =got.ext.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'bin'
      const final = join(dir, `${msgId}.${ext}`)
      const tmp = join(dir, `.${msgId}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
      const fd = openSync(tmp, 'wx', 0o600)
      try {
        writeSync(fd, got.bytes)
      } finally {
        closeSync(fd)
      }
      try {
        renameSync(tmp, final)
      } catch (err) {
        try { unlinkSync(tmp) } catch {}
        throw err
      }
      clearMissing(root, chatId, msgId) // a later success: bytes, no reason left
      return final
    } catch (err) {
      fail(err, `file of msg ${msgId} not kept; delivery unaffected`)
      markMissing(root, chatId, msgId, errorClassOf(err))
      return undefined
    }
  }

  function keep(root: string, chatId: string, msgId: number, fileId: string, sizeHint?: number): Promise<string | undefined> {
    const key = `${root}\u0000${chatId}\u0000${msgId}`
    const running = inFlight.get(key)
    if (running) return running
    const p = run(root, chatId, msgId, fileId, sizeHint).finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  return { keep }
}

// ── 3. start-up catch-up ─────────────────────────────────────────────────

function readJsonLines<T>(path: string): T[] {
  const out: T[] = []
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (!raw.trim()) continue
    try {
      out.push(JSON.parse(raw) as T)
    } catch {}
  }
  return out
}

function chatDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(root, d.name))
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/
const OUT_FILE = /^\d{4}-\d{2}\.out\.jsonl$/

export type CatchUpDeps = {
  archiveRoot?: string
  businessRoot?: string
  ownerId: string | undefined
  /** The secretary's drafts (state.json); may throw — logged, the file part still runs. */
  drafts: () => Record<string, Draft>
  keeper: Keeper
  log: (line: string) => void
  now?: () => Date
  days?: number
}

/** One pass per plugin start; idempotent. Serial downloads. Never throws. */
export async function catchUp(deps: CatchUpDeps): Promise<{ kept: number; backfilled: number }> {
  const now = deps.now ?? (() => new Date())
  const cutoff = new Date(now().getTime() - (deps.days ?? CATCH_UP_DAYS) * 86_400_000).toISOString()
  const firstMonth = cutoff.slice(0, 7)
  let kept = 0
  let backfilled = 0
  const log = (err: unknown, action: string) => {
    try { deps.log(storeErrorLine('tg-store-catch-up', err, action, now())) } catch {}
  }

  for (const [root, isArchive] of [[deps.archiveRoot, true], [deps.businessRoot, false]] as const) {
    if (!root) continue
    try {
      for (const dir of chatDirs(root)) {
        for (const name of readdirSync(dir).filter(n => MONTH_FILE.test(n) && n.slice(0, 7) >= firstMonth).sort()) {
          for (const l of readJsonLines<ArchiveLine>(join(dir, name))) {
            if (!l.file_id || l.msg_id == null || typeof l.ts !== 'string' || l.ts < cutoff) continue
            if (isArchive && isOwnDeliveredMedia(l.kind, l.sender_id, deps.ownerId)) continue
            if (keptFilePath(root, l.chat_id, l.msg_id)) {
              // r1 f12: bytes next to a stale reason file → keep()'s fast path removes it (no download, not counted)
              if (existsSync(join(keptFilesDir(root, l.chat_id), missingFileName(l.msg_id)))) await deps.keeper.keep(root, l.chat_id, l.msg_id, l.file_id)
              continue
            }
            if (await deps.keeper.keep(root, l.chat_id, l.msg_id, l.file_id)) kept++
          }
        }
      }
    } catch (err) {
      log(err, 'kept-file catch-up stopped for this store')
    }
  }

  if (deps.businessRoot) {
    try {
      const drafts = deps.drafts()
      const seen = new Map<string, Set<number>>()
      const sentIds = (chat: string): Set<number> => {
        let s = seen.get(chat)
        if (s) return s
        s = new Set()
        const dir = archiveChatDir(deps.businessRoot!, chat)
        if (existsSync(dir)) {
          for (const n of readdirSync(dir).filter(n => OUT_FILE.test(n))) {
            for (const l of readJsonLines<OutLine>(join(dir, n))) if (typeof l.msg_id === 'number') s.add(l.msg_id)
          }
        }
        seen.set(chat, s)
        return s
      }
      for (const d of Object.values(drafts)) {
        if (d?.status !== 'sent' || typeof d.sent_msg_id !== 'number' || !d.chat_id) continue
        const ts = d.approval?.at ?? d.created
        if (typeof ts !== 'string' || !/^\d{4}-\d{2}/.test(ts)) continue
        const ids = sentIds(String(d.chat_id))
        if (ids.has(d.sent_msg_id)) continue
        appendOut(deps.businessRoot, {
          ts,
          chat_id: String(d.chat_id),
          msg_id: d.sent_msg_id,
          direction: 'out',
          via: 'secretary',
          kind: 'text',
          text: redactInvites(d.text ?? ''),
          backfilled: true,
        })
        ids.add(d.sent_msg_id)
        backfilled++
      }
    } catch (err) {
      log(err, 'secretary sends not backfilled')
    }
  }
  return { kept, backfilled }
}
