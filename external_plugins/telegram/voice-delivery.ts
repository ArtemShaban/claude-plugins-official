/**
 * Telegram-bridge voice transcription (variant A) — pure / effect-injected
 * building blocks. sam-data dev/analysis/2026-09-17-bridge-voice-spec-
 * FINAL.md is the SSOT for scope + acceptance criteria; this module carries
 * only the parts that need to be UNIT-testable.
 *
 * Kept as its OWN module rather than inline in server.ts because
 * server.test.ts does NOT import server.ts (F16 in the spec) — server.ts
 * has top-level side effects (reads the bot token off disk, `process.exit(1)`
 * on misconfig) that make it unsafe to import from a test file. This module
 * has none: it only imports TYPES from grammy (erased at compile time, zero
 * runtime footprint); userVoiceConfig reads a file only when called. server.ts wires the real I/O (spawn/fetch/fs) and
 * calls into this module's effect-injected orchestrators — the exact same
 * seam idea-inbox.ts already uses for `transcribeVoiceIdea` /
 * `downloadIdeaAttachment`.
 */
import type { Chat, MessageOrigin, User } from 'grammy/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStateLineWriter } from './state-line'
import type { DownloadJournal } from './tg-download'

// ── per-key FIFO serializer (OB-09 — owner tg 17093, "это оч важно": text1 →
// voice → text2 must reach the session in that same order, even when the
// voice takes a minute to transcribe) ──────────────────────────────────────
//
// One structure: a Map<string, Promise<unknown>> "tail" per key. `serialize`
// appends `work` to that key's tail — `work` only STARTS once the previous
// work queued under the same key has settled, success OR failure (a failing
// task must never wedge the chain for everything queued behind it). Two
// different keys never wait on each other (separate Map entries). The Map
// entry is deleted once its own queue drains, so a quiet chat/key leaves no
// residue behind (no unbounded growth).
const chainTails = new Map<string, Promise<unknown>>()

export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prevTail = chainTails.get(key) ?? Promise.resolve()
  // `run` carries THIS call's own outcome back to the caller — `work` starts
  // only once `prevTail` has settled, whichever way (`.then(work, work)`:
  // both the fulfillment and rejection handler are `work` itself).
  const run = prevTail.then(work, work)
  // The shared tail stored in the Map must never reject — otherwise a tail
  // nobody else ever reads (the last item in a chain) would surface as an
  // unhandled rejection. Swallow explicitly; `run` above still carries the
  // real outcome to ITS own caller.
  const tail: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  )
  chainTails.set(key, tail)
  // Only the tail that is STILL the map's current entry may delete it — an
  // earlier task's cleanup firing after a newer task already replaced the
  // entry (the common case: task2 was enqueued while task1 was still
  // running) must never evict the newer one.
  void tail.finally(() => {
    if (chainTails.get(key) === tail) chainTails.delete(key)
  })
  return run
}

