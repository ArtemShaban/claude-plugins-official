// D-1087 — a voice whose file Telegram did not hand over: placeholder with voice_pending + the author keys, then a late
// re-fetch at +2/5/10/20/40/60 min off the chat queue → one late notification or one voice_lost
// (owner tg 49563 option «в» → «Ок, делай в» tg 49565; spec sam-data dev/analysis/2026-11-18-tg-voice-late-fetch-spec.md
// criteria 3–9, 11). Hermetic: a fake clock for the tries, temp dirs, a fake Bot API on 127.0.0.1, a fake token;
// no live state, no import of server.ts (static reads only).
import { afterAll, describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageOrigin } from 'grammy/types'
import { createTelegramDownloader } from './tg-download'
import { createKeeper, keptFilesDir } from './chat-store'
import { deliverWakeWithBuffer } from './group-buffer'
import {
  createLateVoiceFetcher,
  createVoiceLog,
  deliverVoiceTranscript,
  isRetriableDownload,
  LATE_DEADLINE_MS,
  LATE_TRY_AFTER_MS,
  LATE_VOICE_REFUSAL,
  lateFetchWanted,
  markPending,
  serialize,
  TERMINAL_EMIT_MS,
  voiceAuthor,
  voiceErrorClass,
  voiceOutcomeOf,
  voiceDownloadEffects,
  voicePlaceholder,
  voiceTranscribeEffect,
  VOICE_LOG,
  wakeThenArm,
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
    expect(emit.includes('void mcp.notification')).toBe(false) // the fetcher awaits it (r1 f2)
    const sched = s.slice(s.indexOf('lateCandidate = {'), s.indexOf('bodyText = envelope.text'))
    expect(sched).toContain('onLate: (late, lateS) =>')
    expect(sched).toContain("emitDirect(late.text, { ...baseMeta, ...late.meta, voice_late_s: String(lateS) })")
    expect(sched).toContain("voice_lost: '1'")
    expect(sched).toContain('...voiceAuthorMeta(author)')
    expect(sched.includes('deliverWakeWithBuffer')).toBe(false)
    expect(sched.includes('serialize(')).toBe(false)
    // ONE meta builder shared by the wake and the late notification
    expect(s.match(/user_id: String\(from\.id\),\n\s+ts: new Date\(\(ctx\.message\?\.date \?\? 0\) \* 1000\)\.toISOString\(\)/g)?.length).toBe(1)
    expect(s).toContain('...baseMeta,\n                    ...(imagePath ? { image_path: imagePath } : {}),')
    // the placeholder's wake goes through wakeThenArm (r1 f1): armed only after it was accepted
    expect(s).toContain('await wakeThenArm({\n      fetcher: lateVoice,\n      envelope: { text: bodyText, meta: voiceMeta },\n      late: lateCandidate,')
    expect(s.includes('lateVoice.schedule(')).toBe(false)
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
    const tr = s.slice(s.indexOf('const voiceTranscribe = voiceTranscribeEffect({'), s.indexOf('const envelope = await withTimeout('))
    expect(tr).toContain("queue: job => serialize('whisper', job),")
    expect(tr).toContain('ownerSent,\n        msgId,\n        chatId: chat_id,')
    expect(tr).toContain('{ timeoutMs, extraArgs, signal }')
    const dl = s.slice(s.indexOf('const voiceDownload = voiceDownloadEffects({'), s.indexOf('const voiceTranscribe'))
    expect(dl).toContain('keep: othersKeep(ctx, fileId, sizeHint),')
    expect(dl).toContain("inbox: j => downloadFileToInbox(fileId, INBOX_DIR, sizeHint, 'oga', net => (j.net = net)),")
    const sched = s.slice(s.indexOf('lateCandidate = {'), s.indexOf('bodyText = envelope.text'))
    expect(sched).toContain('download: voiceDownload.late,')
    expect(sched).toContain('transcribe: voiceTranscribe,')
    expect(s).toContain('download: () => voiceDownload.first(journal),')
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
  test('a throwing onLate is contained: late:undelivered is written, the entry is gone (r1 f2)', async () => {
    const h = harness({ downloads: [async () => '/a.oga'] })
    h.voice.onLate = () => { throw new Error('mcp closed') }
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 3 * MIN)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:undelivered'])
    expect(h.fetcher.size()).toBe(0)
    expect(voiceErrorClass(new Error('mcp closed'))).toBe('error')
  })
})

