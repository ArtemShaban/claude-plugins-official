/**
 * Telegram-bridge voice transcription (variant A) — pure / effect-injected
 * building blocks. SemenAssistant analysis/2026-09-17-bridge-voice-spec-
 * FINAL.md is the SSOT for scope + acceptance criteria; this module carries
 * only the parts that need to be UNIT-testable.
 *
 * Kept as its OWN module rather than inline in server.ts because
 * server.test.ts does NOT import server.ts (F16 in the spec) — server.ts
 * has top-level side effects (reads the bot token off disk, `process.exit(1)`
 * on misconfig) that make it unsafe to import from a test file. This module
 * has none: it only imports TYPES from grammy (erased at compile time, zero
 * runtime footprint). server.ts wires the real I/O (spawn/fetch/fs) and
 * calls into this module's effect-injected orchestrators — the exact same
 * seam idea-inbox.ts already uses for `transcribeVoiceIdea` /
 * `downloadIdeaAttachment`.
 */
import type { Chat, MessageOrigin, User } from 'grammy/types'

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
  } else if (origin.type === 'user') {
    originTag = 'forward_user'
    id = String(origin.sender_user.id)
    name = origin.sender_user.username ?? origin.sender_user.first_name ?? String(origin.sender_user.id)
  } else if (origin.type === 'hidden_user') {
    originTag = 'forward_hidden_user'
    id = undefined
    name = origin.sender_user_name
  } else if (origin.type === 'chat') {
    originTag = 'forward_chat'
    id = String(origin.sender_chat.id)
    name = chatDisplayName(origin.sender_chat)
  } else {
    originTag = 'forward_channel'
    id = String(origin.chat.id)
    name = chatDisplayName(origin.chat)
  }

  // A7: owner trust requires BOTH a non-forwarded message AND the author id
  // matching the configured owner id — an empty ownerId (SEMEN_OWNER_TG_ID
  // unset) or ANY forwarding (including the owner re-forwarding his own old
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
}

export async function deliverVoiceTranscript(
  cmdConfigured: boolean,
  caption: string | undefined,
  author: VoiceAuthorResult,
  fx: VoiceDeliveryEffects,
): Promise<VoiceEnvelope> {
  const fallback: VoiceEnvelope = { text: caption ?? '(voice message)', meta: {} }

  if (!cmdConfigured) {
    fx.logNotice('TRANSCRIBE_CMD unset — delivering (voice message) placeholder')
    return fallback
  }

  let audioPath: string | undefined
  let downloadErr: unknown
  try {
    audioPath = await fx.download()
  } catch (err) {
    downloadErr = err
  }
  if (!audioPath) {
    fx.logNotice(
      `voice download failed/skipped — falling back to placeholder${downloadErr ? `: ${downloadErr}` : ''}`,
    )
    return fallback
  }

  let transcript: string
  try {
    transcript = (await fx.transcribe(audioPath)).trim()
  } catch (err) {
    fx.logNotice(`voice transcription failed — falling back to placeholder: ${err}`)
    return fallback
  }
  if (!transcript) {
    fx.logNotice('voice transcription produced empty output (silence?) — falling back to placeholder')
    return fallback
  }

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
