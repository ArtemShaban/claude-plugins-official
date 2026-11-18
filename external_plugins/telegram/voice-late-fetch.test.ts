// D-1087 — a voice whose file Telegram did not hand over: placeholder with voice_pending + the author keys, then a late
// re-fetch at +2/5/10/20/40/60 min off the chat queue → one late notification or one voice_lost
// (owner tg 49563 option «в» → «Ок, делай в» tg 49565; spec sam-data dev/analysis/2026-11-18-tg-voice-late-fetch-spec.md
// criteria 3–9, 11). Hermetic: a fake clock for the tries, temp dirs, a fake Bot API on 127.0.0.1, a fake token;
// no live state, no import of server.ts (static reads only).
import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageOrigin } from 'grammy/types'
import { createTelegramDownloader } from './tg-download'
import {
  createLateVoiceFetcher,
  createVoiceLog,
  deliverVoiceTranscript,
  isRetriableDownload,
  LATE_TRY_AFTER_MS,
  LATE_VOICE_REFUSAL,
  lateFetchWanted,
  markPending,
  serialize,
  voiceAuthor,
  voiceErrorClass,
  voiceOutcomeOf,
  voicePlaceholder,
  VOICE_LOG,
  withTimeout,
  type LateVoice,
  type VoiceAuthorResult,
  type VoiceEnvelope,
  type VoiceJournal,
  type VoiceLineFields,
} from './voice-delivery'

const MIN = 60_000
const owner: VoiceAuthorResult = { voice_author: 'artem', voice_author_id: '111', voice_author_origin: 'sender', voice_trust: 'owner' }
const ownerKeys = { voice_author: 'artem', voice_author_id: '111', voice_author_origin: 'sender', voice_trust: 'owner' }

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tempDir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  dirs.push(d)
  return d
}

/** A manual clock: timers fire only on advance(); each fired try is awaited before the next one is looked at. */
function fakeClock(start = 1_000_000) {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r))
  }
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    /** Move to `to`, firing every timer due on the way, in order; returns the fire times. */
    async advanceTo(to: number, settleFn: () => Promise<void> = settle): Promise<number[]> {
      const fired: number[] = []
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        fired.push(now)
        due[1].fn()
        await settleFn()
      }
      now = to
      return fired
    },
  }
}

const err504 = () => Object.assign(new Error('getFile failed: HTTP 504'), { error_code: 504 })