// ── generic timeout wrapper (§6.3 — bounds whisper's run time; a hung
// whisper must not block the per-chat queue forever, and whisper is ~1.5GB
// RSS on a 16GB miniK — memory-mirror/memory-budget-before-agent-wave.md) ──
//
// Kept generic/pure (no spawn/fs) so it is unit-testable here without a real
// subprocess: inject a promise that never settles + a spy `onTimeout`.
// NAMED LIMITATION (kept deliberately simple per the owner's "чем проще чем
// лучше" order, tg 17096): `onTimeout` is expected to kill the ONE process it
// was given; it does not chase a process TREE (a `sh -c` wrapper whose child
// forks its own children could in principle leave a grandchild running after
// the immediate child is killed). Not chased here — the mutex (wired in
// server.ts) already bounds concurrent whisper STARTS to one; the residual
// risk is a killed slot's real OS process occasionally outliving its
// rejected promise, not unbounded growth.
export function withTimeout<T>(op: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      onTimeout()
      reject(new Error(`operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    op.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// ── whisper timeout budget (§6.3) ──────────────────────────────────────────
// F9 (live 16.09 measurement on this miniK): whisper.cpp runs ≈8.4x realtime
// on long clips. `max(60s, duration*1000)` gives roughly an 8x margin over the
// measured worst case while still bounding a hung process — the owner's own
// words ("даже если расшифровка займет минуту") rule out a SHORT timeout.
const MIN_WHISPER_TIMEOUT_MS = 60_000

export function whisperTimeoutMs(durationSeconds: number): number {
  return Math.max(MIN_WHISPER_TIMEOUT_MS, Math.round(durationSeconds * 1000))
}

// ── download budget (F4 fix — analysis/2026-09-17-voice-bridge-u3-verdict.md)
// ───────────────────────────────────────────────────────────────────────────
// runTranscribeCmd's `withTimeout` only bounds the WHISPER leg, once the
// mutex is granted — the download that happens BEFORE it (a bare `fetch` in
// server.ts's downloadFileToInbox, and the pre-existing photo downloadImage
// leg) had no bound at all: a stalled TCP connection to api.telegram.org
// wedged that chat's per-key `serialize` chain forever (every message queued
// behind it, and behind it in the shared 'whisper' key too). A fixed budget,
// not scaled by attachment size/duration — Telegram's own 20MB cap already
// bounds transfer size, so this only needs to cover ordinary network
// slowness, not a large-file allowance.
//
// D-1066 (spec sam-data dev/analysis/2026-11-16-tg-file-download-fix-spec.md §2 B): the voice now waits for its
// file on its OWN clock — deliverVoiceTranscript bounds the download wait at DOWNLOAD_TIMEOUT_MS (90 s), so a late
// file can no longer spend whisper's share of the envelope (47819/48003: file at 88.5 s, whisper left 1.4 s). The
// shared download itself (tg-download.ts) runs on to its 180 s cap, so the session's download_attachment can join
// it. The envelope stays voiceEnvelopeMs() = whisper budget + this. Photos keep 30 s (PHOTO_DOWNLOAD_TIMEOUT_MS).
// D-1087 (owner tg 49565 «подними даймаут с 90 до 120 с … ждать столько же, сколько сама телега ждёт»): 120 s —
// Telegram's own getFile cut (its 504 Gateway Timeout comes at ≈120 s, RCA 2026-11-18 M5).
export const DOWNLOAD_TIMEOUT_MS = 120_000
export const PHOTO_DOWNLOAD_TIMEOUT_MS = 30_000

/** The voice route's outer envelope: the whisper budget plus the bounded download wait (server.ts uses this). */
export function voiceEnvelopeMs(whisperMs: number): number {
  return whisperMs + DOWNLOAD_TIMEOUT_MS
}

// ── voice author + trust (OB-05/06/07/08, §6.1/§6.5) ───────────────────────

export type VoiceAuthorOrigin =
  | 'sender'
  | 'forward_user'
  | 'forward_hidden_user'
  | 'forward_chat'
  | 'forward_channel'

export type VoiceTrust = 'owner' | 'data'

export type VoiceAuthorResult = {
  voice_author: string
  voice_author_id?: string
  voice_author_origin: VoiceAuthorOrigin
  voice_trust: VoiceTrust
}

export type VoiceAuthorInput = {
  from: User | undefined
  forwardOrigin: MessageOrigin | undefined
}

// Mirrors server.ts's own safeName() (strips <>[]\r\n; — the exact chars that
// would let a forged name break out of the <channel> envelope tag). NOT
// imported from server.ts — importing it would drag in server.ts's top-level
// side effects (see module header). One-line regex, duplicated deliberately.
function sanitizeAuthorName(s: string): string {
  return s.replace(/[<>[\]\r\n;]/g, '_')
}

function chatDisplayName(chat: Chat | Chat.ChannelChat): string {
  return chat.username ?? chat.title ?? String(chat.id)
}

// ── shared forward-origin mapping (voice AND non-voice inbound) ─────────────
// ONE mapping of Telegram's 4 MessageOrigin variants onto our origin tags +
// author name/id. voiceAuthor (below) and forwardOriginMeta (non-voice
// envelope labels) both call it, so the two paths cannot drift apart.
export type ForwardOriginTag = Exclude<VoiceAuthorOrigin, 'sender'>

export type ForwardAuthor = {
  origin: ForwardOriginTag
  name: string
  id?: string
}

export function forwardAuthor(origin: MessageOrigin): ForwardAuthor {
  if (origin.type === 'user') {
    const u = origin.sender_user
    return { origin: 'forward_user', name: u.username ?? u.first_name ?? String(u.id), id: String(u.id) }
  }
  if (origin.type === 'hidden_user') {
    // Telegram itself withholds the id here (OB-08) — never guessed.
    return { origin: 'forward_hidden_user', name: origin.sender_user_name }
  }
  if (origin.type === 'chat') {
    return { origin: 'forward_chat', name: chatDisplayName(origin.sender_chat), id: String(origin.sender_chat.id) }
  }
  return { origin: 'forward_channel', name: chatDisplayName(origin.chat), id: String(origin.chat.id) }
}

// Envelope labels for a NON-voice inbound message (owner tg 18168/18170: a
// forwarded text/photo/document arrived looking like the owner's own words).
// Labels only — no trust decision here. Not forwarded => {} (envelope stays
// byte-identical). forward_author is omitted when Telegram gives no name
// (hidden user with an empty name) — never guessed.
// `attachmentKind === 'voice'` => {} — voice carries its own voice_author_*
// attributes (unchanged); this is the single switch server.ts calls.
export function forwardOriginMeta(
  origin: MessageOrigin | undefined,
  attachmentKind?: string,
): Record<string, string> {
  if (origin == null || attachmentKind === 'voice') return {}
  const a = forwardAuthor(origin)
  const name = sanitizeAuthorName(a.name ?? '')
  return {
    forward_origin: a.origin,
    ...(name.trim() ? { forward_author: name } : {}),
    ...(a.id != null ? { forward_author_id: a.id } : {}),
  }
}

// The forwarded message's ORIGINAL date (owner tg 29540: a month-old chat he
// forwarded looked like today's, because the envelope `ts` is the time of the
// forward). For EVERY forward, voice included — the date is a label, not a
// trust decision. Same ISO format as the envelope `ts`. Not forwarded, or no
// usable date from Telegram => {} (never a made-up 1970 date).
export function forwardDateMeta(origin: MessageOrigin | undefined): Record<string, string> {
  const d = origin?.date
  if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return {}
  return { forward_date: new Date(d * 1000).toISOString() }
}

// The user's own settings, read once at start from sam-data config.json (D-454,
// D-449): `<home>/Workspace/ClaudeProjects/sam-data/config.json` — the same
// path rule as sam-core tools/sam_data.py::data_root_of.
// - chatId: `user.telegram_chat_id`, trimmed, kept only if it is an optional
//   minus + 5-20 digits (same rule as sam_data.py::telegram_chat_id). Missing,
//   invalid, unreadable or malformed config => undefined, and voiceAuthor()
//   then gives every voice voice_trust='data' (fail-safe). No env fallback.
// - lang: `user.language` when a non-empty string, else 'auto' (whisper
//   detects the language itself).
export type UserVoiceConfig = { chatId: string | undefined; lang: string }

// The install's sam-data folder, derived from HOME only (D-314) — the ONE place
// the plugin derives it; config.json here and the inbound archive (tg-archive.ts,
// D-520) both build on it.
export function samDataDir(home: string): string {
  return join(home, 'Workspace', 'ClaudeProjects', 'sam-data')
}

export function userVoiceConfig(home: string): UserVoiceConfig {
  let user: unknown
  try {
    const cfg = JSON.parse(readFileSync(join(samDataDir(home), 'config.json'), 'utf8'))
    user = cfg != null && typeof cfg === 'object' ? (cfg as Record<string, unknown>).user : undefined
  } catch {
    return { chatId: undefined, lang: 'auto' }
  }
  if (user == null || typeof user !== 'object') return { chatId: undefined, lang: 'auto' }
  const u = user as Record<string, unknown>
  const rawId = u.telegram_chat_id
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : ''
  const lang = typeof u.language === 'string' ? u.language.trim() : ''
  return {
    chatId: /^-?[0-9]{5,20}$/.test(id) ? id : undefined,
    lang: lang || 'auto',
  }
}

// TTS language from the config language (D-454, tg 23375/23379): the user's
// language passes through; none ('auto' / empty) → 'ru' — TTS needs a
// concrete language, 'auto' means something only to whisper.
export function ttsLang(lang: string): string {
  return !lang || lang === 'auto' ? 'ru' : lang
}

// voice_author_origin covers exactly the 5 forms named in the spec (A6): no
// forward_origin at all => 'sender' (ctx.from IS the author); one of
// Telegram's 4 MessageOrigin variants when forwarded. `voice_author_id` is
// present everywhere EXCEPT 'forward_hidden_user' (Telegram itself withholds
// the id there — OB-08: honest "author hidden", never guessed).
export function voiceAuthor(input: VoiceAuthorInput, ownerId: string | undefined): VoiceAuthorResult {
  const origin = input.forwardOrigin
  let name: string
  let id: string | undefined
  let originTag: VoiceAuthorOrigin

  if (origin == null) {
    originTag = 'sender'
    const u = input.from
    id = u ? String(u.id) : undefined
    name = u ? u.username ?? u.first_name ?? String(u.id) : 'unknown'
  } else {
    const a = forwardAuthor(origin)
    originTag = a.origin
    id = a.id
    name = a.name
  }

  // A7: owner trust requires BOTH a non-forwarded message AND the author id
  // matching the configured owner id — an empty ownerId (no valid
  // user.telegram_chat_id in config.json) or ANY forwarding (including the owner re-forwarding his own old
  // voice) always lands on 'data'. Fail-safe: never mistakenly 'owner'.
  const trust: VoiceTrust = originTag === 'sender' && !!ownerId && id === ownerId ? 'owner' : 'data'

  return {
    voice_author: sanitizeAuthorName(name),
    ...(id != null ? { voice_author_id: id } : {}),
    voice_author_origin: originTag,
    voice_trust: trust,
  }
}

// ── owner-log passthrough flags for tools/transcribe.sh (OB-12, §6.7) ──────
//
// "Sent by the owner" is deliberately a DIFFERENT test than "authored by the
// owner" (voiceAuthor above) — a voice the owner forwards from someone else
// is HIS message (owner-log flags apply, it's his journal) but NOT his words
// (voice_trust stays 'data', decided separately). `--no-recall` is
// unconditional: the bridge's own second recall pass is never useful on the
// work route (the normal UserPromptSubmit recall now sees the real words).
// msg-id/chat-id are Telegram-supplied integers — validated digit(+optional
// leading '-' for negative group-chat ids)-only before ever reaching a
// command line, so nothing human-typed can land there (A12).
const DIGITS_RE = /^-?\d+$/

export function transcribeFlags(
  sentByOwner: boolean,
  msgId: number | string | undefined,
  chatId: number | string | undefined,
): string[] {
  const flags: string[] = []
  if (sentByOwner) {
    const msgIdStr = msgId != null ? String(msgId) : ''
    const chatIdStr = chatId != null ? String(chatId) : ''
    if (DIGITS_RE.test(msgIdStr)) flags.push('--msg-id', msgIdStr)
    if (DIGITS_RE.test(chatIdStr)) flags.push('--chat-id', chatIdStr)
    flags.push('--source', 'telegram')
  } else {
    // F3 fix (analysis/2026-09-17-voice-bridge-u3-verdict.md): a non-owner
    // transcript must never be archived under a filename that reads as the
    // owner's own words (tools/transcribe.sh only gates the archive on the
    // download path, which is the same for every sender/chat — A9/OB-07
    // widened coverage to all chats/authors, so every stranger's/forwarded
    // voice needs this explicitly).
    flags.push('--no-save')
  }
  flags.push('--no-recall')
  return flags
}

// ── fail-open voice envelope orchestrator (§6.4, A13) ──────────────────────
//
// Effect-injected (download/transcribe are callbacks) — same pattern as
// idea-inbox.ts's transcribeVoiceIdea, so the unit test never spawns a real
// process or touches the network. ANY of the named failure modes (no
// TRANSCRIBE_CMD; download resolves undefined — covers the existing >20MB
// cap; download throws — network/getFile error; transcribe throws with a
// nonzero-exit-style message; transcribe throws with a timeout-style
// message; transcript is blank — silence) gives the placeholder: body =
// caption ?? '(voice message)', meta = the author/trust keys only
// (voiceAuthorMeta) — D-1087 OB-07: a placeholder without them read as the
// owner's own words (`.claude/rules/owner-content-same-turn.md` п.3 «Кто автор —
// решает КОНВЕРТ»). No transcript_source / attachment_path on a placeholder.
export type VoiceEnvelope = {
  text: string
  meta: Record<string, string>
}

export type VoiceDeliveryEffects = {
  download: () => Promise<string | undefined>
  transcribe: (audioPath: string) => Promise<string>
  logNotice: (reason: string) => void
  /** Per-voice journal (owner tg 44445): filled leg by leg; the caller writes ONE line from it. */
  journal?: VoiceJournal
  nowMs?: () => number
  /** How long the voice waits for its file (default DOWNLOAD_TIMEOUT_MS); the download itself is not aborted. */
  downloadTimeoutMs?: number
}

// ── per-voice journal (owner tg 44440 → proposal 44442 → «да» 44445) ─────────
// One line per voice in STATE_DIR/voice.log: what each leg did, how long, and the
// closed class of an error. Never the transcript, the caption, a file path or an
// error text (the bot token lives in file URLs and grammY messages).

export type VoiceErrorClass = 'timeout' | 'network' | 'error' | `http_${number}` | `exit_${number}` | `sys_${string}`
/** A leg's result: ok · none (download gave no file) · empty (no words) · an error class. */
export type VoiceStepResult = 'ok' | 'none' | 'empty' | VoiceErrorClass

export interface VoiceJournal {
  dl?: VoiceStepResult
  dl_ms?: number
  tr?: VoiceStepResult
  tr_ms?: number
  /** Transcript length in UTF-16 units — the length only, never the text. */
  tr_len?: number
  /** The shared download's live journal (tg-download.ts, D-1066): attempts, winner, getFile/file ms, phase, probe. */
  net?: DownloadJournal
}

/** Closed-set class of a download / transcribe failure — derived from the error, never copied. */
export function voiceErrorClass(err: unknown): VoiceErrorClass {
  const e = err as { message?: unknown; error_code?: unknown; code?: unknown; name?: unknown } | null
  const msg = typeof e?.message === 'string' ? e.message : ''
  const http = (n: unknown): VoiceErrorClass | undefined => {
    const c = typeof n === 'string' ? Number(n) : n
    return typeof c === 'number' && Number.isInteger(c) && c >= 100 && c <= 999 ? `http_${c}` : undefined
  }
  if (/timed out/.test(msg)) return 'timeout'
  const byCode = http(e?.error_code) ?? http(/HTTP (\d{3})\b/.exec(msg)?.[1])
  if (byCode) return byCode
  const exited = /exited (\d{1,3})\b/.exec(msg)?.[1]
  if (exited != null) return `exit_${Number(exited)}`
  if (typeof e?.code === 'string' && /^[A-Z0-9_]{1,24}$/.test(e.code)) return `sys_${e.code}`
  if (e?.name === 'HttpError' || e?.name === 'TypeError') return 'network'
  return 'error'
}

/** What the session got: the bridge transcript, or the placeholder and the one reason why. */
export type VoiceOutcome =
  | 'bridge'
  | 'placeholder:no_cmd'
  | 'placeholder:download'
  | 'placeholder:transcribe'
  | 'placeholder:empty'
  | 'placeholder:timeout'
  // D-1087: the one closing line of a voice the late fetcher took (createLateVoiceFetcher).
  | 'late:bridge'
  | 'late:failed'
  | 'late:abandoned'
  // The late text or the lost notice was not accepted by the session transport (Codex r1 f2).
  | 'late:undelivered'

/** The outcome of a finished delivery: what the session got, and for the placeholder the first leg that failed. */
export function voiceOutcomeOf(o: {
  cmdConfigured: boolean
  journal: VoiceJournal
  deliveredBridge: boolean
  timedOut: boolean
}): VoiceOutcome {
  const j = o.journal
  if (o.deliveredBridge) return 'bridge'
  if (!o.cmdConfigured) return 'placeholder:no_cmd'
  if (o.timedOut) return 'placeholder:timeout'
  if (j.dl !== 'ok') return 'placeholder:download'
  if (j.tr === 'empty') return 'placeholder:empty'
  return 'placeholder:transcribe'
}

export interface VoiceLineFields {
  chat: string
  msg: number | undefined
  size?: number
  durS?: number
  journal: VoiceJournal
  outcome: VoiceOutcome
  totalMs: number
  /** Late tries run (1..6) on a `late:*` line; absent (`-`) on a first-delivery line. */
  lateTries?: number
}

const VOICE_RESULT_RE = /^(ok|none|empty|timeout|network|error|http_[0-9]{3}|exit_[0-9]{1,3}|sys_[A-Z0-9_]{1,24})$/
const OUTCOME_LINE_RE = /^(bridge|placeholder:(no_cmd|download|transcribe|empty|timeout)|late:(bridge|failed|abandoned|undelivered))$/

/** One voice.log line, key=value; an absent field is `-`, so every line has the same keys. */
export function formatVoiceLine(tsMs: number, pid: number, f: VoiceLineFields): string {
  const num = (n: number | undefined) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : '-'
  const res = (r: string | undefined) => (r == null ? '-' : VOICE_RESULT_RE.test(r) ? r : 'error')
  const chat = /^-?[0-9]{1,20}$/.test(f.chat) ? f.chat : '-'
  const outcome = OUTCOME_LINE_RE.test(f.outcome) ? f.outcome : 'placeholder:transcribe'
  const j = f.journal
  // D-1066 download keys, closed sets; `-` when absent (no shared download, e.g. no TRANSCRIBE_CMD or the store path).
  const n = j.net
  // Since D-1087 there is one attempt: dl_att / dl_win are 1 or `-`.
  const att = (a: number | undefined) => (a === 1 ? '1' : '-')
  const lt = f.lateTries
  const lateTries = typeof lt === 'number' && Number.isInteger(lt) && lt >= 1 && lt <= 99 ? String(lt) : '-'
  const phase = n && DL_PHASES.has(n.dl_phase) ? n.dl_phase : '-'
  const probe = n?.probe_ms === 'timeout' || n?.probe_ms === 'error' ? n.probe_ms : num(n?.probe_ms as number | undefined)
  return (
    `${new Date(tsMs).toISOString()} pid=${num(pid)} chat=${chat} msg=${num(f.msg)}` +
    ` size=${num(f.size)} dur_s=${num(f.durS)}` +
    ` dl=${res(j.dl)} dl_ms=${num(j.dl_ms)} tr=${res(j.tr)} tr_ms=${num(j.tr_ms)} tr_len=${num(j.tr_len)}` +
    ` outcome=${outcome} total_ms=${num(f.totalMs)}` +
    ` dl_att=${att(n?.dl_att)} dl_win=${att(n?.dl_win)} gf_ms=${num(n?.gf_ms)} fx_ms=${num(n?.fx_ms)}` +
    ` dl_phase=${phase} probe_ms=${probe} late_tries=${lateTries}\n`
  )
}

const DL_PHASES = new Set(['done', 'getfile', 'headers', 'body'])

export const VOICE_LOG = 'voice.log'

/** Appender for STATE_DIR/voice.log. Never throws (fail-open): a logging fault never touches delivery. */
export function createVoiceLog(opts: {
  stateDir: string
  pid?: number
  nowMs?: () => number
  log?: (line: string) => void
}): (f: VoiceLineFields) => void {
  const pid = opts.pid ?? process.pid
  const now = opts.nowMs ?? Date.now
  const write = createStateLineWriter({ file: join(opts.stateDir, VOICE_LOG), goesOn: 'delivery continues', log: opts.log })
  return f => {
    try {
      write(formatVoiceLine(now(), pid, f))
    } catch {}
  }
}

/** The author/trust keys every voice envelope carries — transcript, placeholder, late text and lost notice (D-1087 OB-07). */
export function voiceAuthorMeta(author: VoiceAuthorResult): Record<string, string> {
  return {
    voice_author: author.voice_author,
    ...(author.voice_author_id != null ? { voice_author_id: author.voice_author_id } : {}),
    voice_author_origin: author.voice_author_origin,
    voice_trust: author.voice_trust,
  }
}

/** The placeholder a voice gets when no transcript came (also server.ts's outer envelope-timeout catch). */
export function voicePlaceholder(caption: string | undefined, author: VoiceAuthorResult): VoiceEnvelope {
  return { text: caption ?? '(voice message)', meta: voiceAuthorMeta(author) }
}

export async function deliverVoiceTranscript(
  cmdConfigured: boolean,
  caption: string | undefined,
  author: VoiceAuthorResult,
  fx: VoiceDeliveryEffects,
): Promise<VoiceEnvelope> {
  const fallback = voicePlaceholder(caption, author)

  if (!cmdConfigured) {
    fx.logNotice('SAM_TRANSCRIBE_CMD unset — delivering (voice message) placeholder')
    return fallback
  }

  // Journal writes are plain field sets on a caller-owned object — they cannot throw.
  const j: VoiceJournal = fx.journal ?? {}
  const now = fx.nowMs ?? Date.now

  let audioPath: string | undefined
  let downloadErr: unknown
  const dlStart = now()
  try {
    // The voice's own bound on the file (D-1066 §2 B): past it → dl=timeout → placeholder:download; the shared
    // download is not aborted here (a later download_attachment of the same file joins it).
    const wait = fx.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS
    audioPath = await withTimeout(fx.download(), wait, () => {})
  } catch (err) {
    downloadErr = err
  }
  j.dl_ms = now() - dlStart
  j.dl = audioPath ? 'ok' : downloadErr !== undefined ? voiceErrorClass(downloadErr) : 'none'
  if (!audioPath) {
    fx.logNotice(
      `voice download failed/skipped — falling back to placeholder${downloadErr ? `: ${downloadErr}` : ''}`,
    )
    return fallback
  }

  let transcript: string
  const trStart = now()
  try {
    transcript = (await fx.transcribe(audioPath)).trim()
  } catch (err) {
    j.tr_ms = now() - trStart
    j.tr = voiceErrorClass(err)
    fx.logNotice(`voice transcription failed — falling back to placeholder: ${err}`)
    return fallback
  }
  j.tr_ms = now() - trStart
  j.tr_len = transcript.length
  if (!transcript) {
    j.tr = 'empty'
    fx.logNotice('voice transcription produced empty output (silence?) — falling back to placeholder')
    return fallback
  }
  j.tr = 'ok'

  // Caption is preserved (R9): caption, blank line, transcript.
  const text = caption ? `${caption}\n\n${transcript}` : transcript
  return {
    text,
    meta: {
      transcript_source: 'bridge',
      attachment_path: audioPath,
      ...voiceAuthorMeta(author),
    },
  }
}


// ── late re-fetch of a voice whose file Telegram did not hand over (D-1087) ──
// Owner tg 49563 (option «в») → «Ок, делай в» tg 49565; spec sam-data dev/analysis/2026-11-18-tg-voice-late-fetch-spec.md
// §2 C. The voice was delivered in its place as a placeholder with voice_pending="1"; here the SAME download +
// transcribe run again at +2/5/10/20/40/60 min, on timers, never under the chat's serialize key (texts after the voice
// are never held by a try). The end: a transcript → one late notification (onLate); a file that came but whisper
// failed or gave nothing, or six failed tries → one lost notification (onLost). One voice.log line closes it.
// In memory only (NON-GOAL: persistence); a plugin stop writes `late:abandoned` per entry (abandonAll).

/** Tries, counted from the placeholder (tg 49563: «через 2, 5, 10, 20, 40 и 60 мин»). */
export const LATE_TRY_AFTER_MS: readonly number[] = [2, 5, 10, 20, 40, 60].map(m => m * 60_000)

/** The whole re-fetch of one voice ends by this, counted from the placeholder's accepted wake (Codex r1 f3): the
 * agent's own +70 min record (core .claude/rules/telegram.md) is armed after that wake, so it never fires first. */
export const LATE_DEADLINE_MS = 70 * 60_000

/** Work (tries, whisper) runs up to LATE_DEADLINE_MS; then the one lost notice goes out. The final notification
 * (late text or lost notice) is bounded to the later of the voice's own LATE_DEADLINE_MS and this window counted from
 * the moment the notification starts — so a notice that starts AT the deadline still gets a real window, and a
 * transport that never answers closes the voice once as `late:undelivered` at most this long after the deadline
 * (Codex rr1 f3, rr2-2). */
export const TERMINAL_EMIT_MS = 30_000

/** download_attachment's answer for a file under re-fetch (§2 C): at once, no network call. */
export const LATE_VOICE_REFUSAL =
  'this voice file is being re-fetched by the plugin because Telegram has not handed it over yet — do not download it; ' +
  'its text arrives by itself as a late message with the same message_id and voice_late_s, or as a voice_lost notice'

/** Download classes worth a later try: Telegram/network-side failures. Never `none` (no file_path / too big) or other 4xx. */
export function isRetriableDownload(r: VoiceStepResult | undefined): boolean {
  if (r == null) return false
  return r === 'timeout' || r === 'network' || r === 'error' || r === 'http_429' || /^http_5[0-9]{2}$/.test(r) || r.startsWith('sys_')
}

/** Whether a finished first delivery hands its voice to the late fetcher (§2 C «When»). */
export function lateFetchWanted(o: {
  cmdConfigured: boolean
  deliveredBridge: boolean
  timedOut: boolean
  journal: VoiceJournal
}): boolean {
  return o.cmdConfigured && !o.deliveredBridge && !o.timedOut && isRetriableDownload(o.journal.dl)
}

/** The placeholder gets voice_pending="1" only when a re-fetch really got scheduled. */
export function markPending(placeholder: VoiceEnvelope, scheduled: boolean): VoiceEnvelope {
  return scheduled ? { text: placeholder.text, meta: { ...placeholder.meta, voice_pending: '1' } } : placeholder
}

export interface LateVoice {
  chat: string
  msg: number
  fileId: string
  size?: number
  durS?: number
  /** The voice's Telegram time, ms — voice_late_s counts from it. */
  tsMs: number
  /** When the voice reached the plugin, ms — total_ms of the closing line counts from it. */
  arrivedMs: number
  /** When the placeholder went out, ms — the tries count from it. */
  placeholderMs: number
  caption?: string
  author: VoiceAuthorResult
  /** The first delivery's own download effect (store path for someone else's voice, inbox for the owner's). */
  download: (journal: VoiceJournal) => Promise<string | undefined>
  /** The first delivery's own transcribe effect (whisper mutex + the original transcribeFlags); `signal` aborts at the
   * deadline — a job still queued then never starts (voiceTranscribeEffect). */
  transcribe: (audioPath: string, signal?: AbortSignal) => Promise<string>
  /** The transcript came: the envelope as deliverVoiceTranscript built it, lateS = whole seconds since tsMs.
   * Resolves when the session transport accepted it; a rejection closes the voice as `late:undelivered`. */
  onLate: (late: VoiceEnvelope, lateS: number) => void | Promise<void>
  /** Telegram never handed the file over (or whisper failed on it, or the deadline came). Same contract as onLate. */
  onLost: () => void | Promise<void>
}

export interface LateVoiceFetcher {
  /** Reserve chat+msg for a re-fetch whose placeholder is about to be woken (Codex rr1-1: eligibility is per message,
   * never per file_id — two messages may share one Telegram file_id). false when that chat+msg is already reserved or
   * taken. The reservation ends in exactly one of schedule() (accepted wake) or release() (wake not accepted). */
  reserve: (chat: string, msg: number) => boolean
  /** The placeholder's wake was not accepted: drop the reservation and write the one closing `late:undelivered` line,
   * so a leg does not wait the whole deadline for a voice that will never be re-fetched (security re-review N9). */
  release: (v: Omit<LateVoice, 'placeholderMs'>) => void
  /** Take a voice (consumes its reservation); false when that chat+msg is already taken. */
  schedule: (v: LateVoice) => boolean
  /** A file_id under re-fetch right now — download_attachment's refusal only, never retry eligibility. */
  has: (fileId: string) => boolean
  /** Plugin stop: one `late:abandoned` line per open entry, synchronously; nothing runs after. Returns the count. */
  abandonAll: () => number
  size: () => number
}

export function createLateVoiceFetcher(deps: {
  writeLine: (f: VoiceLineFields) => void
  logNotice: (reason: string) => void
  nowMs?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  tryAfterMs?: readonly number[]
  downloadTimeoutMs?: number
  deadlineMs?: number
  terminalEmitMs?: number
}): LateVoiceFetcher {
  const now = deps.nowMs ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const offsets = deps.tryAfterMs ?? LATE_TRY_AFTER_MS
  const deadlineMs = deps.deadlineMs ?? LATE_DEADLINE_MS
  const terminalEmitMs = deps.terminalEmitMs ?? TERMINAL_EMIT_MS
  type Entry = LateVoice & {
    key: string
    tries: number
    timer?: unknown
    deadline?: unknown
    /** The final notification's own bound: max(the voice's hard end, TERMINAL_EMIT_MS from its start) (rr1 f3, rr2-2). */
    emitTimer?: unknown
    /** No more tries: the final notification is going out (or the voice was abandoned). */
    done: boolean
    /** The closing voice.log line is written and the entry is gone. */
    closed: boolean
    last: VoiceJournal
    abort: AbortController
  }
  const entries = new Map<string, Entry>()
  /** chat+msg whose placeholder wake is in flight (reserve → schedule | release). */
  const reserved = new Set<string>()

  const line =(e: Entry, outcome: VoiceOutcome) => {
    try {
      deps.writeLine({
        chat: e.chat,
        msg: e.msg,
        size: e.size,
        durS: e.durS,
        journal: { ...e.last },
        outcome,
        totalMs: now() - e.arrivedMs,
        lateTries: e.tries,
      })
    } catch {}
  }
  const stop = (e: Entry) => {
    e.done = true
    if (e.timer !== undefined) clearTimer(e.timer)
    if (e.deadline !== undefined) clearTimer(e.deadline)
    e.timer = e.deadline = undefined
    e.abort.abort() // a whisper job still queued for this voice never starts; a running one is killed
  }
  const close = (e: Entry, outcome: VoiceOutcome) => {
    if (e.closed) return
    e.closed = true
    if (e.emitTimer !== undefined) clearTimer(e.emitTimer)
    e.emitTimer = undefined
    entries.delete(e.key)
    line(e, outcome)
  }
  // The final notification: the entry stays (download_attachment still refused) until the transport answers; only an
  // accepted one writes late:bridge / late:failed; a rejected one — or one still unanswered at the hard end (the later of
  // placeholder + deadlineMs and TERMINAL_EMIT_MS after it started) — writes late:undelivered (Codex r1 f2, rr1 f3,
  // rr2-2). close() is once-only, so a transport answer that comes after the hard end changes nothing.
  async function finish(e: Entry, emit: () => void | Promise<void>, ok: VoiceOutcome, what: string): Promise<void> {
    stop(e)
    const sent = (async () => {
      await emit()
      return 'sent' as const
    })()
    const hardEnd = new Promise<'late'>(resolve => {
      e.emitTimer = setTimer(() => resolve('late'), Math.max(terminalEmitMs, e.placeholderMs + deadlineMs - now()))
    })
    try {
      if ((await Promise.race([sent, hardEnd])) === 'late') {
        deps.logNotice(`${what} notification still not accepted by the session at the deadline`)
        close(e, 'late:undelivered')
      } else close(e, ok)
    } catch (err) {
      deps.logNotice(`${what} notification not accepted by the session: ${voiceErrorClass(err)}`)
      close(e, 'late:undelivered')
    }
  }
  const lost = (e: Entry) => finish(e, () => e.onLost(), 'late:failed', 'lost')
  // The next try is due at placeholder + offsets[tries]; one already overdue (the previous try ran long) starts now —
  // tries of one voice never overlap because the next is armed only after the previous settled.
  const arm = (e: Entry) => {
    e.timer = setTimer(() => void run(e), Math.max(0, e.placeholderMs + offsets[e.tries] - now()))
  }
  async function run(e: Entry): Promise<void> {
    if (e.done) return
    e.timer = undefined
    e.tries++
    const journal: VoiceJournal = {}
    e.last = journal
    let got: VoiceEnvelope | undefined
    try {
      got = await deliverVoiceTranscript(true, e.caption, e.author, {
        journal,
        download: () => e.download(journal),
        transcribe: p => e.transcribe(p, e.abort.signal),
        logNotice: r => deps.logNotice(`late try ${e.tries}: ${r}`),
        nowMs: now,
        downloadTimeoutMs: deps.downloadTimeoutMs,
      })
    } catch (err) {
      deps.logNotice(`late try ${e.tries} crashed: ${voiceErrorClass(err)}`)
    }
    if (e.done) return // abandoned, or the deadline came while it ran
    if (got?.meta.transcript_source === 'bridge') {
      const late = got
      return finish(e, () => e.onLate(late, Math.max(0, Math.round((now() - e.tsMs) / 1000))), 'late:bridge', 'late')
    }
    if (journal.dl === 'ok' || e.tries >= offsets.length) return lost(e)
    arm(e)
  }

  return {
    reserve(chat, msg) {
      const key = `${chat}:${msg}`
      if (entries.has(key) || reserved.has(key) || offsets.length === 0) return false
      reserved.add(key)
      return true
    },
    release(v) {
      reserved.delete(`${v.chat}:${v.msg}`)
      line(
        { ...v, key: `${v.chat}:${v.msg}`, placeholderMs: now(), tries: 0, done: true, closed: true, last: {}, abort: new AbortController() },
        'late:undelivered',
      )
    },
    schedule(v) {
      const key = `${v.chat}:${v.msg}`
      reserved.delete(key)
      if (entries.has(key) || offsets.length === 0) return false
      const e: Entry = { ...v, key, tries: 0, done: false, closed: false, last: {}, abort: new AbortController() }
      entries.set(key, e)
      arm(e)
      // The work/abort deadline is the declared end of the re-fetch (+70 min); a lost notice sent then gets its own
      // TERMINAL_EMIT_MS window (finish).
      e.deadline = setTimer(() => {
        if (e.done) return
        deps.logNotice(`late re-fetch of msg ${e.msg} ran out of time after ${e.tries} tries`)
        void lost(e)
      }, Math.max(0, e.placeholderMs + deadlineMs - now()))
      return true
    },
    has(fileId) {
      for (const e of entries.values()) if (e.fileId === fileId) return true
      return false
    },
    abandonAll() {
      const all = [...entries.values()]
      reserved.clear()
      for (const e of all) {
        stop(e)
        close(e, 'late:abandoned')
      }
      return all.length
    },
    size: () => entries.size,
  }
}

/** D-1087 / Codex r1 f1: the placeholder's wake first; the late fetcher takes the voice only once the session accepted
 * that wake (`wake` resolves true). A rejected wake leaves nothing armed — no late or lost notice for a voice whose
 * placeholder never arrived. The tries and the deadline count from the accepted wake. */
export async function wakeThenArm(o: {
  fetcher: LateVoiceFetcher
  envelope: VoiceEnvelope
  /** The voice to re-fetch, when lateFetchWanted said so; undefined for every other message. */
  late?: Omit<LateVoice, 'placeholderMs'>
  wake: (envelope: VoiceEnvelope) => Promise<boolean>
  nowMs?: () => number
}): Promise<boolean> {
  // Eligibility is per chat+msg (Codex rr1-1): the pending marker and the reservation are one decision, and a shared
  // Telegram file_id never blocks a second message. The reservation ends in schedule (accepted) or release (not).
  const late = o.late
  const reserved = late != null && o.fetcher.reserve(late.chat, late.msg)
  let accepted = false
  try {
    accepted = await o.wake(markPending(o.envelope, reserved))
  } finally {
    if (reserved) {
      if (accepted) o.fetcher.schedule({ ...late!, placeholderMs: (o.nowMs ?? Date.now)() })
      else o.fetcher.release(late!)
    }
  }
  return accepted
}

/** A voice's download effects (D-883 store path; Codex r1 f4). `keep` is the chat-store keep of someone else's voice,
 * undefined for the person's own voice (the inbox). The first delivery falls back to the inbox when the keep gives no
 * file; a late try makes exactly ONE Bot API request — the keep alone, or the inbox alone — so no second getFile is
 * left running after the try's own wait. */
export function voiceDownloadEffects(o: {
  keep: (() => Promise<string | undefined>) | undefined
  inbox: (journal: VoiceJournal) => Promise<string | undefined>
}): { first: (journal: VoiceJournal) => Promise<string | undefined>; late: (journal: VoiceJournal) => Promise<string | undefined> } {
  const keep = o.keep
  if (!keep) return { first: o.inbox, late: o.inbox }
  return { first: async j => (await keep()) ?? o.inbox(j), late: () => keep() }
}

/** A voice's transcribe effect: the shared whisper queue + the original transcribeFlags (owner-log extract for the
 * person's own voice, --no-save for anyone else's). An aborted signal (the late deadline) refuses a job that is still
 * queued and is passed on so a running one is killed (Codex r1 f3, f6). */
export function voiceTranscribeEffect(o: {
  ownerSent: boolean
  msgId: number | undefined
  chatId: string
  queue: <T>(job: () => Promise<T>) => Promise<T>
  run: (audioPath: string, extraArgs: string[], signal?: AbortSignal) => Promise<string>
}): (audioPath: string, signal?: AbortSignal) => Promise<string> {
  const flags = transcribeFlags(o.ownerSent, o.msgId, o.chatId)
  return (audioPath, signal) =>
    o.queue(async () => {
      if (signal?.aborted) throw new Error('late voice ran out of time before whisper started')
      return o.run(audioPath, [...flags], signal)
    })
}
