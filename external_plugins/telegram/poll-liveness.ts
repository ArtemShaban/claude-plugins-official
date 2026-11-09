/**
 * poll-liveness — a time limit on getUpdates + the poll.json heartbeat.
 *
 * Why: 16.10.2026 the plugin process stayed alive while one getUpdates never
 * returned (grammY's own bound is 500 s per request, and a dead TCP path can
 * outlast it); inbound messages sat on Telegram's side, every monitor said
 * healthy. Spec: sam-data dev/analysis/2026-10-16-tg-plugin-deaf-fix-spec.md
 * (§2.A, §5).
 *
 * 1. Deadline: only `getUpdates` is bounded, to (its `timeout` ?? 0) s +
 *    POLL_SLACK_S. On expiry the request is aborted and rejected; grammY's poll
 *    loop retries after its 3 s pause, the offset does not move, nothing is
 *    lost. sendMessage / uploads / every other method pass through untouched.
 * 2. Heartbeat: `poll.json` in the plugin's STATE_DIR (next to bot.pid), mode
 *    0600, written at startup and after every getUpdates outcome, through an
 *    exclusive temp file in the same dir + rename (never follows a symlink).
 *
 * READER: core `tools/channel-watchdog.sh` (detect_bridge). The format is the
 * contract of spec §5 — change it there first, or the watchdog silently falls
 * back to «no verdict»:
 *   {"pid": int, "started_at": epoch s, "last_ok_at": epoch s | null,
 *    "consecutive_errors": int, "last_error": "timeout"|"network"|"http_NNN"|null}
 * Epoch SECONDS, never ms. Never free text: the bot token lives in request
 * URLs and error strings, so errors are reduced to a closed set of classes.
 * Since 0.0.25 `consecutive_errors` / `last_error` also count a failed startup
 * attempt (pre-connect getMe or bot.start setup, before onStart); `last_ok_at`
 * stays getUpdates-only.
 *
 * 3. Startup loop (`runStartupLoop`, D-914; spec sam-data
 *    dev/analysis/2026-11-01-tg-plugin-startup-retry-spec.md). After a boot with
 *    no internet grammY's own startup ladder slept 100 s → 200 s → … (1.41.1,
 *    grammY issue #961). Now: our own getMe (never grammY's withRetries), each
 *    attempt bounded to STARTUP_DEADLINE_MS, then bot.start(); between failed
 *    attempts the pause is 1, 2, 4, 8, 16, 32, then 60 s every time; a
 *    successful start resets it to 1 s.
 *    A 409 follows the same cadence (no give-up): polling resumes by itself
 *    once the other poller dies. A pass is «connected» at its first successful
 *    getUpdates, not at onStart.
 * 4. `startup.log` in STATE_DIR, mode 0600, append-only, metadata only (no
 *    token, URL, error text or message content). One `ok` line per connect; a
 *    failure line only when outcome or next_in_s changes within a run (≤ 8 lines
 *    per outage or lasting 409):
 *      <ISO ts> pid=<n> attempt=<k> outcome=ok|timeout|network|http_NNN ms=<attempt ms> next_in_s=<pause|0>
 *    Readers: humans and the D-914 T+7 check. No rotation (bounded per run).
 */
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { GrammyError, type Bot, type PollingOptions, type Transformer } from 'grammy'
import type { UserFromGetMe } from 'grammy/types'
import { withTimeout } from './voice-delivery'
import { createStateLineWriter } from './state-line'

export const POLL_SLACK_S = 15
export const POLL_FILE = 'poll.json'

export type PollErrorClass = 'timeout' | 'network' | `http_${number}`

export interface PollHeartbeat {
  pid: number
  started_at: number
  last_ok_at: number | null
  consecutive_errors: number
  last_error: PollErrorClass | null
}

export interface PollLivenessOptions {
  stateDir: string
  /** Seconds added to the request's own poll timeout. Default POLL_SLACK_S. */
  slackS?: number
  pid?: number
  nowMs?: () => number
  /** One line per write-failure streak. Default: stderr. */
  log?: (line: string) => void
}

/** `http_<code>` only for a 3-digit code; anything else counts as `network`. */
export function httpErrorClass(code: unknown): PollErrorClass {
  return typeof code === 'number' && Number.isInteger(code) && code >= 100 && code <= 999
    ? `http_${code}`
    : 'network'
}

/** Deadline in ms for one getUpdates payload — never NaN (bot.stop() sends no timeout). */
export function pollDeadlineMs(payload: unknown, slackS: number): number {
  const t = (payload as { timeout?: unknown } | undefined)?.timeout
  const pollS = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : 0
  return (pollS + slackS) * 1000
}