// ═════ Codex r1 (sam-data …/codex-agent-runs/20261118T1205Z-driver-tg-voice-late-fetch-r1/out.json) ═════

// ── f1 — the retry is armed only after the placeholder's wake was accepted (real deliverWakeWithBuffer) ──────────
describe('r1 f1 — wakeThenArm: transactional with the first delivery', () => {
  function wiring(notify: (content: string, meta: Record<string, string>) => Promise<void>) {
    const clock = fakeClock()
    const lines: VoiceLineFields[] = []
    const fired: string[] = []
    const fetcher = createLateVoiceFetcher({ writeLine: f => lines.push(f), logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const late: Omit<LateVoice, 'placeholderMs'> = {
      chat: '22276', msg: 49610, fileId: 'FILE-W', tsMs: clock.now() - 125_000, arrivedMs: clock.now() - 121_000, author: owner,
      download: async () => '/a.oga', transcribe: async () => 'текст',
      onLate: () => void fired.push('late'), onLost: () => void fired.push('lost'),
    }
    const run = () =>
      wakeThenArm({
        fetcher,
        envelope: voicePlaceholder(undefined, owner),
        late,
        nowMs: clock.now,
        wake: env => deliverWakeWithBuffer([], env.text, () => '/unused', {
          notify: (content, extra) => notify(content, { chat_id: '22276', message_id: '49610', user_id: '111', ...env.meta, ...extra }),
          reset: () => {},
          logError: () => {},
        }),
      })
    return { clock, lines, fired, fetcher, run }
  }

  test('the initial notification rejects → nothing armed: registry 0, timers 0, no late / lost ever; one late:undelivered line (N9)', async () => {
    const w = wiring(async () => { throw new Error('transport closed') })
    expect(await w.run()).toBe(false)
    expect(w.fetcher.size()).toBe(0)
    expect(w.clock.pending()).toBe(0)
    await w.clock.advanceTo(w.clock.now() + 180 * MIN)
    expect(w.fired).toEqual([])
    // the voice will never be re-fetched: one closing line now, so a leg does not wait 70 min for it (re-review N9)
    expect(w.lines.map(l => [l.outcome, l.lateTries, l.msg])).toEqual([['late:undelivered', 0, 49610]])
    // the reservation is gone: the same message can be taken again
    expect(w.fetcher.reserve('22276', 49610)).toBe(true)
  })

  test('the initial notification is accepted → it carried voice_pending="1" and exactly one entry is armed', async () => {
    const sent: Record<string, string>[] = []
    const w = wiring(async (_c, meta) => void sent.push(meta))
    expect(await w.run()).toBe(true)
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ voice_pending: '1', ...ownerKeys, message_id: '49610', user_id: '111' })
    expect(w.fetcher.size()).toBe(1)
    expect(w.fetcher.has('FILE-W')).toBe(true)
    await w.clock.advanceTo(w.clock.now() + 3 * MIN)
    expect(w.fired).toEqual(['late'])
  })

  test('a message with no late candidate (any non-voice, a bridged voice) → no voice_pending, nothing armed', async () => {
    const sent: Record<string, string>[] = []
    const clock = fakeClock()
    const fetcher = createLateVoiceFetcher({ writeLine: () => {}, logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const ok = await wakeThenArm({ fetcher, envelope: { text: 'hi', meta: {} }, wake: async env => (sent.push(env.meta), true) })
    expect(ok).toBe(true)
    expect(sent).toEqual([{}])
    expect(fetcher.size()).toBe(0)
  })
})

// ── rr1-1 — retry eligibility is per chat+msg; a shared Telegram file_id blocks nothing ──────────────────────────
describe('rr1-1 — two messages sharing one file_id (real deliverWakeWithBuffer + real fetcher + fake clock)', () => {
  function two() {
    const clock = fakeClock()
    const lines: VoiceLineFields[] = []
    const fetcher = createLateVoiceFetcher({ writeLine: f => lines.push(f), logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const sent: Record<string, string>[] = []
    const fired: string[] = []
    const mk = (msg: number, download: () => Promise<string | undefined>): Omit<LateVoice, 'placeholderMs'> => ({
      chat: '22276', msg, fileId: 'SAME-FILE-ID', tsMs: clock.now() - 125_000, arrivedMs: clock.now() - 121_000, author: owner,
      download, transcribe: async () => `текст ${msg}`,
      onLate: () => void fired.push(`late ${msg}`), onLost: () => void fired.push(`lost ${msg}`),
    })
    const wake = (msg: number, late: Omit<LateVoice, 'placeholderMs'>) =>
      wakeThenArm({
        fetcher, envelope: voicePlaceholder(undefined, owner), late, nowMs: clock.now,
        wake: wakeEnv => deliverWakeWithBuffer([], wakeEnv.text, () => '/unused', {
          notify: async (_c, extra) => void sent.push({ message_id: String(msg), ...wakeEnv.meta, ...extra }),
          reset: () => {}, logError: () => {},
        }),
      })
    return { clock, lines, fetcher, sent, fired, mk, wake }
  }

  test('both wakes carry voice_pending, registry 2, one late/lost each, has(fileId) true until both entries close', async () => {
    const w = two()
    let bTries = 0
    const a = w.mk(49701, async () => '/a.oga') // A gets its file at +2
    const b = w.mk(49702, async () => (++bTries < 2 ? undefined : '/b.oga')) // B: first try gives no file → +5 gets it
    expect(await w.wake(49701, a)).toBe(true)
    expect(await w.wake(49702, b)).toBe(true) // same file_id, accepted while A is pending
    expect(w.sent.map(m => [m.message_id, m.voice_pending])).toEqual([['49701', '1'], ['49702', '1']])
    expect(w.fetcher.size()).toBe(2)
    expect(w.fetcher.has('SAME-FILE-ID')).toBe(true)
    await w.clock.advanceTo(w.clock.now() + 2 * MIN) // A's late text → A closed, B still open
    expect(w.fired).toContain('late 49701')
    expect(w.fetcher.size()).toBe(1)
    expect(w.fetcher.has('SAME-FILE-ID')).toBe(true) // B still under re-fetch: download_attachment stays refused
    await w.clock.advanceTo(w.clock.now() + 3 * MIN) // B's try at +5
    expect([...w.fired].sort()).toEqual(['late 49701', 'late 49702'])
    expect(w.fetcher.size()).toBe(0)
    expect(w.fetcher.has('SAME-FILE-ID')).toBe(false)
    await w.clock.advanceTo(w.clock.now() + 200 * MIN)
    expect(w.fired.length).toBe(2) // each message got exactly one notification
    expect(w.lines.map(l => [l.msg, l.outcome]).sort()).toEqual([[49701, 'late:bridge'], [49702, 'late:bridge']])
    expect(w.clock.pending()).toBe(0)
  })

  test('the same message woken twice at once: only one reservation — one marker, one entry', async () => {
    const w = two()
    const a = w.mk(49703, async () => '/a.oga')
    const [r1, r2] = await Promise.all([w.wake(49703, a), w.wake(49703, a)])
    expect([r1, r2]).toEqual([true, true])
    expect(w.sent.map(m => m.voice_pending)).toEqual(['1', undefined])
    expect(w.fetcher.size()).toBe(1)
  })

  test('reserve / schedule: a different message is independent; a taken message cannot be reserved', () => {
    const w = two()
    expect(w.fetcher.reserve('22276', 1)).toBe(true)
    expect(w.fetcher.reserve('22276', 1)).toBe(false)
    expect(w.fetcher.reserve('22276', 2)).toBe(true)
    w.fetcher.schedule({ ...w.mk(1, async () => undefined), placeholderMs: w.clock.now() })
    expect(w.fetcher.reserve('22276', 1)).toBe(false) // taken now
  })
})

// ── f2 — a late / lost emission closes the voice only once the transport accepted it ─────────────────────────────
describe('r1 f2 — awaitable late / lost emission', () => {
  test('onLate rejects → no late:bridge, one late:undelivered line, a loud notice; never a second emission', async () => {
    const notices: string[] = []
    const h = harness({ downloads: [async () => '/a.oga'] })
    const fetcher = createLateVoiceFetcher({ writeLine: f => h.lines.push(f), logNotice: r => notices.push(r), nowMs: h.clock.now, setTimer: h.clock.setTimer, clearTimer: h.clock.clearTimer })
    let calls = 0
    h.voice.onLate = async () => { calls++; throw new Error('Not connected') }
    fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(calls).toBe(1)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:undelivered'])
    expect(h.lines.some(l => l.outcome === 'late:bridge')).toBe(false)
    expect(notices.some(n => n.startsWith('late notification not accepted by the session'))).toBe(true)
    expect(fetcher.size()).toBe(0)
    expect(h.clock.pending()).toBe(0)
  })

  test('onLost rejects → late:undelivered, not late:failed', async () => {
    const h = harness({ downloads: [async () => { throw err504() }] })
    const fetcher = createLateVoiceFetcher({ writeLine: f => h.lines.push(f), logNotice: () => {}, nowMs: h.clock.now, setTimer: h.clock.setTimer, clearTimer: h.clock.clearTimer })
    h.voice.onLost = async () => { throw new Error('Not connected') }
    fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:undelivered'])
    expect(h.lines[0].lateTries).toBe(6)
  })

  test('a succeeding emission: the entry stays (download_attachment refused) until accepted, then closes exactly once', async () => {
    let accept: () => void = () => {}
    const h = harness({ downloads: [async () => '/a.oga'] })
    h.voice.onLate = () => new Promise<void>(r => (accept = r))
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 3 * MIN)
    expect(h.lines).toEqual([])
    expect(h.fetcher.has('FILE-1')).toBe(true)
    accept()
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    await h.clock.advanceTo(h.t0 + 120 * MIN)
    expect(h.lines.map(l => [l.outcome, l.lateTries])).toEqual([['late:bridge', 1]])
    expect(h.fetcher.size()).toBe(0)
  })

  test('the voice.log line format accepts late:undelivered', () => {
    const dir = tempDir('voice-undelivered-')
    createVoiceLog({ stateDir: dir, pid: 4 })({ chat: '22276', msg: 9, journal: { dl: 'ok' }, outcome: 'late:undelivered', totalMs: 5, lateTries: 2 })
    expect(readFileSync(join(dir, VOICE_LOG), 'utf8')).toContain(' outcome=late:undelivered ')
  })
})

// ── f3 — +70 min is a real upper bound, whisper-queue wait included ─────────────────────────────────────────────
describe('r1 f3 — the deadline bounds the whole re-fetch', () => {
  test('three late voices blocked on the shared whisper queue: each gets exactly one final outcome by +70, no expired job runs', async () => {
    const clock = fakeClock()
    const lines: VoiceLineFields[] = []
    const fetcher = createLateVoiceFetcher({ writeLine: f => lines.push(f), logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    const runs: string[] = []
    const signals: AbortSignal[] = []
    let releaseFirst: () => void = () => {}
    const queueKey = `whisper-r1f3-${Math.random()}`
    // Voice 1's whisper run holds the one whisper slot until +75 min (a kill that did not take — the worst case);
    // voices 2 and 3 wait behind it in the queue.
    const transcribe = voiceTranscribeEffect({
      ownerSent: true, msgId: 1, chatId: '22276',
      queue: job => serialize(queueKey, job),
      run: (audioPath, _args, signal) => {
        runs.push(audioPath)
        if (signal) signals.push(signal)
        return new Promise<string>(resolve => (releaseFirst = () => resolve('поздно')))
      },
    })
    const final: string[] = []
    const t0 = clock.now()
    for (const n of [1, 2, 3]) {
      fetcher.schedule({
        chat: '22276', msg: 49620 + n, fileId: `F${n}`, tsMs: t0 - 1_000, arrivedMs: t0, placeholderMs: t0, author: owner,
        download: async () => `/a${n}.oga`, transcribe,
        onLate: () => void final.push(`late ${n}`), onLost: () => void final.push(`lost ${n}`),
      })
    }
    const stopAt = LATE_DEADLINE_MS // work stops at the declared +70 min end (rr2-2); the lost notice goes out then
    await clock.advanceTo(t0 + stopAt - 1)
    expect(runs).toEqual(['/a1.oga']) // voice 1 holds whisper; 2 and 3 wait in the queue
    expect(final).toEqual([]) // nothing final while work is pending
    expect(lines).toEqual([])
    await clock.advanceTo(t0 + stopAt)
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r))
    expect(final.sort()).toEqual(['lost 1', 'lost 2', 'lost 3'])
    expect(lines.map(l => l.outcome)).toEqual(['late:failed', 'late:failed', 'late:failed'])
    expect(signals.length).toBe(1)
    expect(signals[0].aborted).toBe(true) // the running job is told to die (server.ts kills the child on abort)
    await clock.advanceTo(t0 + 75 * MIN)
    releaseFirst() // voice 1's whisper finally returns: its text is dropped, the queue moves on
    for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r))
    await clock.advanceTo(t0 + 300 * MIN)
    expect(runs).toEqual(['/a1.oga']) // the queued, expired jobs of voices 2 and 3 never started
    expect(final.length).toBe(3)
    expect(lines.length).toBe(3)
    expect(fetcher.size()).toBe(0)
    expect(clock.pending()).toBe(0)
  })

  test('LATE_DEADLINE_MS is 70 min and comes after the last try at +60; the terminal window is 30 s', () => {
    expect(LATE_DEADLINE_MS).toBe(70 * MIN)
    expect(LATE_DEADLINE_MS).toBeGreaterThan(LATE_TRY_AFTER_MS[LATE_TRY_AFTER_MS.length - 1])
    expect(TERMINAL_EMIT_MS).toBe(30_000)
  })
})

// ── rr1 f3 — a notification the transport never answers is bounded by the same deadline ─────────────────────────
describe('rr1 f3 — a never-settling final notification closes once as late:undelivered by +70 min', () => {
  function hung(kind: 'late' | 'lost-after-tries' | 'lost-at-deadline') {
    const h = harness({
      downloads: [kind === 'lost-after-tries' ? async () => { throw err504() } : async () => '/a.oga'],
      transcribe: kind === 'lost-at-deadline' ? () => new Promise<string>(() => {}) : undefined, // whisper never returns
    })
    const notices: string[] = []
    const fetcher = createLateVoiceFetcher({ writeLine: f => h.lines.push(f), logNotice: r => notices.push(r), nowMs: h.clock.now, setTimer: h.clock.setTimer, clearTimer: h.clock.clearTimer })
    const calls = { late: 0, lost: 0 }
    const settle: { resolve: () => void; reject: (e: unknown) => void }[] = []
    const never = () => new Promise<void>((resolve, reject) => settle.push({ resolve, reject }))
    h.voice.onLate = () => { calls.late++; return never() }
    h.voice.onLost = () => { calls.lost++; return never() }
    fetcher.schedule(h.voice)
    return { h, fetcher, calls, settle, notices }
  }
  const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)) }

  for (const kind of ['late', 'lost-after-tries', 'lost-at-deadline'] as const) {
    for (const later of ['resolves', 'rejects'] as const) {
      // late / lost-after-tries start before +70 → the voice's hard end +70; lost-at-deadline starts AT +70 → its own
      // TERMINAL_EMIT_MS window → +70:30 (rr2-2)
      const endAt = kind === 'lost-at-deadline' ? LATE_DEADLINE_MS + TERMINAL_EMIT_MS : LATE_DEADLINE_MS
      test(`${kind}: transport never answers → one late:undelivered at +${endAt / MIN} min, entry and timers gone; a later ${later} changes nothing`, async () => {
        const w = hung(kind)
        await w.h.clock.advanceTo(w.h.t0 + endAt - 1)
        expect(w.h.lines).toEqual([]) // still inside the window: the notification is still being waited for
        expect(w.fetcher.has('FILE-1')).toBe(true) // download_attachment still refused meanwhile
        await w.h.clock.advanceTo(w.h.t0 + endAt)
        await drain()
        expect(w.h.lines.map(l => l.outcome)).toEqual(['late:undelivered'])
        expect(w.fetcher.size()).toBe(0)
        expect(w.fetcher.has('FILE-1')).toBe(false)
        expect(w.h.clock.pending()).toBe(0)
        expect(w.notices.some(n => n.includes('not accepted by the session at the deadline'))).toBe(true)
        expect(w.calls.late + w.calls.lost).toBe(1) // exactly one emission was attempted
        // the transport finally answers — late: no second outcome, no second emission, no timers
        for (const s of w.settle) later === 'resolves' ? s.resolve() : s.reject(new Error('Not connected'))
        await drain()
        await w.h.clock.advanceTo(w.h.t0 + 300 * MIN)
        expect(w.h.lines.map(l => l.outcome)).toEqual(['late:undelivered'])
        expect(w.calls.late + w.calls.lost).toBe(1)
        expect(w.fetcher.size()).toBe(0)
        expect(w.h.clock.pending()).toBe(0)
      })
    }
  }

  // rr2-2 — the work/abort deadline is the declared +70 min end, not 30 s earlier
  test('+60 try whose whisper finishes at +69:45, onLate accepted at once → one late:bridge, never onLost, no timers at +70', async () => {
    // downloads 1..5 fail with 504 (tries at +2..+40); the +60 try gets the file and whisper returns at +69:45
    const failing = [async () => { throw err504() }, async () => { throw err504() }, async () => { throw err504() },
      async () => { throw err504() }, async () => { throw err504() }, async () => '/a.oga']
    const h2 = harness({ downloads: failing })
    h2.voice.transcribe = () => new Promise<string>(resolve => { h2.clock.setTimer(() => resolve('поздний текст'), 9 * MIN + 45_000) })
    h2.fetcher.schedule(h2.voice)
    await h2.clock.advanceTo(h2.t0 + 60 * MIN)
    expect(h2.tryTimes.length).toBe(6)
    expect(h2.lines).toEqual([])
    await h2.clock.advanceTo(h2.t0 + 69 * MIN + 44_999)
    expect(h2.late.length).toBe(0)
    await h2.clock.advanceTo(h2.t0 + 69 * MIN + 45_000)
    await h2.clock.advanceTo(h2.t0 + LATE_DEADLINE_MS + MIN)
    expect(h2.late.length).toBe(1)
    expect(h2.lost()).toBe(0)
    expect(h2.lines.map(l => l.outcome)).toEqual(['late:bridge'])
    await h2.clock.advanceTo(h2.t0 + 300 * MIN)
    expect(h2.lines.length).toBe(1)
    expect(h2.fetcher.size()).toBe(0)
    expect(h2.clock.pending()).toBe(0)
  })

  test('whisper never returns, lost notice at +70:00 with an accepting transport → late:failed (not undelivered), no timers', async () => {
    const h = harness({ downloads: [async () => '/a.oga'], transcribe: () => new Promise<string>(() => {}) })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + LATE_DEADLINE_MS - 1)
    expect(h.lost()).toBe(0)
    expect(h.lines).toEqual([])
    await h.clock.advanceTo(h.t0 + LATE_DEADLINE_MS)
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r))
    expect(h.lost()).toBe(1)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:failed'])
    await h.clock.advanceTo(h.t0 + 300 * MIN)
    expect(h.lines.length).toBe(1)
    expect(h.fetcher.size()).toBe(0)
    expect(h.clock.pending()).toBe(0)
  })

  test('a notification accepted before the deadline still closes as late:bridge, and its hard-end timer is cleared', async () => {
    const h = harness({ downloads: [async () => '/a.oga'] })
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 3 * MIN)
    expect(h.lines.map(l => l.outcome)).toEqual(['late:bridge'])
    expect(h.clock.pending()).toBe(0)
  })
})

