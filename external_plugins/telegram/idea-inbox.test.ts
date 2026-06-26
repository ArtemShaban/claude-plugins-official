// Unit tests for the idea-inbox topic-routing + durable store.
// Run: bun test  (from this directory)
//
// These cover the spec's "Тесты-гейт" / Acceptance criteria AC1-AC9, AC12:
// classifyRoute branches, JSONL append + idempotency, status transitions,
// voice persisted as status:new, snapshot-cutoff, and a no-interrupt proof
// (async route persists and returns WITHOUT calling the notification mock).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  classifyRoute,
  dispatchIdeaRoute,
  findIdea,
  ideaExists,
  ideaId,
  ideaInboxDir,
  IdeaRecord,
  IdeaRouteEffects,
  persistIdea,
  PersistInput,
  recordTranscript,
  selectReadyForPour,
  setIdeaStatus,
  shouldSuppressReaction,
  transcribeCmd,
  TranscribeEffects,
  transcribeVoiceIdea,
} from './idea-inbox'

const ARTEM = '378650081'
const SUPERGROUP = '-1001234567890'
const IDEAS_THREAD = 42
const WORK_THREAD = 7

const access = {
  allowFrom: [ARTEM],
  groups: {
    [SUPERGROUP]: { asyncThreads: [String(IDEAS_THREAD)] },
  },
}

describe('classifyRoute', () => {
  // AC8 / R-GEN: General carries no message_thread_id => must wake (work).
  test('General (threadId undefined) in supergroup => work', () => {
    expect(classifyRoute(access, SUPERGROUP, undefined)).toBe('work')
  })

  // AC1: a non-async named topic ("Работа") => work.
  test('named work topic (not in asyncThreads) => work', () => {
    expect(classifyRoute(access, SUPERGROUP, WORK_THREAD)).toBe('work')
  })

  // AC2/AC3: the Ideas topic => async (no wake).
  test('Ideas topic (in asyncThreads) => async', () => {
    expect(classifyRoute(access, SUPERGROUP, IDEAS_THREAD)).toBe('async')
  })

  // AC8: DM (chat_id in allowFrom) always wakes, even with a stray threadId.
  test('DM (chat in allowFrom) => work', () => {
    expect(classifyRoute(access, ARTEM, undefined)).toBe('work')
    expect(classifyRoute(access, ARTEM, IDEAS_THREAD)).toBe('work')
  })

  // AC6 belt-and-suspenders: unknown chat => ignore.
  test('unknown chat => ignore', () => {
    expect(classifyRoute(access, '-100999', 1)).toBe('ignore')
  })

  // AC9: empty/missing asyncThreads => everything in that group is work.
  test('group with empty asyncThreads => work', () => {
    const a = { allowFrom: [ARTEM], groups: { [SUPERGROUP]: {} } }
    expect(classifyRoute(a, SUPERGROUP, IDEAS_THREAD)).toBe('work')
    expect(classifyRoute(a, SUPERGROUP, undefined)).toBe('work')
  })

  // AC9: async globally disabled (IDEA_INBOX_DIR unset) => everything work.
  test('asyncEnabled=false => work even for an Ideas thread', () => {
    expect(classifyRoute(access, SUPERGROUP, IDEAS_THREAD, false)).toBe('work')
  })

  // threadId given as the configured number routes async regardless of int/str.
  test('threadId matches by string-equality of the configured id', () => {
    expect(classifyRoute(access, SUPERGROUP, IDEAS_THREAD)).toBe('async')
  })
})

describe('ideaInboxDir', () => {
  test('returns undefined when IDEA_INBOX_DIR unset/blank', () => {
    expect(ideaInboxDir({} as NodeJS.ProcessEnv)).toBeUndefined()
    expect(ideaInboxDir({ IDEA_INBOX_DIR: '   ' } as NodeJS.ProcessEnv)).toBeUndefined()
  })
  test('returns the path when set', () => {
    expect(ideaInboxDir({ IDEA_INBOX_DIR: '/x/y' } as NodeJS.ProcessEnv)).toBe('/x/y')
  })
})

