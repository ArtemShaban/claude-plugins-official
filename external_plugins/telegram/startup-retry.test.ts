// Startup with no network — D-914, spec sam-data dev/analysis/2026-11-01-tg-plugin-startup-retry-spec.md
// AC-1 cadence · AC-2 reset · AC-3 deadline · AC-4 no grammY ladder · AC-5 poll.json · AC-6 startup.log.
// Fake Bot API on localhost only (a reserved port with nothing listening = «no network»),
// fake token, temp STATE_DIR per test — never the live plugin state.
//
// Injected clock: virtual time runs SCALE× faster than real time, so a 60 s pause
// takes 600 ms and the whole 150 s outage ≈ 2 s. Every recorded number (pauses,
// startup.log ms / next_in_s) is in virtual ms / s.
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Bot } from 'grammy'
import {
  createPollLiveness,
  createStartupLog,
  runStartupLoop,
  startupRetryDelayS,
  POLL_FILE,
  STARTUP_LOG,
} from './poll-liveness'

// Token-SHAPED fake (9 digits : 35 chars). Not a real bot token.
const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SCALE = 100
const LINE_RE =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z pid=\d+ attempt=\d+ outcome=(ok|timeout|network|http_\d{3}) ms=\d+ next_in_s=\d+$/

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try { c() } catch {}
  }
})
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'startup-retry-'))
  cleanups.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

function scaledClock() {
  const real0 = Date.now()
  const v0 = Date.parse('2026-11-01T00:00:00.000Z')
  const pauses: number[] = []
  const nowMs = () => v0 + (Date.now() - real0) * SCALE
  // Pauses come without a signal; the per-attempt deadline passes one.
  const sleep = (ms: number, signal?: AbortSignal) => {
    if (!signal) pauses.push(ms)
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const t = setTimeout(resolve, ms / SCALE)
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
    })
  }
  return { nowMs, sleep, pauses, virtualSince: (t: number) => nowMs() - t }
}

/** A port with nothing listening yet (connection refused until `up()`). */
function reservePort(): number {
  const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
  const port = s.port
  s.stop(true)
  return port
}

type FakeOpts = {
  port: number
  /** getMe call numbers (1-based, counted at the server) that never answer. */
  hangGetMe?: number[]
  /** getUpdates call numbers that answer 409. */
  conflictGetUpdates?: number[]
  /** Every getUpdates answers 409 while this returns true (another poller holds the token). */
  conflictWhile?: () => boolean
}
function fakeBotApi(o: FakeOpts) {
  const counts = { getMe: 0, getUpdates: 0, deleteWebhook: 0 }
  const order: string[] = []
  const parked: Array<() => void> = []
  const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
  const server = Bun.serve({
    port: o.port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()!
      order.push(method)
      if (method === 'getMe') {
        counts.getMe++
        if (o.hangGetMe?.includes(counts.getMe)) {
          return new Promise<Response>(resolve => {
            const release = () => resolve(new Response('{"ok":false,"error_code":499,"description":"x"}'))
            parked.push(release)
            req.signal.addEventListener('abort', release, { once: true })
          })
        }
        return json({ id: 123456789, is_bot: true, first_name: 'fake', username: 'fake_bot',
          can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false })
      }
      if (method === 'deleteWebhook') {
        counts.deleteWebhook++
        return json(true)
      }
      if (method === 'getUpdates') {
        counts.getUpdates++
        if (o.conflictGetUpdates?.includes(counts.getUpdates) || o.conflictWhile?.()) {
          return new Response('{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request"}')
        }
        await Bun.sleep(30)
        return json([])
      }
      return new Response('{"ok":false,"error_code":404,"description":"nope"}')
    },
  })
  return {
    counts,
    order,
    stop() {
      for (const r of parked.splice(0)) r()
      server.stop(true)
    },
  }
}

function harness(port: number) {
  const dir = tempDir()
  const clock = scaledClock()
  const bot = new Bot(FAKE_TOKEN, { client: { apiRoot: `http://127.0.0.1:${port}` } })
  const pl = createPollLiveness({ stateDir: dir, nowMs: clock.nowMs, log: () => {} })
  bot.api.config.use(pl.transformer)
  const starts: number[] = []
  const stderr: string[] = []
  let shuttingDown = false
  const done = runStartupLoop({
    bot,
    onStart: () => { starts.push(clock.nowMs()) },
    isShuttingDown: () => shuttingDown,
    recordStartupFailure: pl.recordStartupFailure,
    startupLog: createStartupLog({ stateDir: dir, nowMs: clock.nowMs, log: () => {} }),
    log: l => { stderr.push(l) },
    nowMs: clock.nowMs,
    sleep: clock.sleep,
  })
  cleanups.push(() => {
    shuttingDown = true
    void bot.stop().catch(() => {})
  })
  return {
    dir,
    clock,
    bot,
    starts,
    stderr,
    done,
    async stop() {
      shuttingDown = true
      await bot.stop().catch(() => {})
      await done
    },
    hb: () => JSON.parse(readFileSync(join(dir, POLL_FILE), 'utf8')),
    lines: () =>
      existsSync(join(dir, STARTUP_LOG))
        ? readFileSync(join(dir, STARTUP_LOG), 'utf8').split('\n').filter(Boolean)
        : [],
  }
}

