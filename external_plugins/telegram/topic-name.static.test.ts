/**
 * Topic-name spec, Codex r1 f3 — the ONE-WRITER premise of topics.json, pinned in source.
 *
 * topics.json is read-modify-written without a lock. That is safe only while (1) a single process polls the bot
 * token — Telegram serves getUpdates to one consumer (a second gets 409 Conflict) and server.ts replaces a stale
 * poller at start via PID_FILE — and (2) every read-modify-write in the topic section of tg-archive.ts is
 * synchronous, so two handlers of that process never interleave between the read and the rename. If either
 * premise is removed, these tests fail and the store needs a real lock.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8')

describe('topics.json one-writer premise (Codex r1 f3)', () => {
  test('server.ts replaces a stale poller and records its own pid before polling', () => {
    const s = src('server.ts')
    expect(s).toContain("const PID_FILE = join(STATE_DIR, 'bot.pid')")
    expect(s).toContain('replacing stale poller')
    expect(s).toContain("process.kill(stale, 'SIGTERM')")
    expect(s).toContain('writeFileSync(PID_FILE, String(process.pid))')
  })

  test('the topic-name section of tg-archive.ts has no async step between read and rename', () => {
    const a = src('tg-archive.ts')
    const start = a.indexOf('// ── Forum topic names')
    expect(start).toBeGreaterThan(0)
    // code only: block comments and line comments out (the comments themselves say «no await»)
    const section = a.slice(start).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(section).not.toMatch(/\bawait\b|\basync\b|Promise|setTimeout|setImmediate|fs\/promises/)
    expect(section).toContain('renameSync(tmp, p)')
    expect(section).toContain('randomUUID()') // unique temp name per write
  })

  test('server.ts calls the topic helpers synchronously (no await on them)', () => {
    const s = src('server.ts')
    expect(s).not.toMatch(/await\s+(learnTopicName|inboundTopicName)\b/)
    expect(s).toMatch(/learnTopicName\(ARCHIVE_ROOT/)
    expect(s).toMatch(/inboundTopicName\(ARCHIVE_ROOT/)
  })
})
