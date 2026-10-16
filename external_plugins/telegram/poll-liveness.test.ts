// poll-liveness.ts — spec sam-data dev/analysis/2026-10-16-tg-plugin-deaf-fix-spec.md
// AC-1 (hung first getUpdates heals), AC-2 (uploads not cut), AC-3 (poll.json
// contract), AC-4 (no token in poll.json / stderr). Fake Bot API only — no
// network, no real token, temp STATE_DIR per test.
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Bot, InputFile } from 'grammy'
import { createPollLiveness, POLL_FILE } from './poll-liveness'

// Token-SHAPED fake (9 digits : 35 chars). Not a real bot token.
const FAKE_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'poll-liveness-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function readHb(dir: string): any {
  return JSON.parse(readFileSync(join(dir, POLL_FILE), 'utf8'))
}
const nowS = () => Math.floor(Date.now() / 1000)

// ── fake Bot API ───────────────────────────────────────────────────────────
type FakeOpts = { hangFirstGetUpdates?: boolean; slowMs?: number }
function fakeBotApi(opts: FakeOpts) {
  let getUpdatesCalls = 0
  let delivered = false
  const parked: Array<() => void> = []
  const park = (req: Request) =>
    new Promise<Response>(resolve => {
      const release = () => resolve(new Response('{"ok":true,"result":[]}'))
      parked.push(release)
      req.signal.addEventListener('abort', release, { once: true })
    })
  const json = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop()
      if (method === 'getMe') {
        return json({ id: 123456789, is_bot: true, first_name: 'fake', username: 'fake_bot',
          can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false })
      }
      if (method === 'deleteWebhook') return json(true)
      if (method === 'getUpdates') {
        getUpdatesCalls++
        if (getUpdatesCalls === 1 && opts.hangFirstGetUpdates) return park(req) // hangs "forever"
        if (!delivered) {
          delivered = true
          return json([{ update_id: 1, message: { message_id: 7, date: nowS(), text: 'hello',
            chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'u' } } }])
        }
        await Bun.sleep(200)
        return json([])
      }
      if (method === 'sendMessage' || method === 'sendDocument') {
        await Bun.sleep(opts.slowMs ?? 0)
        return json({ message_id: 9, date: nowS(), chat: { id: 42, type: 'private' }, text: 'x' })
      }
      return new Response('{"ok":false,"error_code":404,"description":"nope"}')
    },
  })
  return {
    apiRoot: `http://127.0.0.1:${server.port}`,
    getUpdatesCalls: () => getUpdatesCalls,
    stop() {
      for (const r of parked.splice(0)) r()
      server.stop(true)
    },
  }
}

// Runs a bot against the fake API; returns ms from start until the text update
// reaches the handler, or null if it did not arrive within windowMs.
async function timeToFirstUpdate(installTransformer: boolean, windowMs: number): Promise<number | null> {
  const api = fakeBotApi({ hangFirstGetUpdates: true })
  const bot = new Bot(FAKE_TOKEN, { client: { apiRoot: api.apiRoot } })
  if (installTransformer) {
    bot.api.config.use(createPollLiveness({ stateDir: tempDir(), slackS: 1, log: () => {} }).transformer)
  }
  const t0 = Date.now()
  let arrivedAt: number | null = null
  bot.on('message:text', () => { arrivedAt = Date.now() })
  void bot.start({ timeout: 1 }).catch(() => {})
  while (arrivedAt === null && Date.now() - t0 < windowMs) await Bun.sleep(50)
  await bot.stop().catch(() => {})
  api.stop()
  return arrivedAt === null ? null : arrivedAt - t0
}

// injected poll timeout 1 s + slack 1 s + grammY's 3 s retry pause + 2 s margin
const AC1_WINDOW_MS = (1 + 1 + 3 + 2) * 1000

describe('AC-1 a hung first getUpdates no longer leaves the bot deaf', () => {
  test('with the deadline: the next update reaches the handler within timeout + slack + 3 s + 2 s', async () => {
    const ms = await timeToFirstUpdate(true, AC1_WINDOW_MS)
    expect(ms).not.toBeNull()
    expect(ms!).toBeLessThan(AC1_WINDOW_MS)
  }, 20_000)

  test('control (= fork main 49c0682, transformer not installed): the update does NOT arrive in that window', async () => {
    expect(await timeToFirstUpdate(false, AC1_WINDOW_MS)).toBeNull()
  }, 20_000)
})

describe('AC-2 sendMessage and sendDocument are not cut by the deadline', () => {
  test('a reply slower than the getUpdates deadline still completes', async () => {
    const api = fakeBotApi({ slowMs: 2500 })
    const bot = new Bot(FAKE_TOKEN, { client: { apiRoot: api.apiRoot } })
    bot.api.config.use(createPollLiveness({ stateDir: tempDir(), slackS: 1, log: () => {} }).transformer)
    try {
      const m = await bot.api.sendMessage(42, 'hi')
      expect(m.message_id).toBe(9)
      const d = await bot.api.sendDocument(42, new InputFile(Buffer.alloc(64 * 1024, 1), 'f.bin'))
      expect(d.message_id).toBe(9)
    } finally {
      api.stop()
    }
  }, 20_000)
})

// Direct transformer calls with a fake `prev` (no HTTP).
const okEmpty = async () => ({ ok: true, result: [] }) as any