function harness(o: {
  downloads: (() => Promise<string | undefined>)[]
  transcribe?: (p: string) => Promise<string>
  author?: VoiceAuthorResult
}) {
  const clock = fakeClock()
  const lines: VoiceLineFields[] = []
  const late: { env: VoiceEnvelope; lateS: number }[] = []
  let lost = 0
  const tryTimes: number[] = []
  let k = 0
  const fetcher = createLateVoiceFetcher({
    writeLine: f => lines.push(f),
    logNotice: () => {},
    nowMs: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const t0 = clock.now()
  const voice: LateVoice = {
    chat: '22276',
    msg: 49600,
    fileId: 'FILE-1',
    size: 7_456,
    durS: 7,
    tsMs: t0 - 125_000,
    arrivedMs: t0 - 121_000,
    placeholderMs: t0,
    caption: undefined,
    author: o.author ?? owner,
    download: async () => {
      tryTimes.push(clock.now() - t0)
      const d = o.downloads[Math.min(k++, o.downloads.length - 1)]
      return d()
    },
    transcribe: o.transcribe ?? (async () => 'привет, это голосовое'),
    onLate: (env, lateS) => late.push({ env, lateS }),
    onLost: () => void lost++,
  }
  return { clock, lines, late, lost: () => lost, tryTimes, fetcher, voice, t0 }
}

// ── criterion 4 — when a placeholder is marked pending and a re-fetch scheduled ─────────────────────────────────
describe('criterion 4 — voice_pending only on a retriable download failure', () => {
  async function first(fx: { cmd?: boolean; download: () => Promise<string | undefined>; transcribe?: () => Promise<string>; timedOut?: boolean }) {
    const journal: VoiceJournal = {}
    const env = await deliverVoiceTranscript(fx.cmd ?? true, undefined, owner, {
      journal,
      download: fx.download,
      transcribe: fx.transcribe ?? (async () => 'текст'),
      logNotice: () => {},
      downloadTimeoutMs: 20,
    })
    const wanted = lateFetchWanted({
      cmdConfigured: fx.cmd ?? true,
      deliveredBridge: env.meta.transcript_source === 'bridge',
      timedOut: fx.timedOut ?? false,
      journal,
    })
    let scheduled = 0
    const out = markPending(env, wanted && (scheduled++, true))
    return { out, journal, scheduled }
  }

  const retriable: [string, () => Promise<string | undefined>][] = [
    ['timeout (file never comes within the wait)', () => new Promise(() => {})],
    ['network', async () => { throw Object.assign(new Error('x'), { name: 'HttpError' }) }],
    ['error', async () => { throw new Error('telegram file download failed: internal') }],
    ['sys_ECONNRESET', async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }) }],
    ['http_504', async () => { throw err504() }],
    ['http_502', async () => { throw Object.assign(new Error('x'), { error_code: 502 }) }],
    ['http_429', async () => { throw Object.assign(new Error('x'), { error_code: 429 }) }],
  ]
  for (const [name, download] of retriable) {
    test(`${name} → placeholder with voice_pending="1" + the author keys, one re-fetch scheduled`, async () => {
      const r = await first({ download })
      expect(r.out).toEqual({ text: '(voice message)', meta: { ...ownerKeys, voice_pending: '1' } })
      expect(r.scheduled).toBe(1)
    })
  }

  const final: [string, Parameters<typeof first>[0]][] = [
    ['dl=none (no file_path / too big / over the cap)', { download: async () => undefined }],
    ['http_400', { download: async () => { throw Object.assign(new Error('x'), { error_code: 400 }) } }],
    ['no transcribe command', { cmd: false, download: async () => '/a.oga' }],
    ['whisper throws', { download: async () => '/a.oga', transcribe: async () => { throw new Error('transcribe cmd exited 1') } }],
    ['empty transcript', { download: async () => '/a.oga', transcribe: async () => '  ' }],
    ['envelope timeout', { download: async () => { throw err504() }, timedOut: true }],
  ]
  for (const [name, fx] of final) {
    test(`${name} → no voice_pending, nothing scheduled`, async () => {
      const r = await first(fx)
      expect('voice_pending' in r.out.meta).toBe(false)
      expect(r.scheduled).toBe(0)
    })
  }

  test('the closed set of retriable classes', () => {
    for (const c of ['timeout', 'network', 'error', 'sys_ENOTFOUND', 'http_500', 'http_504', 'http_429'] as const) expect(isRetriableDownload(c)).toBe(true)
    for (const c of ['ok', 'none', 'empty', 'http_400', 'http_404', 'http_200', 'exit_1', undefined] as const) expect(isRetriableDownload(c)).toBe(false)
  })
})

// ── criterion 3 — every placeholder (5 fallbacks + the outer timeout catch) carries the author/trust keys ──────
describe('criterion 3 — the author keys on every voice placeholder', () => {
  const sam = { id: 111, is_bot: false, first_name: 'Artem', username: 'artem' }
  const alice = { id: 555, is_bot: false, first_name: 'Alice', username: 'alice_h' }
  const origins: [MessageOrigin, string][] = [
    [{ type: 'user', date: 1, sender_user: alice }, 'forward_user'],
    [{ type: 'hidden_user', date: 1, sender_user_name: 'Anon' }, 'forward_hidden_user'],
    [{ type: 'chat', date: 1, sender_chat: { id: -100123, type: 'group', title: 'G' } as never }, 'forward_chat'],
    [{ type: 'channel', date: 1, message_id: 7, chat: { id: -100999, type: 'channel', title: 'C' } as never }, 'forward_channel'],
  ]
  for (const [origin, tag] of origins) {
    test(`a forwarded voice (${tag}) whose file did not come → voice_trust="data", origin ${tag}`, async () => {
      const author = voiceAuthor({ from: sam, forwardOrigin: origin }, '111')
      const env = await deliverVoiceTranscript(true, undefined, author, {
        download: async () => { throw err504() },
        transcribe: async () => 'x',
        logNotice: () => {},
      })
      expect(env.meta.voice_trust).toBe('data')
      expect(env.meta.voice_author_origin).toBe(tag)
      expect(env.meta.voice_author).toBeTruthy()
      expect('voice_author_id' in env.meta).toBe(tag !== 'forward_hidden_user')
      expect('transcript_source' in env.meta).toBe(false)
    })
  }

  test('server.ts: the outer envelope-timeout catch builds the placeholder with the author (static)', () => {
    const s = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    expect(s).toContain(').catch(() => voicePlaceholder(ctx.message?.caption, author))')
    expect(s).not.toContain("'(voice message)', meta: {}")
  })
})

