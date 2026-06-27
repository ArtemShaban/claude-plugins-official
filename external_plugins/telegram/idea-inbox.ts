// idea-inbox.ts — topic-routing + durable capture for the Telegram channel.
//
// Pure, side-effect-isolated helpers extracted from server.ts so they can be
// unit-tested without the grammY runtime, a bot token, or a network. server.ts
// imports classifyRoute / persistIdea / ideaInboxDir from here.
//
// The CRUX (see idea-inbox spec): every accepted inbound update today wakes the
// main Claude session via mcp.notification. classifyRoute decides whether an
// update is captured ASYNC (persisted, session NOT woken) or routed 'work'
// (current behaviour, session woken). DEFAULT IS 'work' — a real work message
// must never be silently swallowed; async only happens for explicitly-listed
// forum topic ids.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type Route = 'work' | 'async' | 'ignore'

/** Minimal shape classifyRoute needs from the channel Access config. */
export type RouteAccess = {
  allowFrom: string[]
  groups: Record<string, { asyncThreads?: string[] }>
}

/**
 * Decide how an inbound update routes, purely from config + identifiers.
 *
 * - 'ignore'  — chat is neither an allowlisted DM nor a configured group.
 *               (gate() already drops these; this is belt-and-suspenders.)
 * - 'async'   — chat is a configured group AND threadId is in that group's
 *               asyncThreads allowlist => persist without waking the session.
 * - 'work'    — everything else: DM, General (threadId undefined), the named
 *               'work' topic, any non-async topic => wake the session (today's
 *               behaviour). THIS IS THE SAFE DEFAULT.
 *
 * @param threadId ctx.message?.message_thread_id (undefined for General / DM)
 * @param asyncEnabled false => async routing is globally disabled (e.g. the
 *        IDEA_INBOX_DIR env is unset) => everything routes 'work' (fail-safe).
 */
export function classifyRoute(
  access: RouteAccess,
  chat_id: string,
  threadId: number | undefined,
  asyncEnabled = true,
): Route {
  const isDm = access.allowFrom.includes(chat_id)
  const group = access.groups[chat_id]
  if (!isDm && !group) return 'ignore'

  if (!asyncEnabled) return 'work'
  if (!group) return 'work' // a DM is never async
  const asyncThreads = group.asyncThreads ?? []
  if (threadId != null && asyncThreads.includes(String(threadId))) return 'async'
  return 'work'
}

/**
 * Reaction-side analog of classifyRoute (CRUX, reaction parity).
 *
 * Telegram's MessageReactionUpdated carries NO message_thread_id — unlike a
 * message, a reaction update doesn't tell us which forum topic it happened in.
 * So a reaction on an Ideas-thread (async) message would still wake the session,
 * even though the message itself was captured silently. We close that gap by
 * mapping the reacted message_id back to its thread via the DURABLE idea store
 * (chosen over an in-memory Map: the store survives a plugin restart, so a
 * reaction on an idea captured before the restart is still correctly silenced —
 * an in-memory map would lose that and re-open the bug after every restart; it
 * also reuses findIdea/ideaId with no new state to keep in sync).
 *
 * Returns true (SUPPRESS — do not notify) ONLY when ALL hold:
 *   - async is enabled (dir set) AND the chat is a configured group,
 *   - the group has async threads,
 *   - the reacted message is in the store AND its recorded thread_id is one of
 *     that group's CURRENT async threads (re-checked, so removing a thread from
 *     asyncThreads re-enables its reactions).
 *
 * Everything else => false = DEFAULT-SAFE: let the reaction through. In
 * particular an UNKNOWN message_id (a reaction on one of Семён's own messages, a
 * work message, or anything captured before the store existed) is never
 * suppressed — we must never silently drop a reaction on a non-Ideas message.
 */
export function shouldSuppressReaction(
  access: RouteAccess,
  dir: string | undefined,
  chat_id: string,
  message_id: number,
): boolean {
  if (!dir) return false // async disabled => never suppress
  const group = access.groups[chat_id]
  if (!group) return false // DM / unconfigured chat => never an async source
  const asyncThreads = group.asyncThreads ?? []
  if (asyncThreads.length === 0) return false
  const rec = findIdea(join(dir, 'inbox.jsonl'), ideaId(chat_id, message_id))
  if (!rec) return false // unknown message => DEFAULT-SAFE, let it through
  return rec.thread_id != null && asyncThreads.includes(rec.thread_id)
}

