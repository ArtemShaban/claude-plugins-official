// Per-voice journal (owner tg 44440 → 44442 → «да» 44445): one STATE_DIR/voice.log line per voice —
// download ms + result, transcription ms + result, the outcome; never the transcript or an error text.
// Pure / effect-injected: no subprocess, no network, temp dirs only, no import of server.ts.
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createVoiceLog,
  deliverVoiceTranscript,
  formatVoiceLine,
  voiceErrorClass,
  voiceOutcomeOf,
  withTimeout,
  VOICE_LOG,
  type VoiceAuthorResult,
  type VoiceJournal,
} from './voice-delivery'

const author: VoiceAuthorResult = {
  voice_author: 'artem',
  voice_author_id: '111',
  voice_author_origin: 'sender',
  voice_trust: 'owner',
}
const TS = Date.UTC(2026, 10, 9, 1, 17, 47, 123) // 09.11 09:17:47.123 WITA

/** A clock that advances by the given steps on each call (download start/end, transcribe start/end). */
const clock = (...steps: number[]) => {
  let t = 1_000
  let i = 0
  return () => (t += i === 0 ? (i++, 0) : steps[(i++ - 1) % steps.length])
}

async function run(fx: {
  download: () => Promise<string | undefined>
  transcribe?: (p: string) => Promise<string>
  cmd?: boolean
}) {
  const journal: VoiceJournal = {}
  const env = await deliverVoiceTranscript(fx.cmd ?? true, undefined, author, {
    download: fx.download,
    transcribe: fx.transcribe ?? (async () => 'привет как дела'),
    logNotice: () => {},
    journal,
    nowMs: clock(400, 50, 2_800),
  })
  const outcome = voiceOutcomeOf({
    cmdConfigured: fx.cmd ?? true,
    journal,
    deliveredBridge: env.meta.transcript_source === 'bridge',
    timedOut: false,
  })
  const line = formatVoiceLine(TS, 735, {
    chat: '22276', msg: 44440, size: 12_345, durS: 7, journal, outcome, totalMs: 3_300,
  })
  return { env, journal, outcome, line }
}

describe('voice journal — one line per voice, per leg', () => {
  test('ok: both legs timed, transcript length only, outcome bridge (exact line)', async () => {
    const r = await run({ download: async () => '/inbox/attachments/1-x.oga' })
    expect(r.outcome).toBe('bridge')
    expect(r.line).toBe(
      '2026-11-09T01:17:47.123Z pid=735 chat=22276 msg=44440 size=12345 dur_s=7' +
        ' dl=ok dl_ms=400 tr=ok tr_ms=2800 tr_len=15 outcome=bridge total_ms=3300 dl_att=- dl_win=- gf_ms=- fx_ms=- dl_phase=- probe_ms=- late_tries=-\n',
    )
    expect(r.line).not.toContain('привет')
    expect(r.line).not.toContain('/inbox')
  })

  test('download gave no file (over cap / no file_path) → dl=none, transcribe not reached', async () => {
    const r = await run({ download: async () => undefined })
    expect(r.journal).toEqual({ dl: 'none', dl_ms: 400 })
    expect(r.outcome).toBe('placeholder:download')
    expect(r.line).toContain(' dl=none dl_ms=400 tr=- tr_ms=- tr_len=- outcome=placeholder:download ')
  })

  test('Bot API outage replay (09.11 09:11–09:13): getFile network error → dl=network, no error text', async () => {
    const err = Object.assign(new Error("Network request for 'getFile' failed! bot123:SECRET"), { name: 'HttpError' })
    const r = await run({ download: async () => { throw err } })
    expect(r.journal.dl).toBe('network')
    expect(r.outcome).toBe('placeholder:download')
    expect(r.env).toEqual({ text: '(voice message)', meta: { voice_author: 'artem', voice_author_id: '111', voice_author_origin: 'sender', voice_trust: 'owner' } })
    expect(r.line).not.toContain('SECRET')
    expect(r.line).not.toContain('getFile')
  })

  test('getFile 502 (GrammyError error_code) → http_502; fetch «HTTP 404» → http_404', async () => {
    const g = Object.assign(new Error('Call to getFile failed! (502: Bad Gateway)'), { name: 'GrammyError', error_code: 502 })
    expect((await run({ download: async () => { throw g } })).journal.dl).toBe('http_502')
    const f = new Error('file download failed: HTTP 404')
    expect((await run({ download: async () => { throw f } })).journal.dl).toBe('http_404')
  })

  test('transcribe exits non-zero → tr=exit_3, the stderr words never reach the line', async () => {
    const r = await run({
      download: async () => '/a.oga',
      transcribe: async () => { throw new Error('transcribe cmd exited 3: whisper said секретные слова') },
    })
    expect(r.journal).toEqual({ dl: 'ok', dl_ms: 400, tr: 'exit_3', tr_ms: 2_800 })
    expect(r.outcome).toBe('placeholder:transcribe')
    expect(r.line).not.toContain('секрет')
  })

  test('transcribe timeout (withTimeout) → tr=timeout', async () => {
    const r = await run({
      download: async () => '/a.oga',
      transcribe: () => withTimeout(new Promise<string>(() => {}), 5, () => {}),
    })
    expect(r.journal.tr).toBe('timeout')
  })

  test('empty transcript → tr=empty tr_len=0, outcome placeholder:empty', async () => {
    const r = await run({ download: async () => '/a.oga', transcribe: async () => '  \n ' })
    expect(r.journal).toEqual({ dl: 'ok', dl_ms: 400, tr: 'empty', tr_ms: 2_800, tr_len: 0 })
    expect(r.outcome).toBe('placeholder:empty')
  })

  test('no transcribe command → placeholder:no_cmd, no leg run', async () => {
    const r = await run({ cmd: false, download: async () => '/a.oga' })
    expect(r.journal).toEqual({})
    expect(r.outcome).toBe('placeholder:no_cmd')
  })

  test('the outer envelope timeout wins over a leg that finished late', () => {
    const j: VoiceJournal = { dl: 'ok', dl_ms: 30_000 }
    expect(voiceOutcomeOf({ cmdConfigured: true, journal: j, deliveredBridge: false, timedOut: true })).toBe('placeholder:timeout')
  })

  test('delivery is byte-identical with and without the journal', async () => {
    for (const transcribe of [async () => 'текст', async () => '', async () => { throw new Error('x') }]) {
      const fx = { download: async () => '/a.oga', transcribe, logNotice: () => {} }
      const without = await deliverVoiceTranscript(true, 'cap', author, fx)
      const withJ = await deliverVoiceTranscript(true, 'cap', author, { ...fx, journal: {} })
      expect(withJ).toEqual(without)
    }
  })
})

