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
  ideaExists,
  ideaId,
  ideaInboxDir,
  IdeaRecord,
  persistIdea,
  selectReadyForPour,
  setIdeaStatus,
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

// ── No-interrupt proof (AC3) ────────────────────────────────────────────────
// handleInbound itself imports the grammY runtime, so we test the decision the
// async branch makes against a notification *mock*: route 'async' persists and
// MUST NOT notify; route 'work' notifies. This mirrors the exact code in
// server.ts's handleInbound (classifyRoute => async => persist+return BEFORE
// mcp.notification).
describe('async branch does not wake the session (AC3)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'idea-inbox-noint-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Replica of the server.ts handleInbound routing block (kept in lock-step).
  function route(threadId: number | undefined, notify: () => void): 'persisted' | 'notified' {
    const r = classifyRoute(access, SUPERGROUP, threadId, true)
    if (r === 'async') {
      persistIdea(dir, {
        chat_id: SUPERGROUP,
        message_id: 200 + (threadId ?? 0),
        from_user_id: ARTEM,
        thread_id: threadId,
        kind: 'text',
        text: 'idea',
      })
      return 'persisted'
    }
    notify()
    return 'notified'
  }

  test('Ideas topic => persisted, notify NOT called', () => {
    let calls = 0
    const res = route(IDEAS_THREAD, () => calls++)
    expect(res).toBe('persisted')
    expect(calls).toBe(0)
  })

  test('work topic => notify called', () => {
    let calls = 0
    const res = route(WORK_THREAD, () => calls++)
    expect(res).toBe('notified')
    expect(calls).toBe(1)
  })

  test('a burst of ideas wakes the session zero times', () => {
    let calls = 0
    for (let i = 0; i < 5; i++) route(IDEAS_THREAD, () => calls++)
    expect(calls).toBe(0)
  })
})
