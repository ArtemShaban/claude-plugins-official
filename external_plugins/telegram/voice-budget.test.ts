// D-1066 criterion 4 (spec sam-data dev/analysis/2026-11-16-tg-file-download-fix-spec.md §2 B): the voice waits for
// its file on its own clock, so a late file no longer spends whisper's share. D-1087 criterion 1 (owner tg 49565
// «подними даймаут с 90 до 120 с»): DOWNLOAD_TIMEOUT_MS = 120 s.
// The same composition server.ts uses: withTimeout(deliverVoiceTranscript(...), voiceEnvelopeMs(whisperTimeoutMs(dur))).
// Fake timers, no network, no files.
import { afterEach, describe, expect, jest, test } from 'bun:test'
import {
  deliverVoiceTranscript,
  DOWNLOAD_TIMEOUT_MS,
  PHOTO_DOWNLOAD_TIMEOUT_MS,
  voiceEnvelopeMs,
  voiceOutcomeOf,
  voicePlaceholder,
  whisperTimeoutMs,
  withTimeout,
  type VoiceAuthorResult,
  type VoiceJournal,
} from './voice-delivery'

const author: VoiceAuthorResult = { voice_author: 'artem', voice_author_id: '111', voice_author_origin: 'sender', voice_trust: 'owner' }

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Runs one voice of `durS` seconds whose file lands at `fileAtMs` (never if undefined) and whose whisper takes `whisperMs`. */
async function voice(durS: number, fileAtMs: number | undefined, whisperMs: number) {
  jest.useFakeTimers()
  let elapsed = 0
  let settledAt: number | undefined
  let timedOut = false
  const journal: VoiceJournal = {}
  const run = withTimeout(
    deliverVoiceTranscript(true, undefined, author, {
      download: () => new Promise(r => (fileAtMs == null ? undefined : setTimeout(() => r('/x/voice.oga'), fileAtMs))),
      transcribe: () => new Promise(r => setTimeout(() => r('привет'), whisperMs)),
      logNotice: () => {},
      journal,
      nowMs: () => elapsed,
    }),
    voiceEnvelopeMs(whisperTimeoutMs(durS)),
    () => (timedOut = true),
  ).catch(() => voicePlaceholder(undefined, author))
  void run.then(() => (settledAt = elapsed))
  while (settledAt == null && elapsed < 400_000) {
    jest.advanceTimersByTime(500)
    elapsed += 500
    await flush()
  }
  const env = await run
  const outcome = voiceOutcomeOf({ cmdConfigured: true, journal, deliveredBridge: env.meta.transcript_source === 'bridge', timedOut })
  return { env, outcome, settledAt: settledAt!, journal }
}

afterEach(() => jest.useRealTimers())

describe('voice download on its own 120 s clock (D-1087)', () => {
  test('constants: voice waits 120 s for its file, photo keeps 30 s, envelope = whisper + 120 s', () => {
    expect(DOWNLOAD_TIMEOUT_MS).toBe(120_000)
    expect(PHOTO_DOWNLOAD_TIMEOUT_MS).toBe(30_000)
    expect(voiceEnvelopeMs(60_000)).toBe(180_000)
    expect(voiceEnvelopeMs(whisperTimeoutMs(16))).toBe(180_000)
  })

  test('file lands at 115 s, whisper 4 s → bridge (at 90 s it was a placeholder)', async () => {
    const r = await voice(16, 115_000, 4_000)
    expect(r.outcome).toBe('bridge')
    expect(r.journal.dl).toBe('ok')
  })

  test('file lands at 85 s, whisper takes 4 s → bridge', async () => {
    const r = await voice(16, 85_000, 4_000)
    expect(r.outcome).toBe('bridge')
    expect(r.env.meta.transcript_source).toBe('bridge')
  })

  test('the 47819 / 48003 shape: file at 88.5 s, whisper 4 s → bridge (today: placeholder:timeout at 90 s)', async () => {
    const r = await voice(16, 88_500, 4_000)
    expect(r.outcome).toBe('bridge')
    expect(r.journal.dl).toBe('ok')
    expect(r.settledAt).toBeGreaterThanOrEqual(92_000)
    expect(r.settledAt).toBeLessThan(94_000)
  })

  test('file never lands → placeholder:download at 120 s ± 1 s (not timeout), author keys on it', async () => {
    const r = await voice(16, undefined, 4_000)
    expect(r.outcome).toBe('placeholder:download')
    expect(r.journal.dl).toBe('timeout')
    expect(r.settledAt).toBeGreaterThanOrEqual(119_000) // 500 ms step granularity
    expect(r.settledAt).toBeLessThanOrEqual(121_000)
    expect(r.env).toEqual({
      text: '(voice message)',
      meta: { voice_author: 'artem', voice_author_id: '111', voice_author_origin: 'sender', voice_trust: 'owner' },
    })
  })
})