// ── criterion 5 — 504, 504, ok → tries at +2, +5, +10, one late notification, late:bridge late_tries=3 ──────────
describe('criterion 5 — the late text arrives at the try that gets the file', () => {
  test('fake download 504, 504, ok: tries at +2/+5/+10 min, exactly one late notification, no 4th try', async () => {
    const h = harness({ downloads: [async () => { throw err504() }, async () => { throw err504() }, async () => '/inbox/a.oga'] })
    expect(h.fetcher.schedule(h.voice)).toBe(true)
    expect(h.fetcher.has('FILE-1')).toBe(true)
    await h.clock.advanceTo(h.t0 + 70 * MIN)
    expect(h.tryTimes).toEqual([2 * MIN, 5 * MIN, 10 * MIN])
    expect(h.late.length).toBe(1)
    expect(h.lost()).toBe(0)
    expect(h.late[0].env.text).toBe('привет, это голосовое')
    expect(h.late[0].env.meta).toMatchObject({ transcript_source: 'bridge', attachment_path: '/inbox/a.oga', ...ownerKeys })
    expect(h.late[0].lateS).toBe(Math.round((10 * MIN + 125_000) / 1000))
    expect(h.lines.length).toBe(1)
    expect(h.lines[0]).toMatchObject({ chat: '22276', msg: 49600, outcome: 'late:bridge', lateTries: 3 })
    expect(h.lines[0].totalMs).toBe(10 * MIN + 121_000)
    expect(h.lines[0].journal.dl).toBe('ok')
    expect(h.fetcher.has('FILE-1')).toBe(false)
    expect(h.clock.pending()).toBe(0)
  })

  test('a try due while the previous one still runs starts right after it (never two at once)', async () => {
    let release: (v: string | undefined) => void = () => {}
    let running = 0
    let maxRunning = 0
    const slow = () =>
      new Promise<string | undefined>((resolve, reject) => {
        running++
        maxRunning = Math.max(maxRunning, running)
        release = v => {
          running--
          v === undefined ? reject(err504()) : resolve(v)
        }
      })
    const h = harness({ downloads: [slow, async () => '/a.oga'] })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 2 * MIN) // try 1 starts and hangs
    expect(h.tryTimes).toEqual([2 * MIN])
    await h.clock.advanceTo(h.t0 + 7 * MIN) // +5 is due, but try 1 still runs → nothing new
    expect(h.tryTimes).toEqual([2 * MIN])
    release(undefined) // try 1 fails at +7
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r))
    await h.clock.advanceTo(h.t0 + 7 * MIN) // the overdue +5 try is armed at 0 ms → runs now
    expect(h.tryTimes).toEqual([2 * MIN, 7 * MIN])
    expect(maxRunning).toBe(1)
    expect(h.late.length).toBe(1)
  })

  // The spec's Proof, on the real download helper: a fake Bot API whose getFile stalls on the first delivery, answers
  // 504 on the +2 and +5 tries and serves the file on the +10 try. The wait is scaled (120 s → 150 ms; the 120 s value
  // itself is criterion 1, voice-budget.test.ts); the tries run on the fake clock.
  test('fake Bot API: stall → placeholder with voice_pending + author keys; 504, 504, file → one late notification at +10', async () => {
    let getFiles = 0
    const server = createServer((req, res) => {
      if ((req.url ?? '').includes('/getFile')) {
        getFiles++
        res.setHeader('content-type', 'application/json')
        if (getFiles === 1) return // the first delivery: Telegram holds the file
        if (getFiles <= 3) {
          res.statusCode = 504
          return res.end(JSON.stringify({ ok: false, error_code: 504, description: 'Gateway Timeout' }))
        }
        return res.end(JSON.stringify({ ok: true, result: { file_unique_id: 'AgADv', file_size: 4, file_path: 'voice/file_1.oga' } }))
      }
      res.end(Buffer.from([1, 2, 3, 4]))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const dir = tempDir('voice-late-e2e-')
    try {
      const token = '123456789:AAH-SECRET-late'
      const { downloadTelegramFile } = createTelegramDownloader({ token, origin: `http://127.0.0.1:${port}`, probeAfterMs: 60_000, capMs: 400, probe: async () => 30 })
      const download = async (j: VoiceJournal) => {
        const got = await downloadTelegramFile('FILE', { onStart: n => (j.net = n) })
        if (got.status !== 'ok') return undefined
        const p = join(dir, 'v.oga')
        writeFileSync(p, got.bytes)
        return p
      }
      const transcribe = async () => 'привет'
      const log = createVoiceLog({ stateDir: dir, pid: 9 })
      // first delivery, composed as server.ts composes it
      const journal: VoiceJournal = {}
      const env = await withTimeout(
        deliverVoiceTranscript(true, undefined, owner, { journal, download: () => download(journal), transcribe, logNotice: () => {}, downloadTimeoutMs: 150 }),
        5_000,
        () => {},
      ).catch(() => voicePlaceholder(undefined, owner))
      const deliveredBridge = env.meta.transcript_source === 'bridge'
      log({ chat: '22276', msg: 7, journal: { ...journal }, outcome: voiceOutcomeOf({ cmdConfigured: true, journal, deliveredBridge, timedOut: false }), totalMs: 150 })
      const clock = fakeClock()
      const late: { env: VoiceEnvelope; lateS: number }[] = []
      const fetcher = createLateVoiceFetcher({ writeLine: log, logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
      const scheduled =
        lateFetchWanted({ cmdConfigured: true, deliveredBridge, timedOut: false, journal }) &&
        fetcher.schedule({
          chat: '22276', msg: 7, fileId: 'FILE', tsMs: clock.now() - 1_000, arrivedMs: clock.now() - 200, placeholderMs: clock.now(),
          author: owner, download, transcribe, onLate: (e, s) => late.push({ env: e, lateS: s }), onLost: () => {},
        })
      const placeholder = markPending(env, scheduled)
      expect(placeholder).toEqual({ text: '(voice message)', meta: { ...ownerKeys, voice_pending: '1' } })
      await new Promise(r => setTimeout(r, 500)) // the stalled first download hits its (scaled) cap
      const realSettle = async () => {
        for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 10))
      }
      await clock.advanceTo(clock.now() + 70 * MIN, realSettle)
      expect(late.length).toBe(1)
      expect(late[0].env.meta).toMatchObject({ transcript_source: 'bridge', ...ownerKeys })
      expect(getFiles).toBe(4)
      const lines = readFileSync(join(dir, VOICE_LOG), 'utf8').trim().split('\n')
      expect(lines.length).toBe(2)
      expect(lines[0]).toContain(' outcome=placeholder:download ')
      expect(lines[0]).toContain(' dl_att=1 ')
      expect(lines[0]).toMatch(/ late_tries=-$/)
      expect(lines[1]).toContain(' outcome=late:bridge ')
      expect(lines[1]).toMatch(/ late_tries=3$/)
      expect(lines.join('\n')).not.toContain('SECRET')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 20_000)
})

// ── criterion 6 — the file never comes / whisper fails on the late file → one voice_lost ──────────────────────
describe('criterion 6 — lost', () => {
  test('six failed tries at +2/+5/+10/+20/+40/+60 → one lost notification, late:failed late_tries=6', async () => {
    const h = harness({ downloads: [async () => { throw err504() }] })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.tryTimes).toEqual(LATE_TRY_AFTER_MS)
    expect(LATE_TRY_AFTER_MS).toEqual([2, 5, 10, 20, 40, 60].map(m => m * MIN))
    expect(h.lost()).toBe(1)
    expect(h.late.length).toBe(0)
    expect(h.lines.length).toBe(1)
    expect(h.lines[0]).toMatchObject({ outcome: 'late:failed', lateTries: 6 })
    expect(h.lines[0].journal.dl).toBe('http_504')
    expect(h.fetcher.size()).toBe(0)
  })

  test('the file comes but whisper fails → the same lost notice, the schedule ends', async () => {
    const h = harness({ downloads: [async () => '/a.oga'], transcribe: async () => { throw new Error('transcribe cmd exited 2') } })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.tryTimes).toEqual([2 * MIN])
    expect(h.lost()).toBe(1)
    expect(h.lines[0]).toMatchObject({ outcome: 'late:failed', lateTries: 1 })
    expect(h.lines[0].journal.tr).toBe('exit_2')
  })

  test('the file comes but the transcript is empty → lost too', async () => {
    const h = harness({ downloads: [async () => '/a.oga'], transcribe: async () => ' ' })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.lost()).toBe(1)
    expect(h.lines[0].outcome).toBe('late:failed')
  })
})

