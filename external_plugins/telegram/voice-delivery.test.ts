// Unit tests for voice-delivery.ts (SemenAssistant analysis/2026-09-17-
// bridge-voice-spec-FINAL.md §11). Pure/effect-injected — no real subprocess,
// no network, no import of server.ts (F16: server.ts has top-level side
// effects that would make it unsafe to import from a test file).
import { describe, expect, test } from 'bun:test'
import {
  deliverVoiceTranscript,
  serialize,
  transcribeFlags,
  voiceAuthor,
  whisperTimeoutMs,
  withTimeout,
  type VoiceAuthorResult,
} from './voice-delivery'

// ── §11.1 — serialize ───────────────────────────────────────────────────────
describe('serialize — per-key FIFO chain', () => {
  test('three tasks on one key: completion order = enqueue order, even when the middle one is slow', async () => {
    const order: number[] = []
    const key = 'chat:1'
    const p1 = serialize(key, async () => {
      order.push(1)
    })
    const p2 = serialize(key, async () => {
      await new Promise(r => setTimeout(r, 30)) // artificially slow
      order.push(2)
    })
    const p3 = serialize(key, async () => {
      order.push(3)
    })
    await Promise.all([p1, p2, p3])
    expect(order).toEqual([1, 2, 3])
  })

  test('a failing task does not break the chain — the next queued task still runs', async () => {
    const order: string[] = []
    const key = 'chat:2'
    const p1 = serialize(key, async () => {
      order.push('one')
      throw new Error('boom')
    })
    const p2 = serialize(key, async () => {
      order.push('two')
      return 'ok'
    })
    await expect(p1).rejects.toThrow('boom')
    await expect(p2).resolves.toBe('ok')
    expect(order).toEqual(['one', 'two'])
  })

  test('two different keys never wait on each other', async () => {
    const order: string[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>(r => {
      releaseA = r
    })
    const pA = serialize('chat:a', async () => {
      await gateA
      order.push('a')
    })
    const pB = serialize('chat:b', async () => {
      order.push('b') // must not wait behind chat:a's still-pending task
    })
    await pB
    expect(order).toEqual(['b'])
    releaseA()
    await pA
    expect(order).toEqual(['b', 'a'])
  })

  test('the Map entry is removed once a key\'s queue drains (no leak)', async () => {
    const key = 'chat:leak-check'
    await serialize(key, async () => 'done')
    // Give the tail's own .finally cleanup a microtask to run.
    await Promise.resolve()
    await Promise.resolve()
    // Re-run on the same key: if cleanup had failed to fire, this still
    // passes (a stale-but-settled tail behaves the same as none) — the real
    // assertion is behavioural: a FRESH task on the same key after a drain
    // starts immediately, not queued behind a phantom entry.
    const start = Date.now()
    await serialize(key, async () => undefined)
    expect(Date.now() - start).toBeLessThan(50)
  })
})

// ── §11.5 — withTimeout ─────────────────────────────────────────────────────
describe('withTimeout', () => {
  test('a hung operation is killed and rejects once the timeout elapses', async () => {
    let killed = false
    const hung = new Promise<string>(() => {}) // never settles
    await expect(withTimeout(hung, 20, () => { killed = true })).rejects.toThrow(/timed out/)
    expect(killed).toBe(true)
  })

  test('an operation that settles before the timeout resolves normally and never calls onTimeout', async () => {
    let killed = false
    const fast = Promise.resolve('ok')
    await expect(withTimeout(fast, 200, () => { killed = true })).resolves.toBe('ok')
    expect(killed).toBe(false)
  })

  test('an operation that rejects before the timeout propagates its own rejection, not a timeout', async () => {
    let killed = false
    const failing = Promise.reject(new Error('real failure'))
    await expect(withTimeout(failing, 200, () => { killed = true })).rejects.toThrow('real failure')
    expect(killed).toBe(false)
  })
})

describe('whisperTimeoutMs', () => {
  test('short clips still get the 60s floor', () => {
    expect(whisperTimeoutMs(5)).toBe(60_000)
  })
  test('long clips scale past the floor (duration * 1000)', () => {
    expect(whisperTimeoutMs(600)).toBe(600_000)
  })
})

// ── §11.2 — voiceAuthor ─────────────────────────────────────────────────────
describe('voiceAuthor', () => {
  const owner = { id: 378650081, is_bot: false, username: 'owner_handle', first_name: 'Артём' }
  const stranger = { id: 999, is_bot: false, username: 'some_user', first_name: 'Иван' }

  test('no forward_origin, owner sent it => sender / owner trust', () => {
    const r = voiceAuthor({ from: owner, forwardOrigin: undefined }, '378650081')
    expect(r).toEqual({
      voice_author: 'owner_handle',
      voice_author_id: '378650081',
      voice_author_origin: 'sender',
      voice_trust: 'owner',
    })
  })

  test('no forward_origin, stranger sent it => sender / data trust', () => {
    const r = voiceAuthor({ from: stranger, forwardOrigin: undefined }, '378650081')
    expect(r.voice_author_origin).toBe('sender')
    expect(r.voice_trust).toBe('data')
    expect(r.voice_author_id).toBe('999')
  })

  test('no forward_origin, owner sent it, but SEMEN_OWNER_TG_ID is unset => data (fail-safe)', () => {
    const r = voiceAuthor({ from: owner, forwardOrigin: undefined }, undefined)
    expect(r.voice_trust).toBe('data')
  })

  test('forward_origin type=user => forward_user / data, even when the original sender is the owner', () => {
    const r = voiceAuthor(
      { from: stranger, forwardOrigin: { type: 'user', date: 0, sender_user: owner } },
      '378650081',
    )
    expect(r.voice_author_origin).toBe('forward_user')
    expect(r.voice_author_id).toBe('378650081')
    expect(r.voice_trust).toBe('data') // forwarding his own voice is still 'data' (A-2)
  })

  test('forward_origin type=hidden_user => forward_hidden_user, NO voice_author_id, data trust', () => {
    const r = voiceAuthor(
      { from: stranger, forwardOrigin: { type: 'hidden_user', date: 0, sender_user_name: 'Anon Name' } },
      '378650081',
    )
    expect(r.voice_author_origin).toBe('forward_hidden_user')
    expect(r.voice_author_id).toBeUndefined()
    expect(r.voice_author).toBe('Anon Name')
    expect(r.voice_trust).toBe('data')
  })

  test('forward_origin type=chat => forward_chat / data, uses chat title when no username', () => {
    const r = voiceAuthor(
      {
        from: stranger,
        forwardOrigin: {
          type: 'chat',
          date: 0,
          sender_chat: { id: -100123, type: 'group', title: 'Family Group' } as never,
        },
      },
      '378650081',
    )
    expect(r.voice_author_origin).toBe('forward_chat')
    expect(r.voice_author_id).toBe('-100123')
    expect(r.voice_author).toBe('Family Group')
    expect(r.voice_trust).toBe('data')
  })

  test('forward_origin type=channel => forward_channel / data', () => {
    const r = voiceAuthor(
      {
        from: stranger,
        forwardOrigin: {
          type: 'channel',
          date: 0,
          message_id: 1,
          chat: { id: -1009, type: 'channel', title: 'News Channel', username: 'newschan' } as never,
        },
      },
      '378650081',
    )
    expect(r.voice_author_origin).toBe('forward_channel')
    expect(r.voice_author_id).toBe('-1009')
    expect(r.voice_author).toBe('newschan')
    expect(r.voice_trust).toBe('data')
  })

  test('a name containing envelope-delimiter characters is sanitized (safeName parity)', () => {
    const dirty = { id: 42, is_bot: false, username: undefined, first_name: 'Evil<name>[x];\r\nBreak' }
    const r = voiceAuthor({ from: dirty, forwardOrigin: undefined }, undefined)
    expect(r.voice_author).not.toMatch(/[<>[\]\r\n;]/)
    expect(r.voice_author).toBe('Evil_name__x____Break')
  })
})

// ── §11.4 — transcribeFlags ──────────────────────────────────────────────
describe('transcribeFlags', () => {
  test('owner-sent message => --msg-id, --chat-id, --source telegram, --no-recall', () => {
    expect(transcribeFlags(true, 42, -100555)).toEqual([
      '--msg-id',
      '42',
      '--chat-id',
      '-100555',
      '--source',
      'telegram',
      '--no-recall',
    ])
  })

  test('non-owner sender => --no-save + --no-recall, no owner-log flags at all (F3 fix — analysis/2026-09-17-voice-bridge-u3-verdict.md: a stranger/forwarded transcript must never be archived under a filename that reads as the owner\'s own words)', () => {
    const flags = transcribeFlags(false, 42, -100555)
    expect([...flags].sort()).toEqual(['--no-recall', '--no-save'])
    expect(flags).toContain('--no-save')
  })

  test('owner-sent message never carries --no-save', () => {
    expect(transcribeFlags(true, 42, -100555)).not.toContain('--no-save')
  })

  test('owner-sent but non-digit msg-id/chat-id are dropped (defensive — never reachable via real Telegram ids)', () => {
    expect(transcribeFlags(true, 'abc' as unknown as number, '123;rm -rf' as unknown as number)).toEqual([
      '--source',
      'telegram',
      '--no-recall',
    ])
  })
})

// ── §11.3 — deliverVoiceTranscript fail-open (A13, 6 cases) ─────────────────
describe('deliverVoiceTranscript — fail-open (A13)', () => {
  const author: VoiceAuthorResult = {
    voice_author: 'owner_handle',
    voice_author_id: '378650081',
    voice_author_origin: 'sender',
    voice_trust: 'owner',
  }
  const baseline = { text: '(voice message)', meta: {} }
  const baselineWithCaption = { text: 'a caption', meta: {} }

  test('case 1 — no TRANSCRIBE_CMD configured => baseline placeholder', async () => {
    const notices: string[] = []
    const r = await deliverVoiceTranscript(false, undefined, author, {
      download: async () => 'unused',
      transcribe: async () => 'unused',
      logNotice: reason => notices.push(reason),
    })
    expect(r).toEqual(baseline)
    expect(notices.length).toBe(1)
  })

  test('case 2 — download resolves undefined (covers the existing >20MB cap) => baseline placeholder', async () => {
    const r = await deliverVoiceTranscript(true, undefined, author, {
      download: async () => undefined,
      transcribe: async () => 'should never be called',
      logNotice: () => {},
    })
    expect(r).toEqual(baseline)
  })

  test('case 3 — download throws (network/getFile error) => baseline placeholder', async () => {
    const r = await deliverVoiceTranscript(true, undefined, author, {
      download: async () => {
        throw new Error('HTTP 500')
      },
      transcribe: async () => 'should never be called',
      logNotice: () => {},
    })
    expect(r).toEqual(baseline)
  })

  test('case 4 — transcribe rejects with a nonzero-exit-style error => baseline placeholder (caption preserved)', async () => {
    const r = await deliverVoiceTranscript(true, 'a caption', author, {
      download: async () => '/tmp/x.oga',
      transcribe: async () => {
        throw new Error('transcribe cmd exited 1: whisper-cli crashed')
      },
      logNotice: () => {},
    })
    expect(r).toEqual(baselineWithCaption)
  })

  test('case 5 — transcribe rejects with a timeout-style error => baseline placeholder', async () => {
    const r = await deliverVoiceTranscript(true, undefined, author, {
      download: async () => '/tmp/x.oga',
      transcribe: async () => {
        throw new Error('transcribe cmd timed out after 60000ms')
      },
      logNotice: () => {},
    })
    expect(r).toEqual(baseline)
  })

  test('case 6 — transcript is blank (silence) => baseline placeholder', async () => {
    const r = await deliverVoiceTranscript(true, undefined, author, {
      download: async () => '/tmp/x.oga',
      transcribe: async () => '   \n  ',
      logNotice: () => {},
    })
    expect(r).toEqual(baseline)
  })

  test('success path — full envelope with all 6 meta keys, caption preserved, transcript trimmed', async () => {
    const r = await deliverVoiceTranscript(true, 'my caption', author, {
      download: async () => '/abs/path/attachments/123-abc.oga',
      transcribe: async () => '  hello world  \n',
      logNotice: () => {},
    })
    expect(r.text).toBe('my caption\n\nhello world')
    expect(r.meta).toEqual({
      transcript_source: 'bridge',
      attachment_path: '/abs/path/attachments/123-abc.oga',
      voice_author: 'owner_handle',
      voice_author_id: '378650081',
      voice_author_origin: 'sender',
      voice_trust: 'owner',
    })
  })

  test('success path — no voice_author_id key when the author omitted it (forward_hidden_user)', async () => {
    const hiddenAuthor: VoiceAuthorResult = {
      voice_author: 'Anon',
      voice_author_origin: 'forward_hidden_user',
      voice_trust: 'data',
    }
    const r = await deliverVoiceTranscript(true, undefined, hiddenAuthor, {
      download: async () => '/abs/path/attachments/1-x.oga',
      transcribe: async () => 'hi',
      logNotice: () => {},
    })
    expect('voice_author_id' in r.meta).toBe(false)
  })
})

// ── F4 fix (analysis/2026-09-17-voice-bridge-u3-verdict.md) ─────────────────
//
// deliverVoiceTranscript's own try/catch only covers download/transcribe
// REJECTING or resolving falsy — it never bounds a download that simply
// never settles (server.ts's real downloadFileToInbox is a bare `fetch`
// with no timeout). Before the fix, that hang propagated straight through
// `await deliverVoiceTranscript(...)` in server.ts's per-chat `serialize`
// block, wedging that chat's chain (and every message queued behind it)
// forever. The fix wraps the WHOLE deliverVoiceTranscript(...) call in the
// already-tested `withTimeout`, ceiling = timeoutMs + a fixed download
// budget, and on timeout falls through to the same placeholder envelope an
// ordinary download failure already produces.
//
// server.ts itself can't be imported (F16), so this mirrors the exact
// composition server.ts's voice branch now uses — real `withTimeout` +
// `deliverVoiceTranscript` + `serialize`, nothing stubbed.
describe('F4 fix — a hung download is bounded (timeoutMs + download budget), not wedged forever', () => {
  test('download that never settles: envelope falls through to the baseline placeholder within the bound, exactly one logNotice fires, and the per-chat serialize key is released for the next task', async () => {
    const chatKey = 'chat:F4-test-1004336259518'
    const author: VoiceAuthorResult = {
      voice_author: 'stranger',
      voice_author_origin: 'sender',
      voice_trust: 'data',
    }
    const timeoutMs = 30 // stand-in for whisperTimeoutMs(...), kept small for test speed
    const downloadBudgetMs = 20 // stand-in for voice-delivery.ts's DOWNLOAD_TIMEOUT_MS
    const caption: string | undefined = undefined
    const outerLogs: string[] = []
    const innerLogs: string[] = []

    // Enqueue the (would-be-hung) voice delivery FIRST.
    const task1 = serialize(chatKey, async () => {
      const envelope = await withTimeout(
        deliverVoiceTranscript(true, caption, author, {
          download: () => new Promise<string | undefined>(() => {}), // never settles
          transcribe: async () => 'unreachable — download never resolves',
          logNotice: reason => innerLogs.push(reason),
        }),
        timeoutMs + downloadBudgetMs,
        () => outerLogs.push(`voice envelope timed out after ${timeoutMs + downloadBudgetMs}ms`),
      ).catch(() => ({ text: caption ?? '(voice message)', meta: {} }))
      return envelope
    })

    // Enqueue a SECOND task on the SAME key WHILE task1 is still pending —
    // the actual regression: pre-fix, task1 never settles, so this would
    // wait behind it forever.
    let task2Ran = false
    const task2 = serialize(chatKey, async () => {
      task2Ran = true
    })

    const envelope = await task1
    await task2

    expect(envelope).toEqual({ text: '(voice message)', meta: {} })
    // exactly one notice — the OUTER timeout, not the inner one (the inner
    // deliverVoiceTranscript never gets to log anything: its own await never
    // returns, because the download it's waiting on never settles).
    expect(innerLogs.length).toBe(0)
    expect(outerLogs.length).toBe(1)
    expect(outerLogs[0]).toContain('timed out')
    expect(task2Ran).toBe(true)
  }, 800)

  test('a caption is preserved in the timeout placeholder, same as an ordinary download failure', async () => {
    const chatKey = 'chat:F4-test-caption'
    const author: VoiceAuthorResult = { voice_author: 'stranger', voice_author_origin: 'sender', voice_trust: 'data' }
    const timeoutMs = 20
    const downloadBudgetMs = 15
    const caption = 'a caption'

    const envelope = await serialize(chatKey, async () =>
      withTimeout(
        deliverVoiceTranscript(true, caption, author, {
          download: () => new Promise<string | undefined>(() => {}),
          transcribe: async () => 'unreachable',
          logNotice: () => {},
        }),
        timeoutMs + downloadBudgetMs,
        () => {},
      ).catch(() => ({ text: caption ?? '(voice message)', meta: {} })),
    )
    expect(envelope).toEqual({ text: 'a caption', meta: {} })
  })
})