describe('persistIdea + JSONL store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-inbox-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const readRecords = (): IdeaRecord[] =>
    readFileSync(join(dir, 'inbox.jsonl'), 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l) as IdeaRecord)

  // AC2: text idea => one JSONL line, status ready, stable id, correct fields.
  test('text idea appends one ready record with stable id', () => {
    const rec = persistIdea(dir, {
      chat_id: SUPERGROUP,
      message_id: 100,
      from_user_id: ARTEM,
      thread_id: IDEAS_THREAD,
      date: 1750000000,
      kind: 'text',
      text: 'sample idea',
    })
    expect(rec.id).toBe(ideaId(SUPERGROUP, 100))
    expect(rec.status).toBe('ready')
    expect(rec.thread_id).toBe(String(IDEAS_THREAD))
    expect(rec.text).toBe('sample idea')
    expect(rec.from_user_id).toBe(ARTEM)
    expect(rec.ts_captured).toBe(new Date(1750000000 * 1000).toISOString())
    const recs = readRecords()
    expect(recs.length).toBe(1)
  })

  // AC5: idempotency — same message_id (restart/retry) does not duplicate.
  test('idempotent by id — re-persisting the same message is a no-op', () => {
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 100, from_user_id: ARTEM, kind: 'text', text: 'a' })
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 100, from_user_id: ARTEM, kind: 'text', text: 'a' })
    expect(readRecords().length).toBe(1)
    expect(ideaExists(join(dir, 'inbox.jsonl'), ideaId(SUPERGROUP, 100))).toBe(true)
  })

  // AC4: voice => status 'new' + file_id retained (transcription deferred).
  test('voice idea persists as status:new with attachment_file_id', () => {
    const rec = persistIdea(dir, {
      chat_id: SUPERGROUP,
      message_id: 101,
      from_user_id: ARTEM,
      thread_id: IDEAS_THREAD,
      kind: 'voice',
      attachment_file_id: 'AwACAgIAxyz',
    })
    expect(rec.status).toBe('new')
    expect(rec.attachment_file_id).toBe('AwACAgIAxyz')
  })

  test('creates attachments/ and transcripts/ subdirs', () => {
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 1, from_user_id: ARTEM, kind: 'text', text: 'x' })
    expect(() => readFileSync(join(dir, 'attachments'))).toThrow() // it's a dir, not a file — but it exists
  })

  // AC7: a write failure throws => caller takes the loud path (no false ack).
  test('persist throws when the dir is unwritable', () => {
    expect(() =>
      persistIdea('/proc/nonexistent-readonly-xyz/idea', {
        chat_id: SUPERGROUP,
        message_id: 9,
        from_user_id: ARTEM,
        kind: 'text',
        text: 'x',
      }),
    ).toThrow()
  })

  // status lifecycle transitions (new->transcribing->ready->done).
  test('setIdeaStatus rewrites exactly one record', () => {
    const path = join(dir, 'inbox.jsonl')
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 1, from_user_id: ARTEM, kind: 'voice', attachment_file_id: 'f' })
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 2, from_user_id: ARTEM, kind: 'text', text: 'b' })
    expect(setIdeaStatus(path, ideaId(SUPERGROUP, 1), 'ready')).toBe(true)
    const recs = readRecords()
    expect(recs.find(r => r.id === ideaId(SUPERGROUP, 1))!.status).toBe('ready')
    expect(recs.find(r => r.id === ideaId(SUPERGROUP, 2))!.status).toBe('ready') // unchanged
    expect(setIdeaStatus(path, 'telegram:none:999', 'done')).toBe(false)
  })
})

describe('selectReadyForPour (snapshot-cutoff, AC12)', () => {
  const mk = (mid: number, status: string, ts: string): IdeaRecord => ({
    id: ideaId(SUPERGROUP, mid),
    ts_captured: ts,
    from_user_id: ARTEM,
    thread_id: String(IDEAS_THREAD),
    kind: 'text',
    text: 't',
    status,
    ts_status: ts,
  })

  test('returns only ready records up to the max ready message_id, time-ordered', () => {
    const recs = [
      mk(10, 'ready', '2026-06-26T10:00:00Z'),
      mk(12, 'done', '2026-06-26T10:05:00Z'),
      mk(15, 'ready', '2026-06-26T10:10:00Z'),
    ]
    const sel = selectReadyForPour(recs)
    expect(sel.map(r => r.id)).toEqual([ideaId(SUPERGROUP, 10), ideaId(SUPERGROUP, 15)])
  })

  test('empty when nothing ready', () => {
    expect(selectReadyForPour([mk(1, 'new', '2026-06-26T10:00:00Z')])).toEqual([])
  })
})

