/**
 * Child process of the rr1 f3 two-process test in tg-archive.test.ts (run as `bun ./topic-name.child.ts`; not a
 * test file). It learns one thread into a SHARED archive root and blocks right before its first store write until
 * every child has reached that point — i.e. after each one has read the store. The barrier sits inside
 * learnTopicName: fs.openSync / fs.writeFileSync are wrapped BEFORE tg-archive is imported (Bun's named fs imports
 * resolve through the patched module object). Exit 0 = learned; anything else = a failure on stderr.
 */
import { join } from 'path'

const fs = require('fs') as typeof import('fs')
const env = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} not set`)
  return v
}
const ROOT = env('TOPIC_CHILD_ROOT')
const CHAT = env('TOPIC_CHILD_CHAT')
const THREAD = Number(env('TOPIC_CHILD_THREAD'))
const BAR = env('TOPIC_CHILD_BARRIER')
const ME = env('TOPIC_CHILD_ME')
const PEERS = ['a', 'b']

let waited = false
function barrier(path: unknown): void {
  if (waited || typeof path !== 'string' || !path.includes('topics.json')) return
  waited = true
  realWrite(join(BAR, 'ready-' + ME), '')
  const deadline = Date.now() + 20_000
  const cell = new Int32Array(new SharedArrayBuffer(4))
  while (!PEERS.every(p => fs.existsSync(join(BAR, 'ready-' + p)))) {
    if (Date.now() > deadline) throw new Error('barrier timeout')
    Atomics.wait(cell, 0, 0, 10)
  }
}
const realOpen = fs.openSync
const realWrite = fs.writeFileSync
;(fs as { openSync: unknown }).openSync = (p: unknown, flags?: unknown, ...rest: unknown[]) => {
  if (typeof flags === 'string' && /[wa+]/.test(flags)) barrier(p)
  return (realOpen as Function)(p, flags, ...rest)
}
;(fs as { writeFileSync: unknown }).writeFileSync = (p: unknown, ...rest: unknown[]) => {
  barrier(p)
  return (realWrite as Function)(p, ...rest)
}

const { learnTopicName } = await import('./tg-archive')
const logs: string[] = []
learnTopicName(ROOT, CHAT, {
  date: 1_760_000_000, message_thread_id: THREAD, is_topic_message: true,
  forum_topic_created: { name: 'тема ' + THREAD },
}, line => { logs.push(line) })
if (!waited) throw new Error('the store write never reached the barrier')
if (logs.length) throw new Error(logs.join('\n'))