describe('voiceErrorClass — closed set', () => {
  test('system code, unknown', () => {
    expect(voiceErrorClass(Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' }))).toBe('sys_ENOENT')
    expect(voiceErrorClass(new Error('something odd'))).toBe('error')
    expect(voiceErrorClass(undefined)).toBe('error')
    expect(voiceErrorClass(new TypeError('fetch failed'))).toBe('network')
  })
  test('formatVoiceLine never writes an unknown chat or result shape', () => {
    const line = formatVoiceLine(TS, 1, {
      chat: '22 276; rm', msg: undefined, journal: { dl: 'weird value' as never }, outcome: 'bridge', totalMs: -1,
    })
    expect(line).toContain(' chat=- msg=- size=- dur_s=- dl=error ')
    expect(line).toContain(' total_ms=- dl_att=- dl_win=- gf_ms=- fx_ms=- dl_phase=- probe_ms=- late_tries=-\n')
  })
})

describe('createVoiceLog — STATE_DIR/voice.log, 0600, append, fail-open', () => {
  const dirs: string[] = []
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  const fields = { chat: '1', msg: 2, journal: { dl: 'ok' as const }, outcome: 'bridge' as const, totalMs: 5 }

  test('appends one line per call, mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voicelog-'))
    dirs.push(dir)
    const write = createVoiceLog({ stateDir: dir, pid: 7, nowMs: () => TS })
    write(fields)
    write(fields)
    const file = join(dir, VOICE_LOG)
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    expect(lines[0]).toBe('2026-11-09T01:17:47.123Z pid=7 chat=1 msg=2 size=- dur_s=- dl=ok dl_ms=- tr=- tr_ms=- tr_len=- outcome=bridge total_ms=5 dl_att=- dl_win=- gf_ms=- fx_ms=- dl_phase=- probe_ms=- late_tries=-')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('a write failure never throws: one stderr line per failure streak', () => {
    const dir = join(tmpdir(), `voicelog-missing-${process.pid}-${Date.now()}`)
    const logs: string[] = []
    const write = createVoiceLog({ stateDir: dir, log: l => logs.push(l) })
    expect(() => { write(fields); write(fields) }).not.toThrow()
    expect(existsSync(dir)).toBe(false)
    expect(logs).toEqual(['telegram channel: voice.log write failed (ENOENT), delivery continues\n'])
  })

  test('a throwing stderr logger is swallowed too', () => {
    const write = createVoiceLog({ stateDir: join(tmpdir(), `nope-${Date.now()}`), log: () => { throw new Error('EPIPE') } })
    expect(() => write(fields)).not.toThrow()
  })
})

// ── D-1066 download keys (criterion 6, OB-05 «в журнал — на каком шаге зависло; следующий сбой сам покажет, чья
// сторона», tg 48590): dl_att dl_win gf_ms fx_ms dl_phase probe_ms, closed sets, `-` when absent. ─────────────
describe('voice journal — download keys (D-1066)', () => {
  const base = { chat: '22276', msg: 48549, size: 67_482, durS: 16, outcome: 'bridge' as const, totalMs: 9_000 }
  const keys = (line: string) => line.trim().split(' ').slice(-7, -1).join(' ')

  test('a slow download past the 8 s probe mark: one attempt, split times, phase, probe (D-1087: dl_att always 1)', () => {
    const line = formatVoiceLine(TS, 1, {
      ...base,
      journal: { dl: 'ok', dl_ms: 8_600, net: { dl_att: 1, dl_win: 1, gf_ms: 8_180, fx_ms: 320, dl_phase: 'done', probe_ms: 45 } },
    })
    expect(keys(line)).toBe('dl_att=1 dl_win=1 gf_ms=8180 fx_ms=320 dl_phase=done probe_ms=45')
  })

  test('a stall: no winner, phase where it hung, probe timeout', () => {
    const line = formatVoiceLine(TS, 1, {
      ...base,
      outcome: 'placeholder:download',
      journal: { dl: 'timeout', dl_ms: 120_000, net: { dl_att: 1, dl_phase: 'getfile', probe_ms: 'timeout' } },
    })
    expect(keys(line)).toBe('dl_att=1 dl_win=- gf_ms=- fx_ms=- dl_phase=getfile probe_ms=timeout')
  })

  test('a 2 from an old journal shape is not a valid attempt count any more → `-`', () => {
    const line = formatVoiceLine(TS, 1, { ...base, journal: { dl: 'ok', net: { dl_att: 2, dl_win: 2, dl_phase: 'done' } } })
    expect(keys(line)).toBe('dl_att=- dl_win=- gf_ms=- fx_ms=- dl_phase=done probe_ms=-')
  })

  test('happy path without a hedge: probe_ms=-', () => {
    const line = formatVoiceLine(TS, 1, { ...base, journal: { dl: 'ok', net: { dl_att: 1, dl_win: 1, gf_ms: 90, fx_ms: 110, dl_phase: 'done' } } })
    expect(keys(line)).toBe('dl_att=1 dl_win=1 gf_ms=90 fx_ms=110 dl_phase=done probe_ms=-')
  })

  test('closed sets: anything else is `-`, a token-like string never reaches the line', () => {
    const evil = 'bot123456789:AAH-SECRET'
    const line = formatVoiceLine(TS, 1, {
      ...base,
      journal: { dl: 'ok', net: { dl_att: 3, dl_win: evil as unknown as number, gf_ms: -5, fx_ms: Number.NaN, dl_phase: evil as never, probe_ms: evil as never } },
    })
    expect(keys(line)).toBe('dl_att=- dl_win=- gf_ms=- fx_ms=- dl_phase=- probe_ms=-')
    expect(line).not.toContain('SECRET')
  })
})

// ── end-to-end: a fake Bot API whose getFile answers late (after the 8 s probe mark, scaled to 150 ms) still yields
// outcome=bridge on ONE attempt (D-1087: no second getFile); real helper, real deliverVoiceTranscript, real voice.log
// writer; temp dirs, 127.0.0.1, fake token ─────
describe('end-to-end: slow getFile → probe → bridge on one attempt, one voice.log line with the keys', () => {
  test('outcome=bridge, dl_att=1 dl_win=1, one getFile, token never in the line', async () => {
    const { createServer } = await import('node:http')
    const { createTelegramDownloader } = await import('./tg-download')
    const token = '123456789:AAH-SECRET-e2e'
    let getFiles = 0
    const server = createServer((req, res) => {
      if ((req.url ?? '').includes('/getFile')) {
        getFiles++
        res.setHeader('content-type', 'application/json')
        // answers after the scaled probe mark
        return void setTimeout(() => res.end(JSON.stringify({ ok: true, result: { file_unique_id: 'AgADv', file_size: 4, file_path: 'voice/file_1.oga' } })), 400)
      }
      res.end(Buffer.from([1, 2, 3, 4]))
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    const dir = mkdtempSync(join(tmpdir(), 'voice-e2e-'))
    try {
      const { downloadTelegramFile } = createTelegramDownloader({ token, origin: `http://127.0.0.1:${port}`, probeAfterMs: 150, probe: async () => 30 })
      const journal: VoiceJournal = {}
      const env = await deliverVoiceTranscript(true, undefined, author, {
        journal,
        download: async () => {
          const got = await downloadTelegramFile('FILE', { onStart: n => (journal.net = n) })
          return got.status === 'ok' ? join(dir, 'v.oga') : undefined
        },
        transcribe: async () => 'привет',
        logNotice: () => {},
      })
      const outcome = voiceOutcomeOf({ cmdConfigured: true, journal, deliveredBridge: env.meta.transcript_source === 'bridge', timedOut: false })
      createVoiceLog({ stateDir: dir, pid: 9, nowMs: () => TS })({ chat: '22276', msg: 1, journal: { ...journal }, outcome, totalMs: 200 })
      const line = readFileSync(join(dir, VOICE_LOG), 'utf8')
      expect(outcome).toBe('bridge')
      expect(line).toContain(' outcome=bridge ')
      expect(line).toMatch(/ dl_att=1 dl_win=1 gf_ms=\d+ fx_ms=\d+ dl_phase=done probe_ms=30 late_tries=-\n$/)
      expect(getFiles).toBe(1)
      expect(line).not.toContain('SECRET')
    } finally {
      server.closeAllConnections()
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
