// The plugin never guesses which transcribe / TTS program to run (owner tg
// 21986 -> promise tg 21987). The ONLY source is SAM_TRANSCRIBE_CMD /
// SAM_TTS_CMD from the environment. These tests plant REAL executable scripts
// at every location the old fallback used to derive (<repo>/tools/
// transcribe.sh and <repo>/tools/tts.sh next to IDEA_INBOX_DIR =
// <repo>/tasks/idea-inbox). Each planted script writes a marker file when run.
// The effects below actually execute whatever command the resolver returned,
// so "no guessed command is ever executed" is proven by the marker never
// appearing, not just by a return value.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sendVoiceReply, transcribeCmd, transcribeVoiceIdea, ttsCmd } from './idea-inbox'
import { deliverVoiceTranscript, type VoiceAuthorResult } from './voice-delivery'

const author: VoiceAuthorResult = {
  voice_author: 'Owner',
  voice_author_id: '424242424',
  voice_author_origin: 'sender',
  voice_trust: 'owner',
}

// Same shape server.ts uses: sh -c '<cmd> "$@"' sh <args...>
function runCmd(cmd: string, args: string[]): string {
  const r = spawnSync('sh', ['-c', `${cmd} "$@"`, 'sh', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`cmd exited ${r.status}: ${r.stderr}`)
  return r.stdout
}

function plant(path: string, marker: string, stdout: string): void {
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nprintf '%s' '${stdout}'\n`)
  chmodSync(path, 0o755)
}

let repo: string
let inbox: string
let guessedMarkers: string[]
let env: NodeJS.ProcessEnv

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tg-noguess-'))
  inbox = join(repo, 'tasks', 'idea-inbox')
  mkdirSync(inbox, { recursive: true })
  mkdirSync(join(repo, 'tools'))
  guessedMarkers = [join(repo, 'guessed-transcribe.ran'), join(repo, 'guessed-tts.ran')]
  plant(join(repo, 'tools', 'transcribe.sh'), guessedMarkers[0], 'guessed transcript')
  plant(join(repo, 'tools', 'tts.sh'), guessedMarkers[1], '')
  // The only voice-related variable set is the idea-inbox directory.
  env = { IDEA_INBOX_DIR: inbox } as NodeJS.ProcessEnv
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('env unset => no guessed command is ever executed', () => {
  test('resolvers return undefined even with IDEA_INBOX_DIR set and scripts present', () => {
    expect(transcribeCmd(env)).toBeUndefined()
    expect(ttsCmd(env)).toBeUndefined()
  })

  test('work-route voice: placeholder, spy never runs, log names SAM_TRANSCRIBE_CMD', async () => {
    const cmd = transcribeCmd(env)
    const ran: string[] = []
    const notices: string[] = []
    const r = await deliverVoiceTranscript(cmd != null, undefined, author, {
      download: async () => join(repo, 'voice.oga'),
      transcribe: async p => { ran.push(p); return runCmd(cmd!, [p, 'ru']) },
      logNotice: n => notices.push(n),
    })
    expect(r).toEqual({ text: '(voice message)', meta: {} })
    expect(ran).toEqual([])
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('SAM_TRANSCRIBE_CMD')
    for (const m of guessedMarkers) expect(existsSync(m)).toBe(false)
  })

  test('idea-topic voice: skipped, spy never runs, log names SAM_TRANSCRIBE_CMD', async () => {
    const cmd = transcribeCmd(env)
    const ran: string[] = []
    const notices: string[] = []
    const outcome = await transcribeVoiceIdea(cmd != null, {
      download: async () => join(repo, 'voice.oga'),
      transcribe: async p => { ran.push(p); return runCmd(cmd!, [p, 'ru']) },
      onSuccess: () => true,
      replyTranscript: () => {},
      replyFailure: () => {},
      logError: () => {},
      logNotice: n => notices.push(n),
    })
    expect(outcome).toBe('skipped')
    expect(ran).toEqual([])
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain('SAM_TRANSCRIBE_CMD')
    for (const m of guessedMarkers) expect(existsSync(m)).toBe(false)
  })

  test('voice reply: skipped, spy never runs, log names SAM_TTS_CMD', async () => {
    const cmd = ttsCmd(env)
    const ran: string[] = []
    const errors: string[] = []
    const out = await sendVoiceReply(cmd != null, join(repo, 'out.ogg'), {
      synthesize: async o => { ran.push(o); runCmd(cmd!, ['hi', o, 'ru']) },
      sendVoice: async () => {},
      cleanup: () => {},
      logError: e => errors.push(e),
    })
    expect(out).toBe('skipped')
    expect(ran).toEqual([])
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('SAM_TTS_CMD')
    for (const m of guessedMarkers) expect(existsSync(m)).toBe(false)
  })
})

describe('env set => exactly that command is used', () => {
  test('SAM_TRANSCRIBE_CMD: the configured script runs, the planted one does not', async () => {
    const chosenMarker = join(repo, 'chosen-transcribe.ran')
    const chosen = join(repo, 'chosen-transcribe.sh')
    plant(chosen, chosenMarker, 'chosen transcript')
    env.SAM_TRANSCRIBE_CMD = chosen
    const cmd = transcribeCmd(env)
    expect(cmd).toBe(chosen)
    const seen: string[] = []
    const r = await deliverVoiceTranscript(cmd != null, undefined, author, {
      download: async () => join(repo, 'voice.oga'),
      transcribe: async p => { seen.push(cmd!); return runCmd(cmd!, [p, 'ru']) },
      logNotice: () => {},
    })
    expect(seen).toEqual([chosen])
    expect(r.text).toBe('chosen transcript')
    expect(r.meta.transcript_source).toBe('bridge')
    expect(existsSync(chosenMarker)).toBe(true)
    for (const m of guessedMarkers) expect(existsSync(m)).toBe(false)
  })

  test('SAM_TTS_CMD: the configured script runs, the planted one does not', async () => {
    const chosenMarker = join(repo, 'chosen-tts.ran')
    const chosen = join(repo, 'chosen-tts.sh')
    plant(chosen, chosenMarker, '')
    env.SAM_TTS_CMD = chosen
    const cmd = ttsCmd(env)
    expect(cmd).toBe(chosen)
    const seen: string[] = []
    const out = await sendVoiceReply(cmd != null, join(repo, 'out.ogg'), {
      synthesize: async o => { seen.push(cmd!); runCmd(cmd!, ['hi', o, 'ru']) },
      sendVoice: async () => {},
      cleanup: () => {},
      logError: () => {},
    })
    expect(out).toBe('sent')
    expect(seen).toEqual([chosen])
    expect(existsSync(chosenMarker)).toBe(true)
    for (const m of guessedMarkers) expect(existsSync(m)).toBe(false)
  })
})