export function createPollLiveness(opts: PollLivenessOptions): {
  transformer: Transformer
  /** A startup attempt failed before onStart → consecutive_errors += 1, last_error = cls. */
  recordStartupFailure: (cls: PollErrorClass) => void
} {
  const slackS = opts.slackS ?? POLL_SLACK_S
  const pid = opts.pid ?? process.pid
  const nowS = () => Math.floor((opts.nowMs ?? Date.now)() / 1000)
  const log = opts.log ?? ((line: string) => { try { process.stderr.write(line) } catch {} })
  const file = join(opts.stateDir, POLL_FILE)
  const hb: PollHeartbeat = {
    pid,
    started_at: nowS(),
    last_ok_at: null,
    consecutive_errors: 0,
    last_error: null,
  }
  let writeFailing = false

  function write(): void {
    const tmp = join(opts.stateDir, `.${POLL_FILE}.${pid}.${randomBytes(6).toString('hex')}.tmp`)
    let created = false
    try {
      // 'wx' = O_CREAT|O_EXCL: fails on any existing path, symlinks included.
      const fd = openSync(tmp, 'wx', 0o600)
      created = true
      try {
        writeSync(fd, JSON.stringify(hb))
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      writeFailing = false
    } catch (err) {
      if (created) {
        try { unlinkSync(tmp) } catch {}
      }
      if (!writeFailing) {
        writeFailing = true
        const code = (err as { code?: unknown } | null)?.code
        const safe = typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'unknown'
        log(`telegram channel: poll.json write failed (${safe}), polling continues\n`)
      }
    }
  }

  function ok(): void {
    hb.last_ok_at = nowS()
    hb.consecutive_errors = 0
    hb.last_error = null
    write()
  }

  function fail(cls: PollErrorClass): void {
    hb.consecutive_errors += 1
    hb.last_error = cls
    write()
  }

  write()

  const transformer: Transformer = async (prev, method, payload, signal) => {
    if (method !== 'getUpdates') return prev(method, payload, signal)
    const ctl = new AbortController()
    const onOuterAbort = () => ctl.abort()
    if (signal?.aborted) ctl.abort()
    else signal?.addEventListener('abort', onOuterAbort, { once: true })
    let timedOut = false
    try {
      const res = await withTimeout(prev(method, payload, ctl.signal), pollDeadlineMs(payload, slackS), () => {
        timedOut = true
        ctl.abort()
      })
      if (res.ok) ok()
      else fail(httpErrorClass(res.error_code))
      return res
    } catch (err) {
      // bot.stop() aborting the pending poll is a shutdown, not a fetch failure.
      if (timedOut || !signal?.aborted) fail(timedOut ? 'timeout' : 'network')
      throw err
    } finally {
      signal?.removeEventListener('abort', onOuterAbort)
    }
  }

  return { transformer, recordStartupFailure: fail }
}

// ── startup loop (D-914) ────────────────────────────────────────────────────

export const STARTUP_LOG = 'startup.log'
/** Bound on one pre-connect getMe — a dead TCP path outlasts grammY's 500 s request bound. */
export const STARTUP_DEADLINE_MS = 15_000
export const STARTUP_PAUSE_CAP_S = 60

/** Pause after the n-th consecutive failed attempt (n ≥ 1): 1, 2, 4, 8, 16, 32, then 60 s (owner tg 40604/40605). */
export function startupRetryDelayS(failures: number): number {
  const n = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1
  return Math.min(STARTUP_PAUSE_CAP_S, 2 ** (n - 1))
}

export type StartupOutcome = 'ok' | PollErrorClass

export interface StartupLine {
  attempt: number
  outcome: StartupOutcome
  ms: number
  nextInS: number
}

const OUTCOME_RE = /^(ok|timeout|network|http_[0-9]{3})$/
const int = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : 0)

/** The line shape of the header, item 4. Only integers and the closed outcome set reach the file. */
export function formatStartupLine(tsMs: number, pid: number, l: StartupLine): string {
  const outcome = OUTCOME_RE.test(l.outcome) ? l.outcome : 'network'
  return `${new Date(tsMs).toISOString()} pid=${int(pid)} attempt=${int(l.attempt)} outcome=${outcome} ms=${int(l.ms)} next_in_s=${int(l.nextInS)}\n`
}

/** Appender for STATE_DIR/startup.log. Never throws: a write failure = one stderr line per streak, startup goes on. */
export function createStartupLog(opts: {
  stateDir: string
  pid?: number
  nowMs?: () => number
  log?: (line: string) => void
}): (l: StartupLine) => void {
  const pid = opts.pid ?? process.pid
  const now = opts.nowMs ?? Date.now
  const write = createStateLineWriter({ file: join(opts.stateDir, STARTUP_LOG), goesOn: 'startup continues', log: opts.log })
  return l => write(formatStartupLine(now(), pid, l))
}

class StartupDeadline extends Error {
  constructor(ms: number) {
    super(`startup getMe gave no answer within ${ms / 1000}s`)
  }
}