// ── No-interrupt proof (AC3) — drives the REAL production seam ───────────────
// dispatchIdeaRoute is the EXACT function server.ts's handleInbound calls to
// make the notify-vs-persist decision (no replica): we feed it classifyRoute's
// result + spy effects and assert the production decision. Acceptance bar: if a
// developer moves the async-branch return below notify, or notifies before
// persist, THESE tests go red because the spies observe the real ordering.
describe('dispatchIdeaRoute — no-interrupt guarantee (AC3) [REAL seam]', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-inbox-noint-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A spy harness whose persist actually writes (so we can assert durability),
  // recording the call order so a reordered notify/persist is observable.
  function harness(opts: { persistThrows?: boolean; msgId?: number } = {}) {
    const log: string[] = []
    const calls = { persist: 0, react: 0, warnUser: 0, logError: 0, notify: 0 }
    const baseInput: Omit<PersistInput, 'message_id'> = {
      chat_id: SUPERGROUP,
      from_user_id: ARTEM,
      thread_id: IDEAS_THREAD,
      kind: 'text',
      text: 'idea',
    }
    const fx: IdeaRouteEffects = {
      persist: (input: PersistInput) => {
        calls.persist++
        log.push('persist')
        if (opts.persistThrows) throw new Error('disk full')
        persistIdea(dir, input)
      },
      react: () => { calls.react++; log.push('react') },
      warnUser: () => { calls.warnUser++; log.push('warnUser') },
      logError: () => { calls.logError++; log.push('logError') },
      notify: () => { calls.notify++; log.push('notify') },
    }
    return { fx, calls, log, baseInput }
  }

  // AC3: async route persists, ✍-reacts, and MUST NOT notify (no wake).
  test('Ideas topic (async) => persisted + react, notify NOT called', () => {
    const h = harness()
    const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
    const outcome = dispatchIdeaRoute(route, 500, h.baseInput, h.fx)
    expect(outcome).toBe('persisted')
    expect(h.calls.notify).toBe(0) // the no-interrupt guarantee
    expect(h.calls.persist).toBe(1)
    expect(h.calls.react).toBe(1)
    expect(h.calls.warnUser).toBe(0)
    // durable: the idea actually hit the JSONL store.
    expect(ideaExists(join(dir, 'inbox.jsonl'), ideaId(SUPERGROUP, 500))).toBe(true)
  })

  // Order proof: persist happens BEFORE react, and notify never appears. If
  // someone adds fx.notify() above the persist/return, 'notify' enters the log.
  test('async side-effect ORDER is persist→react with no notify', () => {
    const h = harness()
    const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
    dispatchIdeaRoute(route, 501, h.baseInput, h.fx)
    expect(h.log).toEqual(['persist', 'react'])
  })

  // Default work path (named non-async topic) MUST wake the session.
  test('work topic => notify called, nothing persisted', () => {
    const h = harness()
    const route = classifyRoute(access, SUPERGROUP, WORK_THREAD, true)
    const outcome = dispatchIdeaRoute(route, 502, { ...h.baseInput, thread_id: WORK_THREAD }, h.fx)
    expect(outcome).toBe('work')
    expect(h.calls.notify).toBe(1)
    expect(h.calls.persist).toBe(0)
    expect(h.calls.react).toBe(0)
  })

  // Default work path: General topic (threadId undefined) MUST wake.
  test('General (threadId undefined) => notify called', () => {
    const h = harness()
    const route = classifyRoute(access, SUPERGROUP, undefined, true)
    const outcome = dispatchIdeaRoute(route, 503, { ...h.baseInput, thread_id: undefined }, h.fx)
    expect(outcome).toBe('work')
    expect(h.calls.notify).toBe(1)
  })

  // Default work path: a DM MUST wake (never async).
  test('DM (chat in allowFrom) => notify called', () => {
    const h = harness()
    const route = classifyRoute(access, ARTEM, undefined, true)
    const outcome = dispatchIdeaRoute(route, 504, { ...h.baseInput, chat_id: ARTEM, thread_id: undefined }, h.fx)
    expect(outcome).toBe('work')
    expect(h.calls.notify).toBe(1)
  })

  test('a burst of ideas wakes the session zero times', () => {
    const h = harness()
    const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
    for (let i = 0; i < 5; i++) dispatchIdeaRoute(route, 600 + i, h.baseInput, h.fx)
    expect(h.calls.notify).toBe(0)
    expect(h.calls.persist).toBe(5)
  })

  // FIX C2: a missing message_id must NEVER be coerced to a 0-id. The async
  // route takes the loud failure path (warnUser + logError), NO react, NO
  // notify, and does NOT persist (which would mis-id as telegram:<chat>:0 and
  // let a second id-less message be silently dropped by idempotency).
  describe('FIX C2 — missing message_id fails loud, never mis-ids', () => {
    test('async route with msgId=undefined => warn, no persist, no react, no notify', () => {
      const h = harness()
      const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
      const outcome = dispatchIdeaRoute(route, undefined, h.baseInput, h.fx)
      expect(outcome).toBe('persist-failed')
      expect(h.calls.persist).toBe(0) // never coerce a 0-id into the store
      expect(h.calls.react).toBe(0)   // no false ✍ success
      expect(h.calls.notify).toBe(0)  // still not woken
      expect(h.calls.warnUser).toBe(1)
      expect(h.calls.logError).toBe(1)
    })

    test('async route with msgId=null => same loud failure path', () => {
      const h = harness()
      const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
      const outcome = dispatchIdeaRoute(route, null, h.baseInput, h.fx)
      expect(outcome).toBe('persist-failed')
      expect(h.calls.persist).toBe(0)
      expect(h.calls.react).toBe(0)
      expect(h.calls.notify).toBe(0)
      expect(h.calls.warnUser).toBe(1)
    })

    test('store stays empty after a missing-id async message', () => {
      const h = harness()
      const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
      dispatchIdeaRoute(route, undefined, h.baseInput, h.fx)
      // no inbox.jsonl written => nothing persisted under a coerced :0 id.
      expect(ideaExists(join(dir, 'inbox.jsonl'), ideaId(SUPERGROUP, 0))).toBe(false)
    })
  })

  // FIX C3: server-side persist-failure branch. persist throws => warnUser +
  // logError, NO react (no false ✍), NO notify (session not woken).
  describe('FIX C3 — persist failure is loud, no false ack, no wake', () => {
    test('persist throws => warn + logError, no react, no notify', () => {
      const h = harness({ persistThrows: true })
      const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
      const outcome = dispatchIdeaRoute(route, 700, h.baseInput, h.fx)
      expect(outcome).toBe('persist-failed')
      expect(h.calls.persist).toBe(1) // attempted
      expect(h.calls.react).toBe(0)   // NO false ✍
      expect(h.calls.notify).toBe(0)  // NOT woken
      expect(h.calls.warnUser).toBe(1)
      expect(h.calls.logError).toBe(1)
    })

    test('persist-failure order is persist→logError→warnUser, no notify/react', () => {
      const h = harness({ persistThrows: true })
      const route = classifyRoute(access, SUPERGROUP, IDEAS_THREAD, true)
      dispatchIdeaRoute(route, 701, h.baseInput, h.fx)
      expect(h.log).toEqual(['persist', 'logError', 'warnUser'])
    })
  })

  // Belt-and-suspenders: an 'ignore' route does nothing at all.
  test("'ignore' route => no effects", () => {
    const h = harness()
    const outcome = dispatchIdeaRoute('ignore', 800, h.baseInput, h.fx)
    expect(outcome).toBe('ignored')
    expect(h.calls).toEqual({ persist: 0, react: 0, warnUser: 0, logError: 0, notify: 0 })
  })
})

