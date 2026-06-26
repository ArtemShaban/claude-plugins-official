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
import { join } from 'path'

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

/** True if `id` already exists in the JSONL file (idempotency check). */
export function ideaExists(jsonlPath: string, id: string): boolean {
  let raw: string
  try {
    raw = readFileSync(jsonlPath, 'utf8')
  } catch {
    return false // no file yet => nothing recorded
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      if ((JSON.parse(line) as IdeaRecord).id === id) return true
    } catch {
      // tolerate a partially-written trailing line
    }
  }
  return false
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
  if (ideaExists(jsonlPath, id)) {
    const raw = readFileSync(jsonlPath, 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as IdeaRecord
        if (r.id === id) return r
      } catch {}
    }
  }

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

/** Atomically rewrite a single record's status (used by Фаза-2 triage). */
export function setIdeaStatus(jsonlPath: string, id: string, status: string): boolean {
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
          r.status = status
          r.ts_status = new Date().toISOString()
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