// ── durable store ──────────────────────────────────────────────────────────

/**
 * Resolve the idea-inbox directory from env. Returns undefined when
 * IDEA_INBOX_DIR is unset — the caller treats that as "async disabled"
 * (fail-safe: the channel keeps working, everything routes 'work').
 */
export function ideaInboxDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const d = env.IDEA_INBOX_DIR
  return d && d.trim() ? d : undefined
}

/**
 * Resolve the voice-transcription command from env. Returns undefined when
 * SEMEN_TRANSCRIBE_CMD is unset/blank — the caller treats that as
 * "transcription disabled" (fail-safe: the voice idea stays status:'new' with
 * its file_id, transcription deferred to triage; the channel never errors).
 * NOT an absolute path baked into the plugin — the orchestrator wires the actual
 * command (a whisper wrapper) in start-semen.sh. Contract: the command receives
 * the audio file path as $1 and the language ('ru') as $2 and prints the
 * transcript to stdout.
 */
export function transcribeCmd(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const c = env.SEMEN_TRANSCRIBE_CMD
  if (c && c.trim()) return c
  // Fallback (so voice-transcribe works without a separate env wire / session
  // restart): derive the repo's tools/transcribe.sh from IDEA_INBOX_DIR, which is
  // `<repo>/tasks/idea-inbox`. Still overridable via SEMEN_TRANSCRIBE_CMD.
  const inbox = env.IDEA_INBOX_DIR
  if (inbox && inbox.trim()) {
    return join(dirname(dirname(inbox)), 'tools', 'transcribe.sh')
  }
  return undefined
}

/**
 * Resolve the text-to-speech command (used by the reply tool's voice:true
 * option to synthesize a Telegram voice bubble). Returns undefined when neither
 * SEMEN_TTS_CMD nor IDEA_INBOX_DIR is set — the caller treats that as "voice
 * disabled" (fail-safe: the text reply is unaffected; the voice bubble is simply
 * skipped). Mirrors transcribeCmd exactly: SEMEN_TTS_CMD wins, else derive the
 * repo's tools/tts.sh from IDEA_INBOX_DIR (which is `<repo>/tasks/idea-inbox`),
 * else undefined. Contract: `<cmd> "<text>" <out.ogg> ru` writes an Opus .ogg.
 */
export function ttsCmd(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const c = env.SEMEN_TTS_CMD
  if (c && c.trim()) return c
  const inbox = env.IDEA_INBOX_DIR
  if (inbox && inbox.trim()) {
    return join(dirname(dirname(inbox)), 'tools', 'tts.sh')
  }
  return undefined
}

export type IdeaRecord = {
  id: string
  ts_captured: string
  from_user_id: string
  thread_id: string | null
  kind: string
  text?: string
  transcript?: string
  attachment_file_id?: string
  attachment_path?: string
  reply_to_message_id?: string
  status: string
  ts_status: string
}

export type PersistInput = {
  chat_id: string
  message_id: number
  from_user_id: string
  thread_id?: number
  /** unix seconds (ctx.message.date); converted to ISO ts_captured */
  date?: number
  kind: string
  text?: string
  attachment_file_id?: string
  reply_to_message_id?: string
}

/** Stable id => restart/retry of the same Telegram message never duplicates. */
export function ideaId(chat_id: string, message_id: number): string {
  return `telegram:${chat_id}:${message_id}`
}

/**
 * Find a stored idea record by id. The single JSONL reader, reused by
 * ideaExists, the persist idempotency check, and reaction thread-lookup (DRY).
 * Returns the record, or undefined (no file / not found / unparseable line).
 */
export function findIdea(jsonlPath: string, id: string): IdeaRecord | undefined {
  let raw: string
  try {
    raw = readFileSync(jsonlPath, 'utf8')
  } catch {
    return undefined // no file yet => nothing recorded
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as IdeaRecord
      if (r.id === id) return r
    } catch {
      // tolerate a partially-written trailing line
    }
  }
  return undefined
}