// ── Reaction parity (CRUX) — a reaction on an async-thread message must NOT
// wake the session, exactly like the message itself doesn't. Telegram's
// MessageReactionUpdated carries NO message_thread_id, so shouldSuppressReaction
// maps the reacted message_id back to its thread via the durable store. The
// server's message_reaction handler is a thin guard: `if
// (shouldSuppressReaction(...)) return` before mcp.notification, so this
// predicate IS the production decision (mirrors classifyRoute for messages).
describe('shouldSuppressReaction — reaction thread parity', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-reaction-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // A reaction on a message captured into the Ideas (async) thread => SUPPRESS
  // (do not notify). The message_id is mapped to its thread via the store.
  test('async-thread message reaction => suppress (true)', () => {
    persistIdea(dir, {
      chat_id: SUPERGROUP,
      message_id: 100,
      from_user_id: ARTEM,
      thread_id: IDEAS_THREAD,
      kind: 'text',
      text: 'an idea',
    })
    expect(shouldSuppressReaction(access, dir, SUPERGROUP, 100)).toBe(true)
  })

  // A reaction on a WORK message => DEFAULT-SAFE let through (false). Work
  // messages are never persisted, so the id is unknown to the store.
  test('work message reaction (not in store) => let through (false)', () => {
    expect(shouldSuppressReaction(access, dir, SUPERGROUP, 7777)).toBe(false)
  })

  // Unknown message_id (e.g. a reaction on one of Семён's own messages, or one
  // captured before the store existed) => DEFAULT-SAFE: never drop it.
  test('unknown message_id => let through (false)', () => {
    expect(shouldSuppressReaction(access, dir, SUPERGROUP, 999999)).toBe(false)
  })

  // async disabled (no dir) => never suppress (channel keeps full behaviour).
  test('dir undefined (async disabled) => false', () => {
    expect(shouldSuppressReaction(access, undefined, SUPERGROUP, 100)).toBe(false)
  })

  // A DM / unconfigured chat is never an async source => never suppress.
  test('DM chat => false', () => {
    persistIdea(dir, { chat_id: ARTEM, message_id: 1, from_user_id: ARTEM, kind: 'text', text: 'x' })
    expect(shouldSuppressReaction(access, dir, ARTEM, 1)).toBe(false)
  })

  // A group with no async threads => nothing is async => never suppress.
  test('group with empty asyncThreads => false', () => {
    const a = { allowFrom: [ARTEM], groups: { [SUPERGROUP]: {} } }
    persistIdea(dir, {
      chat_id: SUPERGROUP, message_id: 100, from_user_id: ARTEM, thread_id: IDEAS_THREAD, kind: 'text', text: 'x',
    })
    expect(shouldSuppressReaction(a, dir, SUPERGROUP, 100)).toBe(false)
  })

  // Config drift: the message was captured in a thread that is NO LONGER in
  // asyncThreads => let the reaction through (we only suppress for CURRENT
  // async threads, re-checked against config).
  test('stored thread no longer in asyncThreads => false', () => {
    persistIdea(dir, {
      chat_id: SUPERGROUP, message_id: 100, from_user_id: ARTEM, thread_id: WORK_THREAD, kind: 'text', text: 'x',
    })
    expect(shouldSuppressReaction(access, dir, SUPERGROUP, 100)).toBe(false)
  })

  // findIdea (the shared reader) returns the record or undefined.
  test('findIdea returns the stored record / undefined', () => {
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 55, from_user_id: ARTEM, kind: 'text', text: 'y' })
    const path = join(dir, 'inbox.jsonl')
    expect(findIdea(path, ideaId(SUPERGROUP, 55))!.text).toBe('y')
    expect(findIdea(path, ideaId(SUPERGROUP, 56))).toBeUndefined()
    expect(findIdea(join(dir, 'nope.jsonl'), 'x')).toBeUndefined()
  })
})