// ── f4 — another author's voice: one Bot API request per late try, store path kept ──────────────────────────────
describe('r1 f4 — the store path makes one getFile per late try', () => {
  test('fake Bot API: two stalled tries then the file; exactly one getFile per try, none after the wait; kept in the store', async () => {
    const getFileAt: number[] = []
    let clockNow = () => 0
    const server = createServer((req, res) => {
      if ((req.url ?? '').includes('/getFile')) {
        getFileAt.push(clockNow())
        res.setHeader('content-type', 'application/json')
        if (getFileAt.length <= 2) return // Telegram holds the file (the downloader's cap aborts it)
        return res.end(JSON.stringify({ ok: true, result: { file_unique_id: 'AgADo', file_size: 4, file_path: 'voice/file_9.oga' } }))
      }
      res.end(Buffer.from([1, 2, 3, 4]))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const root = tempDir('voice-late-store-')
    const inbox = tempDir('voice-late-inbox-')
    try {
      // the 120 s wait scaled to 150 ms; the downloader's own cap to 400 ms (the stalled request is aborted there)
      const { downloadTelegramFile } = createTelegramDownloader({ token: '123456789:AAH-SECRET-store', origin: `http://127.0.0.1:${port}`, probeAfterMs: 60_000, capMs: 400, probe: async () => 30 })
      const keeper = createKeeper({
        download: async fileId => {
          const got = await downloadTelegramFile(fileId)
          if (got.status === 'no_file') return undefined
          if (got.status === 'too_big') return 'too_big'
          return { bytes: got.bytes, ext: got.ext || 'bin' }
        },
        log: () => {},
      })
      const effects = voiceDownloadEffects({
        keep: () => keeper.keep(root, '-1001', 49630, 'FILE-O', 4),
        inbox: async j => {
          const got = await downloadTelegramFile('FILE-O', { onStart: n => (j.net = n) })
          if (got.status !== 'ok') return undefined
          const p = join(inbox, 'o.oga')
          writeFileSync(p, got.bytes)
          return p
        },
      })
      const clock = fakeClock()
      clockNow = () => clock.now()
      const alice: VoiceAuthorResult = { voice_author: 'alice_h', voice_author_id: '555', voice_author_origin: 'sender', voice_trust: 'data' }
      const late: VoiceEnvelope[] = []
      const fetcher = createLateVoiceFetcher({ writeLine: () => {}, logNotice: () => {}, nowMs: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, downloadTimeoutMs: 150 })
      const t0 = clock.now()
      fetcher.schedule({
        chat: '-1001', msg: 49630, fileId: 'FILE-O', tsMs: t0 - 1_000, arrivedMs: t0, placeholderMs: t0, author: alice,
        download: effects.late, transcribe: async () => 'чужой текст', onLate: env => void late.push(env), onLost: () => {},
      })
      // the try's wait (150 ms) ends long before the downloader's cap (400 ms); then wait well past the cap
      const pastTheCap = async () => {
        for (let i = 0; i < 25; i++) await new Promise(r => setTimeout(r, 40))
      }
      for (const [k, offset] of [[1, 2], [2, 5], [3, 10]] as const) {
        await clock.advanceTo(t0 + offset * MIN, pastTheCap)
        expect(getFileAt.length).toBe(k)
        expect(getFileAt[k - 1]).toBe(t0 + offset * MIN)
      }
      expect(late.length).toBe(1)
      expect(late[0].meta).toMatchObject({ transcript_source: 'bridge', voice_trust: 'data', voice_author: 'alice_h' })
      expect(late[0].meta.attachment_path.startsWith(keptFilesDir(root, '-1001'))).toBe(true)
      expect(existsSync(late[0].meta.attachment_path)).toBe(true)
      expect(existsSync(join(inbox, 'o.oga'))).toBe(false) // never the inbox fallback on a late try
      await clock.advanceTo(t0 + 120 * MIN, pastTheCap)
      expect(getFileAt.length).toBe(3)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  }, 30_000)

  test('the first delivery keeps its inbox fallback; the person\'s own voice uses the inbox on both', async () => {
    const calls: string[] = []
    const others = voiceDownloadEffects({ keep: async () => (calls.push('keep'), undefined), inbox: async () => (calls.push('inbox'), '/inbox/x.oga') })
    expect(await others.first({})).toBe('/inbox/x.oga')
    expect(calls).toEqual(['keep', 'inbox'])
    calls.length = 0
    expect(await others.late({})).toBeUndefined()
    expect(calls).toEqual(['keep'])
    const own = voiceDownloadEffects({ keep: undefined, inbox: async () => (calls.push('own'), '/inbox/own.oga') })
    expect(await own.late({})).toBe('/inbox/own.oga')
  })
})

// ── f6 — a late try runs whisper with the exact original arguments (owner: owner-log extract; other: --no-save) ─────
describe('r1 f6 — the late transcribe arguments, executed', () => {
  async function lateArgs(ownerSent: boolean, author: VoiceAuthorResult) {
    const seen: { audioPath: string; args: string[] }[] = []
    const transcribe = voiceTranscribeEffect({
      ownerSent, msgId: 49640, chatId: '22276',
      queue: job => serialize(`whisper-r1f6-${Math.random()}`, job),
      run: async (audioPath, args) => (seen.push({ audioPath, args }), 'слова'),
    })
    const h = harness({ downloads: [async () => { throw err504() }, async () => '/late/49640.oga'], author })
    h.voice.transcribe = transcribe
    h.fetcher.schedule(h.voice)
    await h.clock.advanceTo(h.t0 + 10 * MIN)
    expect(h.late.length).toBe(1)
    return seen
  }

  test('the person\'s own voice: --msg-id/--chat-id/--source telegram of the ORIGINAL message, on the late file', async () => {
    expect(await lateArgs(true, owner)).toEqual([
      { audioPath: '/late/49640.oga', args: ['--msg-id', '49640', '--chat-id', '22276', '--source', 'telegram', '--no-recall'] },
    ])
  })

  test('another author\'s voice: --no-save, no --msg-id (no owner extract, no owner save)', async () => {
    const alice: VoiceAuthorResult = { voice_author: 'alice_h', voice_author_id: '555', voice_author_origin: 'sender', voice_trust: 'data' }
    expect(await lateArgs(false, alice)).toEqual([{ audioPath: '/late/49640.oga', args: ['--no-save', '--no-recall'] }])
  })
})