/** True if `id` already exists in the JSONL file (idempotency check). */
export function ideaExists(jsonlPath: string, id: string): boolean {
  return findIdea(jsonlPath, id) !== undefined
}

/**
 * Append one idea to inbox.jsonl. Idempotent by id (a repeat of the same
 * Telegram message — e.g. after a restart — is a no-op, returns the existing
 * record). Throws on a real write failure so the caller takes the loud
 * error path (no false ✍ ack). Voice records persist as status:'new' with the
 * file_id so the original is never lost even if transcription later fails.
 *
 * @returns the record that is now durable (newly written or pre-existing).
 */
export function persistIdea(dir: string, input: PersistInput): IdeaRecord {
  const jsonlPath = join(dir, 'inbox.jsonl')
  const id = ideaId(input.chat_id, input.message_id)

  // Idempotency: if this id already exists, return it without re-appending.
  const existing = findIdea(jsonlPath, id)
  if (existing) return existing

  const nowIso = new Date().toISOString()
  const status = input.kind === 'voice' ? 'new' : 'ready'
  const rec: IdeaRecord = {
    id,
    ts_captured: input.date ? new Date(input.date * 1000).toISOString() : nowIso,
    from_user_id: input.from_user_id,
    thread_id: input.thread_id != null ? String(input.thread_id) : null,
    kind: input.kind,
    ...(input.text ? { text: input.text } : {}),
    ...(input.attachment_file_id ? { attachment_file_id: input.attachment_file_id } : {}),
    ...(input.reply_to_message_id ? { reply_to_message_id: input.reply_to_message_id } : {}),
    status,
    ts_status: nowIso,
  }

  // Ensure store layout exists, then append-as-one-line. mkdir + append are the
  // durable steps and run BEFORE the caller reacts/returns.
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  mkdirSync(join(dir, 'transcripts'), { recursive: true })
  appendFileSync(jsonlPath, JSON.stringify(rec) + '\n')
  return rec
}

/**
 * Snapshot-cutoff selection for Фаза-2 triage ("вылей идеи"): all records with
 * status 'ready' whose message_id <= the current max ready message_id. Records
 * captured during triage (higher message_id) are deferred to the next pour.
 * Pure over the parsed records => unit-testable.
 */
export function selectReadyForPour(records: IdeaRecord[]): IdeaRecord[] {
  const ready = records.filter(r => r.status === 'ready')
  if (ready.length === 0) return []
  const msgIdOf = (r: IdeaRecord): number => {
    const parts = r.id.split(':')
    return parseInt(parts[parts.length - 1]!, 10)
  }
  const cutoff = Math.max(...ready.map(msgIdOf))
  return ready
    .filter(r => msgIdOf(r) <= cutoff)
    .sort((a, b) => {
      const t = a.ts_captured.localeCompare(b.ts_captured)
      return t !== 0 ? t : msgIdOf(a) - msgIdOf(b)
    })
}

// ── routing seam (the no-interrupt guarantee, tested against PRODUCTION code) ──
//
// dispatchIdeaRoute owns the notify-vs-persist DECISION + the order of side
// effects for an already-gated inbound update. server.ts's handleInbound calls
// it with effect callbacks bound to the grammY runtime; the unit test calls the
// SAME function with mocked effects. Because the production path runs through
// here (no replica), moving the async-branch return below the notification, or
// adding a notify before persist, changes THIS function and a test goes red.
//
// Invariants enforced here (the whole point of the seam):
//  - route 'ignore'            -> nothing (gate already dropped it).
//  - route 'async' + msgId set + persist OK
//                              -> persist, react(✍), DO NOT notify.
//  - route 'async' + msgId is null/undefined (would coerce to id ...:0 and let a
//    second such message be silently dropped by idempotency)
//                              -> the SAME loud failure path: warnUser + stderr,
//                                 NO ✍, DO NOT notify. (FIX C2)
//  - route 'async' + persist throws
//                              -> warnUser + stderr, NO ✍, DO NOT notify. (R-LOSS)
//  - route 'work' (DM / General / any non-async topic)
//                              -> notify (wake the session) — the SAFE DEFAULT.

/** What dispatchIdeaRoute did — returned so callers/tests can assert the path. */
export type IdeaRouteOutcome = 'ignored' | 'persisted' | 'persist-failed' | 'work'

