// Unit tests for reaction-queue.ts — the rate-limited serial queue behind the
// idea-capture ✍ ack (owner bug-report msg 2806: mass-forwarding ~30 ideas
// didn't get a reaction on every message because the old fire-and-forget
// setMessageReaction calls raced Telegram's ~20 reactions/min throttle).
//
// `sleep` is injected and resolves instantly by default (no real waiting) —
// "fake timers via DI", matching the seam pattern already used by
// idea-inbox.ts's transcribeVoiceIdea / sendVoiceReply. Tests assert the
// REQUESTED spacing/backoff (the ms values passed to `sleep`) and the call
// ORDER, not real wall-clock elapsed time.

import { describe, expect, test } from 'bun:test'
import { DEFAULT_REACTION_SPACING_MS, ReactionQueue, type ReactionJob, type ReactionSendResult } from './reaction-queue'

function job(n: number): ReactionJob {
  return { chat_id: 'CHAT', message_id: n, emoji: '✍' }
}

describe('ReactionQueue — spacing', () => {
  test('first job sends immediately; each subsequent job waits DEFAULT_REACTION_SPACING_MS first', async () => {
    const log: string[] = []
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => { log.push(`send:${j.message_id}`); return { ok: true } },
        sleep: async ms => { log.push(`sleep:${ms}`) },
        logError: () => {},
        onIdle: resolve,
      })
      queue.enqueue(job(1))
      queue.enqueue(job(2))
      queue.enqueue(job(3))
    })
    expect(log).toEqual([
      'send:1',
      `sleep:${DEFAULT_REACTION_SPACING_MS}`,
      'send:2',
      `sleep:${DEFAULT_REACTION_SPACING_MS}`,
      'send:3',
    ])
  })

  test('a lone job sends with zero spacing delay (no sleep call at all)', async () => {
    const log: string[] = []
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => { log.push(`send:${j.message_id}`); return { ok: true } },
        sleep: async ms => { log.push(`sleep:${ms}`) },
        logError: () => {},
        onIdle: resolve,
      })
      queue.enqueue(job(1))
    })
    expect(log).toEqual(['send:1'])
  })

  test('spacing is configurable via the constructor (not hardcoded)', async () => {
    const log: string[] = []
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue(
        {
          send: async j => { log.push(`send:${j.message_id}`); return { ok: true } },
          sleep: async ms => { log.push(`sleep:${ms}`) },
          logError: () => {},
          onIdle: resolve,
        },
        1000,
      )
      queue.enqueue(job(1))
      queue.enqueue(job(2))
    })
    expect(log).toEqual(['send:1', 'sleep:1000', 'send:2'])
  })
})

describe('ReactionQueue — burst ordering (30 mass-forwarded ideas)', () => {
  test('a burst of 30 enqueued jobs are all eventually sent, in FIFO order', async () => {
    const sent: number[] = []
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => { sent.push(j.message_id); return { ok: true } },
        sleep: async () => {},
        logError: () => {},
        onIdle: resolve,
      })
      for (let i = 1; i <= 30; i++) queue.enqueue(job(i))
      expect(queue.pending).toBeGreaterThan(0) // proves enqueue() is sync/non-blocking
    })
    expect(sent.length).toBe(30)
    expect(sent).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
  })

  test('jobs enqueued mid-drain (a second wave) are appended and still all sent', async () => {
    const sent: number[] = []
    await new Promise<void>(resolve => {
      let secondWaveAdded = false
      const queue = new ReactionQueue({
        send: async j => {
          sent.push(j.message_id)
          if (!secondWaveAdded && j.message_id === 2) {
            secondWaveAdded = true
            queue.enqueue(job(100))
            queue.enqueue(job(101))
          }
          return { ok: true }
        },
        sleep: async () => {},
        logError: () => {},
        onIdle: resolve,
      })
      queue.enqueue(job(1))
      queue.enqueue(job(2))
      queue.enqueue(job(3))
    })
    expect(sent).toEqual([1, 2, 3, 100, 101])
  })
})