async function waitFor(cond: () => boolean, realMs: number): Promise<void> {
  const end = Date.now() + realMs
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor: timed out')
    await Bun.sleep(5)
  }
}

describe('startupRetryDelayS', () => {
  test('1, 2, 4, 8, 16, 32, then 60 forever; bad input → 1', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 50, 5000].map(startupRetryDelayS)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60])
    expect([0, -3, NaN].map(startupRetryDelayS)).toEqual([1, 1, 1])
  })
})

describe('start with no network (D-914)', () => {
  test('AC-1/2/4/5/6: cadence while down, connect on the first attempt after, reset to 1 s, poll.json + startup.log', async () => {
    const port = reservePort()
    const h = harness(port)
    // «No network» for the first 150 virtual s: nothing listens on the port.
    let api: ReturnType<typeof fakeBotApi> | undefined
    let hbDuringOutage: any
    const upAt = 150_000
    const upTimer = setTimeout(() => {
      hbDuringOutage = h.hb()
      api = fakeBotApi({ port, conflictGetUpdates: [2] })
    }, upAt / SCALE)
    cleanups.push(() => { clearTimeout(upTimer); api?.stop() })

    // Connected, then getUpdates #2 = 409 → bot.start() throws once → reconnect.
    // Wait until the reconnect has polled successfully (getUpdates #3 answered → ok()).
    await waitFor(() => h.starts.length >= 2 && (api?.counts.getUpdates ?? 0) >= 4, 15_000)
    const lastOkAfterFirstPoll = h.hb()
    await h.stop()

    // AC-1: pauses during the outage are exactly the cadence; none above 60 s.
    const outagePauses = h.clock.pauses.slice(0, 8)
    expect(outagePauses).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map(s => s * 1000))
    expect(Math.max(...h.clock.pauses)).toBeLessThanOrEqual(60_000)
    // AC-2: after the connect, the one bot.start() throw → next pause 1 s.
    expect(h.clock.pauses[8]).toBe(1000)
    expect(h.clock.pauses.length).toBe(9)

    // AC-1/AC-4: the first attempt after the API came back succeeded; getMe was asked
    // exactly once (ours) — no grammY init(), no withRetries ladder; getUpdates followed.
    expect(api!.counts.getMe).toBe(1)
    expect(api!.order.indexOf('getMe')).toBe(0)
    expect(api!.order.indexOf('getUpdates')).toBeGreaterThan(api!.order.indexOf('getMe'))
    const firstStartAfterUp = h.starts[0] - Date.parse('2026-11-01T00:00:00.000Z')
    expect(firstStartAfterUp - upAt).toBeLessThanOrEqual(60_000 + 1_500)

    // AC-5: during the outage poll.json said why; after the first getUpdates it is healthy.
    expect(hbDuringOutage.last_ok_at).toBeNull()
    expect(hbDuringOutage.consecutive_errors).toBeGreaterThanOrEqual(1)
    expect(hbDuringOutage.last_error).toBe('network')
    expect(Object.keys(hbDuringOutage).sort()).toEqual(
      ['consecutive_errors', 'last_error', 'last_ok_at', 'pid', 'started_at'])
    expect(typeof lastOkAfterFirstPoll.last_ok_at).toBe('number')
    expect(lastOkAfterFirstPoll.consecutive_errors).toBe(0)

    // AC-6: exact shape, 0600, no secret-ish text. A failure line only when outcome or
    // next_in_s changes within a run (r1, security N1): the 8th attempt (network, 60 s
    // again) writes nothing. Then ok (attempt 9), the 409 drop after it (a new run, 1 s),
    // and the reconnect's ok.
    const lines = h.lines()
    expect(lines.length).toBe(10)
    for (const l of lines) expect(l).toMatch(LINE_RE)
    const outcomes = lines.map(l => /outcome=(\S+)/.exec(l)![1])
    expect(outcomes.slice(0, 7)).toEqual(Array(7).fill('network'))
    expect(outcomes.slice(7)).toEqual(['ok', 'http_409', 'ok'])
    expect(lines.slice(0, 7).map(l => Number(/next_in_s=(\d+)/.exec(l)![1]))).toEqual([1, 2, 4, 8, 16, 32, 60])
    expect(lines.map(l => Number(/attempt=(\d+)/.exec(l)![1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 9, 2])
    expect(lines[8]).toContain('next_in_s=1')
    expect(statSync(join(h.dir, STARTUP_LOG)).mode & 0o777).toBe(0o600)
    const raw = readFileSync(join(h.dir, STARTUP_LOG), 'utf8')
    expect(raw).not.toContain(FAKE_TOKEN)
    expect(raw).not.toContain('AAAAAAAA')
    expect(raw).not.toContain('api.telegram.org')
    expect(raw).not.toContain('127.0.0.1')
    expect(raw).not.toMatch(/bot\d+:/)
  }, 30_000)

  test('AC-3/4: a getMe that never answers ends at the 15 s deadline as outcome=timeout; the cadence goes on', async () => {
    const port = reservePort()
    const api = fakeBotApi({ port, hangGetMe: [1] })
    cleanups.push(() => api.stop())
    const h = harness(port)
    await waitFor(() => h.starts.length >= 1, 15_000)
    await h.stop()

    const lines = h.lines()
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l).toMatch(LINE_RE)
    expect(lines[0]).toContain('attempt=1 outcome=timeout')
    expect(lines[0]).toContain('next_in_s=1')
    const ms = Number(/ms=(\d+)/.exec(lines[0])![1])
    expect(ms).toBeGreaterThanOrEqual(15_000)
    expect(ms).toBeLessThanOrEqual(15_000 + 2_000) // ± scheduler tick at SCALE
    expect(lines[1]).toContain('attempt=2 outcome=ok')
    expect(h.clock.pauses).toEqual([1000])
    // Exactly our two getMe calls reached the API — grammY never retried on its own.
    expect(api.counts.getMe).toBe(2)
    const hb = h.hb()
    expect(hb.last_error === null || hb.last_error === 'timeout').toBe(true)
  }, 30_000)

  test('r1/F2: a lasting 409 after connect follows 1, 2, 4 … 60 s (no 1 s loop, no give-up), bounded log; once it clears polling resumes and the counter resets', async () => {
    const port = reservePort()
    const h0 = Date.now()
    let conflict = true // another poller holds the token
    let oneMore = false // one extra 409 after recovery, to prove the reset
    const api = fakeBotApi({
      port,
      conflictWhile: () => {
        if (oneMore) { oneMore = false; return true }
        return conflict
      },
    })
    cleanups.push(() => api.stop())
    const h = harness(port)
    // The other poller dies at virtual 280 s → the pass at 303 s connects.
    const clearTimer = setTimeout(() => { conflict = false }, 280_000 / SCALE)
    cleanups.push(() => clearTimeout(clearTimer))
    await waitFor(() => h.lines().some(l => l.includes('outcome=ok')), 15_000)
    const okGetUpdates = api.counts.getUpdates
    // Polling really resumed: more getUpdates go by after the ok.
    await waitFor(() => api.counts.getUpdates >= okGetUpdates + 2, 5_000)
    const pausesBeforeReset = h.clock.pauses.length
    oneMore = true
    await waitFor(() => h.clock.pauses.length > pausesBeforeReset && h.lines().filter(l => l.includes('outcome=ok')).length >= 2, 15_000)
    await h.stop()
    expect(Date.now() - h0).toBeLessThan(20_000)

    // Cadence while the 409 lasted: the owner's doubling, then 60 s — not 1 s forever.
    expect(h.clock.pauses.slice(0, 10)).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60].map(s => s * 1000))
    // After the 409 cleared and a getUpdates succeeded, the next 409 starts again at 1 s.
    expect(h.clock.pauses[pausesBeforeReset]).toBe(1000)
    expect(Math.max(...h.clock.pauses)).toBeLessThanOrEqual(60_000)

    // Bounded log: 7 distinct 409 lines (1 … 60 s), silence for the repeats, then ok,
    // then the one extra 409 (a new run) and its reconnect's ok.
    const lines = h.lines()
    for (const l of lines) expect(l).toMatch(LINE_RE)
    const outcomes = lines.map(l => /outcome=(\S+)/.exec(l)![1])
    expect(outcomes).toEqual([...Array(7).fill('http_409'), 'ok', 'http_409', 'ok'])
    expect(lines.slice(0, 7).map(l => Number(/next_in_s=(\d+)/.exec(l)![1]))).toEqual([1, 2, 4, 8, 16, 32, 60])
    expect(lines[7]).toContain('attempt=11 outcome=ok')
    // poll.json: the 409s were counted by the getUpdates transformer; healthy at the end.
    const hb = h.hb()
    expect(typeof hb.last_ok_at).toBe('number')
  }, 30_000)

  test('a 4xx from getMe is recorded as http_NNN in poll.json and startup.log', async () => {
    const port = reservePort()
    // Answers 401 for getMe: Bun.serve fake with a custom handler.
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: () => new Response('{"ok":false,"error_code":401,"description":"Unauthorized"}'),
    })
    cleanups.push(() => server.stop(true))
    const h = harness(port)
    await waitFor(() => h.lines().length >= 2, 15_000)
    const hb = h.hb()
    await h.stop()
    expect(h.lines()[0]).toContain('outcome=http_401')
    expect(hb.last_error).toBe('http_401')
    expect(hb.consecutive_errors).toBeGreaterThanOrEqual(2)
    expect(hb.last_ok_at).toBeNull()
  }, 30_000)
})