/**
 * Side effects dispatchIdeaRoute may invoke. server.ts binds these to grammY;
 * tests pass spies. persist throwing is the persist-failure signal.
 */
export type IdeaRouteEffects = {
  /** Append the idea to the durable store (throws on a real write failure). */
  persist: (input: PersistInput) => void
  /** Quiet ✍ ack on the captured message (no push ping). Async-success only. */
  react: () => void
  /** Loud, user-visible "not saved" warning (persist-failure / missing id). */
  warnUser: () => void
  /** Log a one-line reason to stderr on the failure path. */
  logError: (reason: string) => void
  /** Wake the main Claude session (mcp.notification). 'work' route only. */
  notify: () => void
}

/**
 * Drive the idea-inbox routing decision for one gated inbound update.
 *
 * @param route   classifyRoute(...) result.
 * @param msgId   ctx.message?.message_id — null/undefined is a HARD failure for
 *                the async route (see FIX C2): persisting with a coerced 0 would
 *                mis-id the record and let idempotency silently drop a second
 *                id-less message. We refuse to persist and take the loud path.
 * @param input   the PersistInput sans message_id (filled in here once msgId is
 *                proven non-null, so a 0 can never be persisted).
 */
export function dispatchIdeaRoute(
  route: Route,
  msgId: number | null | undefined,
  input: Omit<PersistInput, 'message_id'>,
  fx: IdeaRouteEffects,
): IdeaRouteOutcome {
  if (route === 'ignore') return 'ignored'

  if (route === 'async') {
    // FIX C2: a missing message_id must NEVER be coerced to 0 (silent mis-id +
    // idempotency drop). Fail loud on the SAME path as a persist failure.
    if (msgId == null) {
      fx.logError('idea-inbox: missing message_id — refusing to persist (would mis-id as :0)')
      fx.warnUser()
      return 'persist-failed' // no react, no notify
    }
    try {
      fx.persist({ ...input, message_id: msgId })
    } catch (err) {
      // R-LOSS: a persist failure must be LOUD — never a false ✍ success.
      fx.logError(`idea-inbox persist FAILED: ${err}`)
      fx.warnUser()
      return 'persist-failed' // no react, no notify
    }
    // Durable write succeeded => quiet ✍ ack only. CRITICAL: do NOT notify.
    fx.react()
    return 'persisted'
  }

  // route === 'work': the safe default — wake the session.
  fx.notify()
  return 'work'
}

/**
 * Atomically merge a patch into a single record (matched by id), always bumping
 * ts_status. The shared writer behind setIdeaStatus and recordTranscript (DRY:
 * one read→rewrite→atomic-rename path). Returns false (no write) when the file
 * is missing or the id isn't found. Unknown patch keys are merged as-is — the
 * caller is responsible for passing valid IdeaRecord fields.
 */
export function patchIdea(jsonlPath: string, id: string, patch: Partial<IdeaRecord>): boolean {
  let raw: string
  try {
    raw = readFileSync(jsonlPath, 'utf8')
  } catch {
    return false
  }
  let found = false
  const out = raw
    .split('\n')
    .map(line => {
      if (!line.trim()) return line
      try {
        const r = JSON.parse(line) as IdeaRecord
        if (r.id === id) {
          found = true
          Object.assign(r, patch, { ts_status: new Date().toISOString() })
          return JSON.stringify(r)
        }
      } catch {}
      return line
    })
    .join('\n')
  if (!found) return false
  const tmp = jsonlPath + '.tmp'
  writeFileSync(tmp, out)
  renameSync(tmp, jsonlPath)
  return true
}

/** Atomically rewrite a single record's status (used by Фаза-2 triage). */
export function setIdeaStatus(jsonlPath: string, id: string, status: string): boolean {
  return patchIdea(jsonlPath, id, { status })
}

/**
 * Persist a successful transcription: write the transcript text to a file under
 * transcripts/ (durable, greppable) AND patch the record in-place with the
 * transcript, the saved audio path, and status:'ready' (pourable with text).
 * Returns false if the record id isn't in the store (caller logs loud — the
 * voice idea then stays status:'new' with its file_id, never lost).
 */