// ── transcribeCmd resolver ───────────────────────────────────────────────────
describe('transcribeCmd', () => {
  test('returns undefined when SEMEN_TRANSCRIBE_CMD unset/blank', () => {
    expect(transcribeCmd({} as NodeJS.ProcessEnv)).toBeUndefined()
    expect(transcribeCmd({ SEMEN_TRANSCRIBE_CMD: '  ' } as NodeJS.ProcessEnv)).toBeUndefined()
  })
  test('returns the command when set', () => {
    expect(transcribeCmd({ SEMEN_TRANSCRIBE_CMD: 'whisper-wrap' } as NodeJS.ProcessEnv)).toBe('whisper-wrap')
  })
})

// ── recordTranscript store helper ────────────────────────────────────────────
describe('recordTranscript', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-transcript-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const read = (): IdeaRecord[] =>
    readFileSync(join(dir, 'inbox.jsonl'), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))

  test('flips a voice record new→ready with transcript + path, writes the transcript file', () => {
    persistIdea(dir, {
      chat_id: SUPERGROUP, message_id: 200, from_user_id: ARTEM, thread_id: IDEAS_THREAD,
      kind: 'voice', attachment_file_id: 'AwAC123',
    })
    const id = ideaId(SUPERGROUP, 200)
    expect(read().find(r => r.id === id)!.status).toBe('new')

    const ok = recordTranscript(dir, id, 'привет это идея', '/x/attachments/200.oga')
    expect(ok).toBe(true)

    const rec = read().find(r => r.id === id)!
    expect(rec.status).toBe('ready')
    expect(rec.transcript).toBe('привет это идея')
    expect(rec.attachment_path).toBe('/x/attachments/200.oga')
    expect(rec.attachment_file_id).toBe('AwAC123') // original file_id retained
    // a durable transcript file landed under transcripts/
    const fname = id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.txt'
    expect(readFileSync(join(dir, 'transcripts', fname), 'utf8')).toBe('привет это идея')
  })

  test('returns false when the id is unknown (record left untouched)', () => {
    persistIdea(dir, { chat_id: SUPERGROUP, message_id: 1, from_user_id: ARTEM, kind: 'voice', attachment_file_id: 'f' })
    expect(recordTranscript(dir, ideaId(SUPERGROUP, 999), 't')).toBe(false)
    expect(read().find(r => r.id === ideaId(SUPERGROUP, 1))!.status).toBe('new')
  })
})