// ── criterion 7 — the chat queue is held only by the 120 s wait; tries never sit in it ────────────────────────
describe('criterion 7 — order: texts after a stalled voice are never held by a try', () => {
  test('a text right after the voice comes right after the placeholder; a text at +3 min (try running) comes at once', async () => {
    const chatKey = 'chat:late-order-1'
    const delivered: string[] = []
    const clock = fakeClock()
    const fetcher = createLateVoiceFetcher({ writeLine: () => {}, logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    let tryStarted = false
    // the voice block (scaled wait 30 ms ≙ 120 s): stalls, placeholder, schedule — as server.ts does it
    void serialize(chatKey, async () => {
      const journal: VoiceJournal = {}
      const env = await deliverVoiceTranscript(true, undefined, owner, {
        journal, download: () => new Promise(() => {}), transcribe: async () => 'x', logNotice: () => {}, downloadTimeoutMs: 30,
      })
      const scheduled = fetcher.schedule({
        chat: '1', msg: 1, fileId: 'F', tsMs: 0, arrivedMs: 0, placeholderMs: clock.now(), author: owner,
        download: () => ((tryStarted = true), new Promise(() => {})), // every try hangs forever
        transcribe: async () => 'x', onLate: () => {}, onLost: () => {},
      })
      delivered.push(markPending(env, scheduled).meta.voice_pending === '1' ? 'placeholder:pending' : 'placeholder')
    })
    const t0 = performance.now()
    await serialize(chatKey, async () => void delivered.push('text-1'))
    expect(performance.now() - t0).toBeLessThan(30 + 1_000)
    expect(delivered).toEqual(['placeholder:pending', 'text-1'])
    await clock.advanceTo(clock.now() + 3 * MIN) // the +2 try started and hangs
    expect(tryStarted).toBe(true)
    const t1 = performance.now()
    await serialize(chatKey, async () => void delivered.push('text-2'))
    expect(performance.now() - t1).toBeLessThan(100)
    expect(delivered).toEqual(['placeholder:pending', 'text-1', 'text-2'])
  })

  test('voice-delivery.ts: the late fetcher never touches serialize (static)', () => {
    const s = readFileSync(join(import.meta.dir, 'voice-delivery.ts'), 'utf8')
    const fetcher = s.slice(s.indexOf('export function createLateVoiceFetcher('))
    expect(fetcher.length).toBeGreaterThan(100)
    expect(fetcher.includes('serialize(')).toBe(false)
  })

  test('server.ts: late / lost go out through emitDirect (mcp.notification), never deliverWakeWithBuffer (static)', () => {
    const s = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    const emit = s.slice(s.indexOf('const emitDirect = '), s.indexOf('const emitDirect = ') + 400)
    expect(emit).toContain("mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })")
    const sched = s.slice(s.indexOf('scheduled = lateVoice.schedule({'), s.indexOf('const delivered = markPending(envelope, scheduled)'))
    expect(sched).toContain('onLate: (late, lateS) =>')
    expect(sched).toContain("emitDirect(late.text, { ...baseMeta, ...late.meta, voice_late_s: String(lateS) })")
    expect(sched).toContain("voice_lost: '1'")
    expect(sched).toContain('...voiceAuthorMeta(author)')
    expect(sched.includes('deliverWakeWithBuffer')).toBe(false)
    expect(sched.includes('serialize(')).toBe(false)
    // ONE meta builder shared by the wake and the late notification
    expect(s.match(/user_id: String\(from\.id\),\n\s+ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\)/g)?.length).toBe(1)
    expect(s).toContain('...baseMeta,\n                ...(imagePath ? { image_path: imagePath } : {}),')
  })
})

// ── criterion 8 — download_attachment refuses a file under re-fetch, at once ─────────────────────────────────
describe('criterion 8 — download_attachment and the registry', () => {
  test('has(file_id) is true while scheduled and false once the schedule ends', async () => {
    const h = harness({ downloads: [async () => '/a.oga'] })
    h.fetcher.schedule(h.voice)
    expect(h.fetcher.has('FILE-1')).toBe(true)
    expect(h.fetcher.has('OTHER')).toBe(false)
    await h.clock.advanceTo(h.t0 + 3 * MIN)
    expect(h.fetcher.has('FILE-1')).toBe(false)
  })

  test('the refusal is one fixed English text that names the late message', () => {
    expect(LATE_VOICE_REFUSAL).toContain('re-fetched by the plugin')
    expect(LATE_VOICE_REFUSAL).toContain('voice_late_s')
    expect(LATE_VOICE_REFUSAL).toContain('voice_lost')
    expect(/[^\x20-\x7e—]/.test(LATE_VOICE_REFUSAL)).toBe(false)
  })

  test("server.ts: case 'download_attachment' consults the registry before it downloads (static)", () => {
    const s = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    const c = s.slice(s.indexOf("case 'download_attachment': {"), s.indexOf("case 'secretary_watch': {"))
    const check = c.indexOf('if (lateVoice.has(file_id)) throw new Error(LATE_VOICE_REFUSAL)')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(c.indexOf('downloadTelegramFile(file_id)'))
  })
})

// ── criterion 9 — a late try runs the first delivery's own effects ───────────────────────────────────────────
describe('criterion 9 — same download effect, same transcribe effect (original transcribeFlags)', () => {
  test('the fetcher calls exactly the effects it was given, with a fresh journal per try', async () => {
    const journals: VoiceJournal[] = []
    const transcribed: string[] = []
    const h = harness({ downloads: [async () => { throw err504() }, async () => '/store/49600.oga'] })
    const download = h.voice.download
    h.voice.download = j => (journals.push(j), download(j))
    h.voice.transcribe = async p => (transcribed.push(p), 'ok text')
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 10 * MIN)
    expect(journals.length).toBe(2)
    expect(journals[0]).not.toBe(journals[1])
    expect(transcribed).toEqual(['/store/49600.oga'])
  })

  test('server.ts passes the first delivery’s voiceDownload / voiceTranscribe (static)', () => {
    const s = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    const tr = s.slice(s.indexOf('const voiceTranscribe = (audioPath: string) =>'), s.indexOf('const envelope = await withTimeout('))
    expect(tr).toContain("serialize('whisper', () =>")
    expect(tr).toContain('extraArgs: transcribeFlags(ownerSent, msgId, chat_id)')
    const dl = s.slice(s.indexOf('const voiceDownload = async (j: VoiceJournal) =>'), s.indexOf('const voiceTranscribe'))
    expect(dl).toContain('(await keepOthersMedia(ctx, fileId, sizeHint)) ??')
    expect(dl).toContain("downloadFileToInbox(fileId, INBOX_DIR, sizeHint, 'oga', net => (j.net = net))")
    const sched = s.slice(s.indexOf('scheduled = lateVoice.schedule({'), s.indexOf('const delivered = markPending(envelope, scheduled)'))
    expect(sched).toContain('download: voiceDownload,')
    expect(sched).toContain('transcribe: voiceTranscribe,')
    expect(s).toContain('download: () => voiceDownload(journal),')
    expect(s).toContain('transcribe: voiceTranscribe,\n          logNotice: voiceLogNotice,')
  })
})