export function recordTranscript(
  dir: string,
  id: string,
  transcript: string,
  attachmentPath?: string,
): boolean {
  const jsonlPath = join(dir, 'inbox.jsonl')
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, '_')
  mkdirSync(join(dir, 'transcripts'), { recursive: true })
  writeFileSync(join(dir, 'transcripts', `${safeId}.txt`), transcript)
  return patchIdea(jsonlPath, id, {
    transcript,
    ...(attachmentPath ? { attachment_path: attachmentPath } : {}),
    status: 'ready',
  })
}

// ── voice transcription orchestrator (effect-injected, runtime-agnostic) ──────
//
// Same seam pattern as dispatchIdeaRoute: server.ts binds the effects to grammY
// + the shell-out + the store; the unit test passes mocks/spies (NO real whisper,
// NO real download). The PRODUCTION path runs through this function, so the
// failure-safety invariants are tested against the real code.
//
// Invariants (the whole point of "never lose the original voice idea"):
//  - cmd not configured        -> SKIP, log a notice, idea stays 'new'.
//  - download fails / no file  -> stays 'new' (file_id retained), loud log,
//                                 brief failure reply, NO status flip.
//  - transcribe throws/empty   -> stays 'new', loud log, failure reply.
//  - store flip (onSuccess) fails -> stays 'new', loud log, but we DID get a
//                                 transcript so we still reply it to the user.
//  - all good                  -> onSuccess flips to 'ready', reply the transcript.

export type TranscribeOutcome = 'skipped' | 'ready' | 'failed'

/** Effects transcribeVoiceIdea drives. server.ts binds grammY/shell/store; tests spy. */
export type TranscribeEffects = {
  /** Download the voice file to attachments/; resolves to the local path, or
   *  undefined when no file is available (expired / over the 20MB cap). */
  download: () => Promise<string | undefined>
  /** Run the transcribe command on the audio path; resolves the transcript,
   *  rejects on a spawn/non-zero-exit failure. */
  transcribe: (audioPath: string) => Promise<string>
  /** Persist transcript + flip status:'ready' (recordTranscript). false/throw =>
   *  store failure (idea kept 'new'). */
  onSuccess: (transcript: string, audioPath: string) => boolean | void
  /** Reply the transcript to the user (🎤 Транскрипт:). Best-effort. */
  replyTranscript: (transcript: string) => Promise<void> | void
  /** Brief "couldn't transcribe" reply on a failure path. Best-effort. */
  replyFailure: () => Promise<void> | void
  /** Loud stderr on a failure path. */
  logError: (reason: string) => void
  /** Quiet notice (cmd unset / skipped). */
  logNotice: (reason: string) => void
}

async function safeCall(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
  } catch {
    // best-effort side effect (a reply) — never let it break the orchestrator.
  }
}

/**
 * Transcribe a just-persisted voice idea, FAILURE-SAFE. Resolves to the outcome;
 * never rejects for an expected failure (download/transcribe/store) — the caller
 * runs this fire-and-forget so the inbound capture path is never blocked.
 *
 * @param cmdConfigured transcribeCmd(env) != null — false => skip gracefully.
 */
export async function transcribeVoiceIdea(
  cmdConfigured: boolean,
  fx: TranscribeEffects,
): Promise<TranscribeOutcome> {
  if (!cmdConfigured) {
    fx.logNotice(
      'SEMEN_TRANSCRIBE_CMD unset — voice idea kept status:new (transcription deferred to triage)',
    )
    return 'skipped'
  }

  let audioPath: string | undefined
  let downloadErr: unknown
  try {
    audioPath = await fx.download()
  } catch (err) {
    downloadErr = err
  }
  if (!audioPath) {
    fx.logError(
      `voice download failed — idea stays new, file_id retained${downloadErr ? `: ${downloadErr}` : ''}`,
    )
    await safeCall(() => fx.replyFailure())
    return 'failed'
  }

  let transcript: string
  try {
    transcript = (await fx.transcribe(audioPath)).trim()
  } catch (err) {
    fx.logError(`transcription failed — idea stays new, file_id retained: ${err}`)
    await safeCall(() => fx.replyFailure())
    return 'failed'
  }
  if (!transcript) {
    fx.logError('transcription produced empty output — idea stays new, file_id retained')
    await safeCall(() => fx.replyFailure())
    return 'failed'
  }

  let saved = true
  try {
    saved = fx.onSuccess(transcript, audioPath) !== false
  } catch (err) {
    saved = false
    fx.logError(`persisting transcript failed — idea stays new: ${err}`)
  }
  // Whether or not the store flip stuck, we HAVE a transcript — surface it.
  await safeCall(() => fx.replyTranscript(transcript))
  return saved ? 'ready' : 'failed'
}

