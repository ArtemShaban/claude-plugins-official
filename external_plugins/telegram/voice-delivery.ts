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
export const DOWNLOAD_TIMEOUT_MS = 30_000

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
// process or touches the network. ANY of the six named failure modes (no
// TRANSCRIBE_CMD; download resolves undefined — covers the existing >20MB
// cap; download throws — network/getFile error; transcribe throws with a
// nonzero-exit-style message; transcribe throws with a timeout-style
// message; transcript is blank — silence) must produce an envelope that is
// byte-identical to today's baseline: body = caption ?? '(voice message)',
// meta = {} (no transcript_source/attachment_path/voice_* keys at all).
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
}

const VOICE_RESULT_RE = /^(ok|none|empty|timeout|network|error|http_[0-9]{3}|exit_[0-9]{1,3}|sys_[A-Z0-9_]{1,24})$/
const OUTCOME_LINE_RE = /^(bridge|placeholder:(no_cmd|download|transcribe|empty|timeout))$/

/** One voice.log line, key=value; an absent field is `-`, so every line has the same keys. */
export function formatVoiceLine(tsMs: number, pid: number, f: VoiceLineFields): string {
  const num = (n: number | undefined) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : '-'
  const res = (r: string | undefined) => (r == null ? '-' : VOICE_RESULT_RE.test(r) ? r : 'error')
  const chat = /^-?[0-9]{1,20}$/.test(f.chat) ? f.chat : '-'
  const outcome = OUTCOME_LINE_RE.test(f.outcome) ? f.outcome : 'placeholder:transcribe'
  const j = f.journal
  return (
    `${new Date(tsMs).toISOString()} pid=${num(pid)} chat=${chat} msg=${num(f.msg)}` +
    ` size=${num(f.size)} dur_s=${num(f.durS)}` +
    ` dl=${res(j.dl)} dl_ms=${num(j.dl_ms)} tr=${res(j.tr)} tr_ms=${num(j.tr_ms)} tr_len=${num(j.tr_len)}` +
    ` outcome=${outcome} total_ms=${num(f.totalMs)}\n`
  )
}

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

export async function deliverVoiceTranscript(
  cmdConfigured: boolean,
  caption: string | undefined,
  author: VoiceAuthorResult,
  fx: VoiceDeliveryEffects,
): Promise<VoiceEnvelope> {
  const fallback: VoiceEnvelope = { text: caption ?? '(voice message)', meta: {} }

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
    audioPath = await fx.download()
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
      voice_author: author.voice_author,
      ...(author.voice_author_id != null ? { voice_author_id: author.voice_author_id } : {}),
      voice_author_origin: author.voice_author_origin,
      voice_trust: author.voice_trust,
    },
  }
}