describe('ReactionQueue — HTTP 429 retry-once', () => {
  test('a 429 with retry_after waits it out and retries the SAME job once; success on retry => no drop, no log', async () => {
    const log: string[] = []
    let attempts = 0
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => {
          attempts++
          log.push(`send:${j.message_id}:attempt${attempts}`)
          if (attempts === 1) return { ok: false, retryAfterSec: 5 }
          return { ok: true }
        },
        sleep: async ms => { log.push(`sleep:${ms}`) },
        logError: reason => log.push(`logError:${reason}`),
        onIdle: resolve,
      })
      queue.enqueue(job(1))
    })
    expect(attempts).toBe(2)
    expect(log).toEqual(['send:1:attempt1', 'sleep:5000', 'send:1:attempt2'])
    expect(log.some(l => l.startsWith('logError'))).toBe(false)
  })

  test('a 429 that still fails after the one retry is dropped with exactly ONE logError, no infinite retry', async () => {
    const log: string[] = []
    let attempts = 0
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => {
          attempts++
          return { ok: false, retryAfterSec: 2 } as ReactionSendResult
        },
        sleep: async ms => { log.push(`sleep:${ms}`) },
        logError: reason => log.push(`logError:${reason}`),
        onIdle: resolve,
      })
      queue.enqueue(job(7))
    })
    // exactly 2 attempts total (initial + one retry), never a third.
    expect(attempts).toBe(2)
    expect(log.filter(l => l.startsWith('logError')).length).toBe(1)
    expect(log[0]).toBe('sleep:2000') // waited out retry_after before the retry
  })

  test('the retry-once cap still lets the NEXT queued job send normally', async () => {
    const sent: number[] = []
    let job1Attempts = 0
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => {
          if (j.message_id === 1) {
            job1Attempts++
            return { ok: false, retryAfterSec: 1 }
          }
          sent.push(j.message_id)
          return { ok: true }
        },
        sleep: async () => {},
        logError: () => {},
        onIdle: resolve,
      })
      queue.enqueue(job(1))
      queue.enqueue(job(2))
    })
    expect(job1Attempts).toBe(2) // initial + 1 retry, both failed
    expect(sent).toEqual([2]) // job 2 still went through — fail-open, queue keeps moving
  })
})

describe('ReactionQueue — fail-open on non-429 errors', () => {
  test('a plain failure (no retryAfterSec) is logged ONCE and dropped without any retry', async () => {
    const log: string[] = []
    let attempts = 0
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async () => { attempts++; return { ok: false, error: new Error('bad request') } },
        sleep: async ms => { log.push(`sleep:${ms}`) },
        logError: reason => log.push(reason),
        onIdle: resolve,
      })
      queue.enqueue(job(9))
    })
    expect(attempts).toBe(1) // no retry for a non-429
    expect(log.length).toBe(1)
    expect(log[0]).toContain('CHAT:9')
    expect(log[0]).toContain('bad request')
  })

  test('a send() that actually REJECTS (contract violation) is still contained — drain loop never wedges', async () => {
    // Defense-in-depth: the ReactionQueueEffects contract says `send` must
    // never throw/reject (it should classify failures into ReactionSendResult
    // instead), but if a binding regresses and rejects anyway, that must not
    // crash the drain loop's `await` and silently wedge every job queued
    // after it — see safeSend() in reaction-queue.ts. This drives that exact
    // path with a REAL rejected promise (not just an ok:false return).
    const sent: number[] = []
    const errors: string[] = []
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async j => {
          if (j.message_id === 1) throw new Error('boom')
          sent.push(j.message_id)
          return { ok: true }
        },
        sleep: async () => {},
        logError: reason => errors.push(reason),
        onIdle: resolve,
      })
      queue.enqueue(job(1))
      queue.enqueue(job(2))
      queue.enqueue(job(3))
    })
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('boom')
    expect(sent).toEqual([2, 3]) // capture-must-never-break: the rest still went out
  })
})

describe('ReactionQueue — pending/idle observability', () => {
  // enqueue() is synchronous and kicks the drain loop off immediately: the
  // FIRST job is popped-and-dispatched-to-send() within that very call (no
  // spacing delay for a lone/leading job — see the spacing describe block
  // above), so right after three back-to-back enqueue() calls, job 1 is
  // already in flight and only jobs 2+3 are still sitting in `pending`.
  test('pending reflects unsent jobs synchronously right after enqueue', async () => {
    let pendingAfterEnqueue = -1
    await new Promise<void>(resolve => {
      const queue = new ReactionQueue({
        send: async () => ({ ok: true }),
        sleep: async () => {},
        logError: () => {},
        onIdle: resolve,
      })
      queue.enqueue(job(1))
      queue.enqueue(job(2))
      queue.enqueue(job(3))
      pendingAfterEnqueue = queue.pending
    })
    expect(pendingAfterEnqueue).toBe(2)
  })

  test('pending drops back to 0 once the queue goes idle', async () => {
    let queueRef!: ReactionQueue
    await new Promise<void>(resolve => {
      queueRef = new ReactionQueue({
        send: async () => ({ ok: true }),
        sleep: async () => {},
        logError: () => {},
        onIdle: resolve,
      })
      queueRef.enqueue(job(1))
    })
    expect(queueRef.pending).toBe(0)
  })
})