// ── criterion 11 — a plugin stop leaves a trace per pending voice ─────────────────────────────────────────────
describe('criterion 11 — shutdown writes late:abandoned', () => {
  test('N entries → N late:abandoned lines, synchronously; nothing runs after', async () => {
    const h = harness({ downloads: [async () => { throw err504() }] })
    h.fetcher.schedule(h.voice)
    h.fetcher.schedule({ ...h.voice, msg: 49601, fileId: 'FILE-2' })
    h.fetcher.schedule({ ...h.voice, msg: 49602, fileId: 'FILE-3' })
    await h.clock.advanceTo(h.t0 + 3 * MIN) // each had one try
    expect(h.fetcher.abandonAll()).toBe(3)
    expect(h.lines.map(l => [l.msg, l.outcome, l.lateTries])).toEqual([
      [49600, 'late:abandoned', 1],
      [49601, 'late:abandoned', 1],
      [49602, 'late:abandoned', 1],
    ])
    expect(h.clock.pending()).toBe(0)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.tryTimes.length).toBe(3)
    expect(h.lost()).toBe(0)
    expect(h.lines.length).toBe(3)
  })

  test('a try still running when the plugin stops emits nothing afterwards', async () => {
    let release: (v: string) => void = () => {}
    const h = harness({ downloads: [() => new Promise(r => (release = r))] })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 2 * MIN)
    h.fetcher.abandonAll()
    release('/a.oga')
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r))
    expect(h.late.length).toBe(0)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:abandoned'])
  })

  test('the abandoned line on disk: late_tries is `-` when no try ran yet', () => {
    const dir = tempDir('voice-abandon-')
    const fetcher = createLateVoiceFetcher({ writeLine: createVoiceLog({ stateDir: dir, pid: 3 }), logNotice: () => {} })
    fetcher.schedule({
      chat: '22276', msg: 5, fileId: 'F', tsMs: 0, arrivedMs: Date.now(), placeholderMs: Date.now(), author: owner,
      download: async () => undefined, transcribe: async () => '', onLate: () => {}, onLost: () => {},
    })
    fetcher.abandonAll()
    const line = readFileSync(join(dir, VOICE_LOG), 'utf8')
    expect(line).toContain(' outcome=late:abandoned ')
    expect(line).toMatch(/ late_tries=-\n$/)
  })

  test('server.ts: function shutdown( calls lateVoice.abandonAll() (static)', () => {
    const s = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    const body = s.slice(s.indexOf("function shutdown(reason = 'shutdown: unknown'): void {"), s.indexOf("process.stdin.on('end'"))
    expect(body).toContain('lateVoice.abandonAll()')
    expect(body.indexOf('lateVoice.abandonAll()')).toBeLessThan(body.indexOf('process.exit(0)'))
  })
})

describe('the same voice is taken once', () => {
  test('schedule() of the same chat+msg twice → false the second time', () => {
    const h = harness({ downloads: [async () => undefined] })
    expect(h.fetcher.schedule(h.voice)).toBe(true)
    expect(h.fetcher.schedule(h.voice)).toBe(false)
    expect(h.fetcher.size()).toBe(1)
  })
  test('a throwing onLate is contained: the line is written, the entry is gone', async () => {
    const h = harness({ downloads: [async () => '/a.oga'] })
    h.voice.onLate = () => { throw new Error('mcp closed') }
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 3 * MIN)
    expect(h.lines[0].outcome).toBe('late:bridge')
    expect(h.fetcher.size()).toBe(0)
    expect(voiceErrorClass(new Error('mcp closed'))).toBe('error')
  })
})