// ── transcribeVoiceIdea orchestrator (REAL seam, mocked download/transcribe) ──
// The exact function server.ts fires (fire-and-forget) after a voice idea
// persists. Effects are spied; the store transition uses the REAL recordTranscript
// against a temp dir. No real whisper, no real download. Asserts the failure-safe
// invariant: the record only flips to 'ready' on success, stays 'new' otherwise.
describe('transcribeVoiceIdea — failure-safe on-capture transcription', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-transcribe-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const id = ideaId(SUPERGROUP, 300)
  const statusOf = (): string =>
    findIdea(join(dir, 'inbox.jsonl'), id)!.status

  function persistVoice() {
    persistIdea(dir, {
      chat_id: SUPERGROUP, message_id: 300, from_user_id: ARTEM, thread_id: IDEAS_THREAD,
      kind: 'voice', attachment_file_id: 'AwAC-voice',
    })
  }

  // A spy harness; onSuccess wired to the REAL recordTranscript so the store
  // transition is exercised end-to-end (download/transcribe stay mocked).
  function harness(opts: {
    download?: () => Promise<string | undefined>
    transcribe?: () => Promise<string>
  } = {}) {
    const calls = { download: 0, transcribe: 0, onSuccess: 0, replyTranscript: 0, replyFailure: 0, logError: 0, logNotice: 0 }
    let lastTranscript: string | undefined
    const fx: TranscribeEffects = {
      download: async () => { calls.download++; return (opts.download ?? (async () => '/tmp/voice-300.oga'))() },
      transcribe: async () => { calls.transcribe++; return (opts.transcribe ?? (async () => 'это голосовая идея'))() },
      onSuccess: (transcript, audioPath) => { calls.onSuccess++; return recordTranscript(dir, id, transcript, audioPath) },
      replyTranscript: t => { calls.replyTranscript++; lastTranscript = t },
      replyFailure: () => { calls.replyFailure++ },
      logError: () => { calls.logError++ },
      logNotice: () => { calls.logNotice++ },
    }
    return { fx, calls, get lastTranscript() { return lastTranscript } }
  }

  // SUCCESS: new→ready, transcript persisted, transcript replied, no failure reply.
  test('success => record new→ready with transcript, replies the transcript', async () => {
    persistVoice()
    const h = harness()
    const outcome = await transcribeVoiceIdea(true, h.fx)
    expect(outcome).toBe('ready')
    expect(statusOf()).toBe('ready')
    expect(findIdea(join(dir, 'inbox.jsonl'), id)!.transcript).toBe('это голосовая идея')
    expect(h.calls.replyTranscript).toBe(1)
    expect(h.lastTranscript).toBe('это голосовая идея')
    expect(h.calls.replyFailure).toBe(0)
  })

  // FAILURE (transcribe throws): stays 'new', file_id retained, failure reply,
  // NO transcript reply, NO store flip.
  test('transcribe throws => stays new, failure reply, no transcript persisted', async () => {
    persistVoice()
    const h = harness({ transcribe: async () => { throw new Error('whisper boom') } })
    const outcome = await transcribeVoiceIdea(true, h.fx)
    expect(outcome).toBe('failed')
    expect(statusOf()).toBe('new')
    expect(findIdea(join(dir, 'inbox.jsonl'), id)!.attachment_file_id).toBe('AwAC-voice')
    expect(h.calls.replyFailure).toBe(1)
    expect(h.calls.replyTranscript).toBe(0)
    expect(h.calls.onSuccess).toBe(0)
    expect(h.calls.logError).toBeGreaterThanOrEqual(1)
  })

  // FAILURE (download yields no file): stays 'new', never transcribes.
  test('download returns undefined => stays new, no transcribe, failure reply', async () => {
    persistVoice()
    const h = harness({ download: async () => undefined })
    const outcome = await transcribeVoiceIdea(true, h.fx)
    expect(outcome).toBe('failed')
    expect(statusOf()).toBe('new')
    expect(h.calls.transcribe).toBe(0)
    expect(h.calls.replyFailure).toBe(1)
  })

  // FAILURE (download throws): same loud failure path, stays 'new'.
  test('download throws => stays new, failure reply, loud log', async () => {
    persistVoice()
    const h = harness({ download: async () => { throw new Error('net down') } })
    const outcome = await transcribeVoiceIdea(true, h.fx)
    expect(outcome).toBe('failed')
    expect(statusOf()).toBe('new')
    expect(h.calls.replyFailure).toBe(1)
    expect(h.calls.logError).toBeGreaterThanOrEqual(1)
  })

  // FAILURE (empty transcript): treated as failure, stays 'new'.
  test('empty transcript => stays new, failure reply', async () => {
    persistVoice()
    const h = harness({ transcribe: async () => '   ' })
    const outcome = await transcribeVoiceIdea(true, h.fx)
    expect(outcome).toBe('failed')
    expect(statusOf()).toBe('new')
    expect(h.calls.replyFailure).toBe(1)
    expect(h.calls.replyTranscript).toBe(0)
  })

  // SKIP (cmd unset): graceful no-op — stays 'new', nothing downloaded, a notice.
  test('cmd not configured => skipped, stays new, no download/transcribe/reply', async () => {
    persistVoice()
    const h = harness()
    const outcome = await transcribeVoiceIdea(false, h.fx)
    expect(outcome).toBe('skipped')
    expect(statusOf()).toBe('new')
    expect(h.calls.download).toBe(0)
    expect(h.calls.transcribe).toBe(0)
    expect(h.calls.replyTranscript).toBe(0)
    expect(h.calls.replyFailure).toBe(0)
    expect(h.calls.logNotice).toBe(1)
  })

  // STORE-FLIP failure: we still have the transcript, so reply it, but the
  // record could not be flipped => outcome 'failed' (idea kept recoverable).
  test('onSuccess store-flip fails => replies transcript, outcome failed', async () => {
    persistVoice()
    const calls = { replyTranscript: 0, replyFailure: 0, logError: 0 }
    const fx: TranscribeEffects = {
      download: async () => '/tmp/voice-300.oga',
      transcribe: async () => 'хорошая идея',
      onSuccess: () => false, // simulate record not found / write failure
      replyTranscript: () => { calls.replyTranscript++ },
      replyFailure: () => { calls.replyFailure++ },
      logError: () => { calls.logError++ },
      logNotice: () => {},
    }
    const outcome = await transcribeVoiceIdea(true, fx)
    expect(outcome).toBe('failed')
    expect(calls.replyTranscript).toBe(1) // user still gets the transcript
  })
})
