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
 */
import { closeSync, openSync, renameSync, unlinkSync, writeSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import type { Transformer } from 'grammy'
import { withTimeout } from './voice-delivery'

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

export function createPollLiveness(opts: PollLivenessOptions): { transformer: Transformer } {
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

  return { transformer }
}