/** Closed-set class of a startup failure — never the error text (the token lives in URLs and messages). */
export function startupErrorClass(err: unknown): PollErrorClass {
  if (err instanceof StartupDeadline) return 'timeout'
  const code = (err as { error_code?: unknown } | null)?.error_code
  return code === undefined ? 'network' : httpErrorClass(code)
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface StartupLoopOptions {
  bot: Bot<any>
  /** Passed to bot.start() as-is (allowed_updates …); onStart is wrapped. */
  startOptions?: Omit<PollingOptions, 'onStart'>
  onStart: (info: UserFromGetMe) => void
  isShuttingDown: () => boolean
  recordStartupFailure: (cls: PollErrorClass) => void
  startupLog: (l: StartupLine) => void
  log: (line: string) => void
  /** Injected clock for tests; default Date.now / setTimeout. */
  nowMs?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  deadlineMs?: number
}

/**
 * The plugin's outer polling loop. Returns on a clean bot.stop(), on shutdown,
 * or on grammY's «Aborted delay». Every other failure — 409 included, one
 * cadence for all paths (spec §2) — pauses by startupRetryDelayS and tries
 * again, forever: a lasting 409 (another poller holds the token) settles at one
 * try per 60 s and polling resumes by itself when the other poller dies.
 *
 * A pass counts as connected only when one of its getUpdates calls succeeds —
 * not at onStart: grammY throws a 409 from getUpdates only after onStart, so a
 * reset there kept a lasting 409 at a 1 s pause forever (D-914 review F2).
 *
 * startup.log gets the `ok` line of a pass at its first successful getUpdates,
 * and a failure line only when it differs from the last line written in this
 * run (outcome or next_in_s) or opens the run — so an outage writes ≤ 8 lines
 * (1, 2, 4 … 60, then silence) and a lasting 409 the same, not a line per pass.
 */
export async function runStartupLoop(o: StartupLoopOptions): Promise<void> {
  const now = o.nowMs ?? Date.now
  const sleep = o.sleep ?? defaultSleep
  const deadlineMs = o.deadlineMs ?? STARTUP_DEADLINE_MS
  let failures = 0 // consecutive failed passes since the last successful getUpdates
  let last: { outcome: StartupOutcome; nextInS: number } | null = null // last line of this run
  // Per-pass state, read by the getUpdates observer below.
  let attempt = 1
  let t0 = now()
  let polledOk = false
  o.bot.api.config.use(async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal)
    if (method === 'getUpdates' && res.ok && !polledOk) {
      polledOk = true
      failures = 0
      o.startupLog({ attempt, outcome: 'ok', ms: now() - t0, nextInS: 0 })
      last = null // a new run starts
    }
    return res
  })
  for (;;) {
    attempt = failures + 1
    t0 = now()
    polledOk = false
    let started = false
    try {
      if (!o.bot.isInited()) {
        // Our own getMe: bot.start() then skips grammY's init() and its withRetries ladder.
        o.bot.botInfo = await getMeWithin(o.bot, deadlineMs, sleep)
      }
      await o.bot.start({
        ...o.startOptions,
        onStart: info => {
          started = true
          o.onStart(info)
        },
      })
      return // bot.stop() was called — clean exit from the loop
    } catch (err) {
      if (o.isShuttingDown()) return
      // bot.stop() mid-setup rejects with grammY's "Aborted delay" — expected, not an error.
      if (err instanceof Error && err.message === 'Aborted delay') return
      failures += 1
      const is409 = err instanceof GrammyError && err.error_code === 409
      const delayS = startupRetryDelayS(failures)
      const cls = startupErrorClass(err)
      // Before onStart nothing polled yet → poll.json hears it here; after onStart the
      // failing getUpdates already counted it in the poll-liveness transformer.
      if (!started) o.recordStartupFailure(cls)
      if (last === null || last.outcome !== cls || last.nextInS !== delayS) {
        o.startupLog({ attempt, outcome: cls, ms: now() - t0, nextInS: delayS })
        last = { outcome: cls, nextInS: delayS }
      }
      const detail = is409
        ? `409 Conflict${failures === 1 ? ' — another instance is polling (zombie session, or a second Claude Code running?)' : ''}`
        : `polling error: ${err}`
      o.log(`telegram channel: ${detail}, retrying in ${delayS}s\n`)
      await sleep(delayS * 1000)
    }
  }
}

/** One getMe, no retries, rejected with StartupDeadline after `ms` (the request is aborted). */
async function getMeWithin(
  bot: Bot<any>,
  ms: number,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<UserFromGetMe> {
  const ctl = new AbortController()
  const deadline = sleep(ms, ctl.signal).then(() => {
    throw new StartupDeadline(ms)
  })
  deadline.catch(() => {}) // aborted after getMe won — nothing to report
  try {
    return await Promise.race([bot.api.getMe(ctl.signal), deadline])
  } finally {
    ctl.abort()
  }
}