describe('AC-3 poll.json contract', () => {
  test('startup: pid, started_at (epoch s), last_ok_at null, mode 0600', () => {
    const dir = tempDir()
    createPollLiveness({ stateDir: dir, log: () => {} })
    const hb = readHb(dir)
    expect(hb).toEqual({ pid: process.pid, started_at: hb.started_at, last_ok_at: null, consecutive_errors: 0, last_error: null })
    expect(Number.isInteger(hb.started_at)).toBe(true)
    expect(Math.abs(hb.started_at - nowS())).toBeLessThanOrEqual(5)
    expect(statSync(join(dir, POLL_FILE)).mode & 0o777).toBe(0o600)
  })

  test('OK sets last_ok_at and zeroes errors; deadline / network / 409 each add 1 and leave last_ok_at', async () => {
    const dir = tempDir()
    const { transformer } = createPollLiveness({ stateDir: dir, slackS: 0.2, log: () => {} })

    await transformer(async () => { throw new Error('boom') }, 'getUpdates', { timeout: 0 } as any).catch(() => {})
    expect(readHb(dir).consecutive_errors).toBe(1)

    await transformer(okEmpty, 'getUpdates', { timeout: 0 } as any)
    let hb = readHb(dir)
    expect(hb.consecutive_errors).toBe(0)
    expect(hb.last_error).toBeNull()
    expect(Number.isInteger(hb.last_ok_at)).toBe(true)
    expect(Math.abs(hb.last_ok_at - nowS())).toBeLessThanOrEqual(5)
    const lastOk = hb.last_ok_at

    // deadline: prev never settles; the signal it got must be aborted
    let seenSignal: AbortSignal | undefined
    const hang = (_m: any, _p: any, s?: AbortSignal) => { seenSignal = s; return new Promise<any>(() => {}) }
    const t0 = Date.now()
    await expect(transformer(hang as any, 'getUpdates', { timeout: 0 } as any)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(seenSignal?.aborted).toBe(true)
    hb = readHb(dir)
    expect([hb.consecutive_errors, hb.last_error, hb.last_ok_at]).toEqual([1, 'timeout', lastOk])

    await expect(transformer(async () => { throw new Error('ECONNRESET') }, 'getUpdates', { timeout: 0 } as any)).rejects.toThrow()
    hb = readHb(dir)
    expect([hb.consecutive_errors, hb.last_error, hb.last_ok_at]).toEqual([2, 'network', lastOk])

    const conflict = { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }
    expect(await transformer(async () => conflict as any, 'getUpdates', { timeout: 0 } as any)).toEqual(conflict)
    hb = readHb(dir)
    expect([hb.consecutive_errors, hb.last_error, hb.last_ok_at]).toEqual([3, 'http_409', lastOk])
  })

  test('no timeout in the payload (bot.stop) → deadline = slack, never NaN', async () => {
    const { transformer } = createPollLiveness({ stateDir: tempDir(), slackS: 0.2, log: () => {} })
    const t0 = Date.now()
    await expect(transformer((() => new Promise<any>(() => {})) as any, 'getUpdates', {} as any)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('other methods are passed through and do not touch poll.json', async () => {
    const dir = tempDir()
    const { transformer } = createPollLiveness({ stateDir: dir, slackS: 0.01, log: () => {} })
    const before = readFileSync(join(dir, POLL_FILE), 'utf8')
    const slow = async () => { await Bun.sleep(100); return { ok: false, error_code: 400, description: 'x' } as any }
    expect((await transformer(slow, 'sendMessage', {} as any)).ok).toBe(false)
    expect(readFileSync(join(dir, POLL_FILE), 'utf8')).toBe(before)
  })
})

describe('AC-4 no token-shaped string in poll.json or stderr', () => {
  test('errors carrying the token never reach the file or the log', async () => {
    const dir = tempDir()
    const lines: string[] = []
    const { transformer } = createPollLiveness({ stateDir: dir, slackS: 0.2, log: l => lines.push(l) })
    const leak = new Error(`request to https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates failed`)
    await transformer(async () => { throw leak }, 'getUpdates', { timeout: 0 } as any).catch(() => {})
    await transformer(async () => ({ ok: false, error_code: 401, description: `bad ${FAKE_TOKEN}` }) as any, 'getUpdates', { timeout: 0 } as any)
    const bytes = readFileSync(join(dir, POLL_FILE), 'utf8')
    expect(bytes).not.toContain(FAKE_TOKEN)
    expect(readHb(dir).last_error).toBe('http_401')

    // write failure path: one stderr line per failure streak, no token in it
    const gone = join(dir, 'missing-subdir')
    const { transformer: t2 } = createPollLiveness({ stateDir: gone, slackS: 0.2, log: l => lines.push(l) })
    await t2(async () => { throw leak }, 'getUpdates', { timeout: 0 } as any).catch(() => {})
    await t2(async () => { throw leak }, 'getUpdates', { timeout: 0 } as any).catch(() => {})
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^telegram channel: poll\.json write failed \(ENOENT\), polling continues\n$/)
    for (const l of lines) expect(l).not.toContain(FAKE_TOKEN)
  })

  test('a symlink planted at poll.json is replaced, not followed', async () => {
    const dir = tempDir()
    const victim = join(dir, 'victim.txt')
    await Bun.write(victim, 'untouched')
    const { symlinkSync, lstatSync } = await import('fs')
    symlinkSync(victim, join(dir, POLL_FILE))
    createPollLiveness({ stateDir: dir, log: () => {} })
    expect(readFileSync(victim, 'utf8')).toBe('untouched')
    expect(lstatSync(join(dir, POLL_FILE)).isSymbolicLink()).toBe(false)
  })
})