// ── voice-reply (TTS bubble) orchestrator (effect-injected, runtime-agnostic) ──
//
// Same seam pattern as transcribeVoiceIdea: server.ts binds the effects to the
// TTS shell-out + bot.api.sendVoice + fs.unlink; the unit test passes spies (NO
// real TTS, NO real bot). The PRODUCTION path runs through this function, so the
// failure-safety invariant is tested against the real code.
//
// The CONTRACT that must never break: the TEXT reply is sent FIRST by server.ts
// (existing behaviour, unchanged). This adds a voice bubble of the SAME text as
// a BEST-EFFORT extra. Any failure here (cmd unset, TTS throws, sendVoice throws)
// is logged loud and SWALLOWED — never rethrown — so the already-delivered text
// reply and the channel itself are never broken.
//
// Invariants:
//  - cmd not configured        -> SKIP, log a notice, return 'skipped'.
//  - synthesize throws         -> 'failed', sendVoice NOT called, loud log, cleanup.
//  - sendVoice throws          -> 'failed', loud log, cleanup; never rethrows.
//  - all good                  -> 'sent', cleanup.
// cleanup (unlink temp .ogg) ALWAYS runs (finally) and is itself best-effort.

export type VoiceReplyOutcome = 'skipped' | 'sent' | 'failed'

/** Effects sendVoiceReply drives. server.ts binds TTS/bot/fs; tests spy. */
export type VoiceReplyEffects = {
  /** Run the TTS command, writing an Opus .ogg to outPath. Rejects on failure. */
  synthesize: (outPath: string) => Promise<void>
  /** Upload the .ogg as a Telegram voice bubble (bot.api.sendVoice). Rejects on failure. */
  sendVoice: (oggPath: string) => Promise<void>
  /** Remove the temp .ogg (best-effort; swallow its own errors). */
  cleanup: (oggPath: string) => void
  /** Loud stderr on the skip/failure path. */
  logError: (reason: string) => void
}

/**
 * Synthesize + send a voice bubble for an already-sent text reply, FAILURE-SAFE.
 * Never rejects — the caller awaits it only to surface the outcome in the tool
 * result; a failure must not turn the (already-successful) reply into an error.
 *
 * @param cmdConfigured ttsCmd(env) != null — false => skip gracefully.
 * @param oggPath       a unique temp path for the synthesized .ogg.
 */
export async function sendVoiceReply(
  cmdConfigured: boolean,
  oggPath: string,
  fx: VoiceReplyEffects,
): Promise<VoiceReplyOutcome> {
  if (!cmdConfigured) {
    fx.logError('SEMEN_TTS_CMD unset (and no IDEA_INBOX_DIR fallback) — voice bubble skipped, text already sent')
    return 'skipped'
  }
  try {
    await fx.synthesize(oggPath)
    await fx.sendVoice(oggPath)
    return 'sent'
  } catch (err) {
    fx.logError(`voice bubble failed — text already sent, dropping bubble: ${err}`)
    return 'failed'
  } finally {
    try {
      fx.cleanup(oggPath)
    } catch {
      // best-effort temp cleanup — never let it surface.
    }
  }
}

/**
 * Build the grammY sendVoice options (forum thread + optional quote-reply). Pure
 * so the payload shape is unit-testable without a bot. Mirrors the reply/file
 * opts: carry message_thread_id so the bubble lands in the right topic, and
 * reply_parameters when threading under an earlier message.
 */
export function voiceSendOpts(
  message_thread_id: number | undefined,
  reply_to: number | null | undefined,
): Record<string, unknown> {
  return {
    ...(message_thread_id != null ? { message_thread_id } : {}),
    ...(reply_to != null ? { reply_parameters: { message_id: reply_to } } : {}),
  }
}
