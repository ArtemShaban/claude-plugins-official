// reaction-queue.ts — rate-limited serial queue for outbound emoji reactions.
//
// THE BUG (owner report, msg 2806): mass-forwarding ~30 ideas into the ideas
// group didn't get a ✍ ack on every message. The idea-capture path already
// reacts on each successfully-persisted idea (idea-inbox.ts's dispatchIdeaRoute
// calls fx.react() right after persist), but the old binding fired
// `bot.api.setMessageReaction` directly, fire-and-forget, with NO spacing — a
// burst of 30 captures fired ~30 concurrent reaction calls and Telegram's
// ~20-reactions/min throttle silently dropped the rest (the calls were
// `.catch(() => {})`'d, so the failures were invisible).
//
// THE FIX: route every idea-capture ack through this single in-process FIFO
// queue instead of calling the Bot API directly. The queue:
//   - sends the FIRST job immediately (a lone idea should still ack fast),
//   - then paces subsequent sends ~3.2s apart (~18/min, under the ~20/min cap),
//   - on an HTTP 429 parses `retry_after` (seconds), waits it out, and retries
//     the SAME job exactly once,
//   - on any other failure (or a second 429/error after the retry) logs ONE
//     line and DROPS the job — a missed ✍ is a cosmetic receipt, never worth
//     risking the capture path itself (fail-open, per CLAUDE.md §0).
//
// MEMORY-ONLY BY DESIGN: the queue holds jobs only in a process array. A plugin
// restart mid-drain loses whatever hasn't been sent yet. This is an accepted
// tradeoff (documented here, not hidden): the ✍ reaction is a receipt that the
// idea was durably captured, not the capture itself — inbox.jsonl (idea-inbox.ts)
// is the source of truth and is written synchronously BEFORE this queue is ever
// touched. A lost ack reaction after a restart costs nothing but a cosmetic
// checkmark; re-persisting is never at risk.
//
// EFFECT-INJECTED (same seam pattern as idea-inbox.ts's dispatchIdeaRoute /
// transcribeVoiceIdea): server.ts binds `send` to bot.api.setMessageReaction and
// `sleep` to a real setTimeout-based promise; the unit test binds both to spies
// with an instantly-resolving `sleep` so pacing can be asserted from call order/
// args without waiting real wall-clock seconds ("fake timers" via DI, not a
// timer-mocking library).

/** One outbound reaction to send. */
export type ReactionJob = {
  chat_id: string
  message_id: number
  emoji: string
}

/**
 * Outcome of one send attempt. `ok:false` WITHOUT retryAfterSec means "not a
 * 429 — do not retry, just log + drop". `retryAfterSec` set means "429, this
 * many seconds until the next attempt is allowed".
 */
export type ReactionSendResult =
  | { ok: true }
  | { ok: false; retryAfterSec?: number; error?: unknown }

export type ReactionQueueEffects = {
  /** Send exactly one reaction. Must never throw — classify the failure into
   *  the ReactionSendResult shape instead (see server.ts's binding). */
  send: (job: ReactionJob) => Promise<ReactionSendResult>
  /** Sleep for `ms` milliseconds. Injected so tests don't wait real time. */
  sleep: (ms: number) => Promise<void>
  /** One-line stderr log on the fail-open drop path. */
  logError: (reason: string) => void
  /** Optional: fires once each time the queue drains back to idle (empty +
   *  not sending). server.ts never sets this (production is genuinely
   *  fire-and-forget) — it exists purely so tests can `await` a burst
   *  finishing without polling or real timers. */
  onIdle?: () => void
}

/** ~18/min — comfortably under Telegram's ~20 reactions/min throttle. */
export const DEFAULT_REACTION_SPACING_MS = 3200

/**
 * A single-flight, order-preserving FIFO queue for outbound reactions.
 *
 * `enqueue` is synchronous and never throws — it just appends to the internal
 * array and (if idle) kicks off the drain loop. Callers never await it; that is
 * the whole point (the idea-capture path stays fire-and-forget from its POV,
 * exactly like the direct `setMessageReaction` call it replaces — see
 * server.ts's `react:` binding in the idea-inbox fx block).
 */
export class ReactionQueue {
  private readonly jobs: ReactionJob[] = []
  private draining = false
  private readonly fx: ReactionQueueEffects
  private readonly spacingMs: number

  constructor(fx: ReactionQueueEffects, spacingMs: number = DEFAULT_REACTION_SPACING_MS) {
    this.fx = fx
    this.spacingMs = spacingMs
  }

  /** Number of jobs still waiting (not yet sent) — exposed for tests/observability. */
  get pending(): number {
    return this.jobs.length
  }

  enqueue(job: ReactionJob): void {
    this.jobs.push(job)
    void this.drain()
  }

  /**
   * Drain the queue in FIFO order, one job at a time. Re-entrancy-safe: a
   * second call while already draining is a no-op (the running loop will pick
   * up anything enqueued meanwhile — `this.jobs` is shared state).
   *
   * Spacing: the FIRST job of a drain run sends immediately; every subsequent
   * job waits `spacingMs` first. This keeps a lone idea's ack fast while
   * capping the sustained rate of a burst.
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      let first = true
      while (this.jobs.length > 0) {
        if (!first) await this.fx.sleep(this.spacingMs)
        first = false
        const job = this.jobs.shift()!
        await this.sendWithRetry(job)
      }
    } finally {
      this.draining = false
      this.fx.onIdle?.()
    }
  }

  /**
   * Send one job; on a 429 wait out `retry_after` and retry exactly once; any
   * other failure (or a failure on the retry attempt) is logged once and
   * dropped. Never throws — this is the fail-open boundary (CLAUDE.md §0: a
   * missed reaction must never break capture, and one bad job must never wedge
   * the drain loop for every job queued after it).
   */
  private async sendWithRetry(job: ReactionJob): Promise<void> {
    const first = await safeSend(this.fx, job)
    if (first.ok) return

    if (first.retryAfterSec != null) {
      await this.fx.sleep(first.retryAfterSec * 1000)
      const retry = await safeSend(this.fx, job)
      if (retry.ok) return
      this.fx.logError(
        `reaction-queue: dropping ${job.emoji} on ${job.chat_id}:${job.message_id} ` +
          `(429 retry failed: ${describeError(retry)})`,
      )
      return
    }

    this.fx.logError(
      `reaction-queue: dropping ${job.emoji} on ${job.chat_id}:${job.message_id}: ${describeError(first)}`,
    )
  }
}

/**
 * Call `fx.send` defensively: the contract says it must never throw/reject
 * (it should classify failures into ReactionSendResult instead), but a rogue
 * binding rejecting anyway must not crash the drain loop's `await` and wedge
 * every job queued after it — that would turn one bad send into a silent,
 * permanent outage for the whole ✍-ack feature. A reject is treated exactly
 * like a returned `{ ok: false }` (no retryAfterSec, so no retry either).
 */
async function safeSend(fx: ReactionQueueEffects, job: ReactionJob): Promise<ReactionSendResult> {
  try {
    return await fx.send(job)
  } catch (error) {
    return { ok: false, error }
  }
}

function describeError(result: { ok: false; error?: unknown }): string {
  if (result.error === undefined) return 'unknown error'
  return result.error instanceof Error ? result.error.message : String(result.error)
}
