/**
 * D-883 — server.ts wiring of the chat store, end to end: the real server.ts against a fake Bot
 * API (preload; no network, no real token). Spec: sam-data
 * dev/analysis/2026-10-29-d883-store-timeline-door-spec.md §3 criteria 1–4.
 *
 * STATE ISOLATION: HOME and TELEGRAM_STATE_DIR are a fresh mkdtemp dir; nothing under the real
 * ~/.claude or ~/Workspace is read or written.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const OWNER = 111111111
const FRIEND = 222222222
const STRANGER = 333333333
const NOW_S = Math.floor(Date.now() / 1000)

let dir: string
let archive: string
let business: string
let stateDir: string
let notifications: { content: string; meta: Record<string, string> }[] = []
let calls: string[] = []
let stderr = ''

function msg(id: number, from: number, extra: Record<string, unknown>) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: NOW_S,
      chat: { id: from, type: 'private' },
      from: { id: from, is_bot: false, first_name: 'u', username: 'u' + from },
      ...extra,
    },
  }
}

const UPDATES = [
  msg(10, FRIEND, { voice: { file_id: 'V10', file_unique_id: 'uV10', duration: 2, file_size: 5 } }),
  msg(11, OWNER, { voice: { file_id: 'V11', file_unique_id: 'uV11', duration: 2, file_size: 5 } }),
  msg(12, FRIEND, { photo: [{ file_id: 'P12', file_unique_id: 'uP12', width: 9, height: 9, file_size: 5 }] }),
  msg(13, OWNER, { photo: [{ file_id: 'P13', file_unique_id: 'uP13', width: 9, height: 9, file_size: 5 }] }),
  msg(14, FRIEND, { document: { file_id: 'D14', file_unique_id: 'uD14', file_name: 'a.pdf', file_size: 5 } }),
  msg(15, STRANGER, { text: 'hello' }),
  // A permission button press from an allowed person → ctx.editMessageText (a send through ctx.api).
  {
    update_id: 16,
    callback_query: {
      id: 'cb16',
      chat_instance: 'ci',
      data: 'perm:allow:abcde',
      from: { id: FRIEND, is_bot: false, first_name: 'u' },
      message: { message_id: 50, date: NOW_S, chat: { id: FRIEND, type: 'private' }, text: '🔐 Permission: Bash' },
    },
  },
]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-chat-store-e2e-'))
  stateDir = join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    dmPolicy: 'pairing', allowFrom: [String(OWNER), String(FRIEND)], groups: {}, pending: {},
  }))
  const data = join(dir, 'Workspace', 'ClaudeProjects', 'sam-data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ user: { telegram_chat_id: String(OWNER) } }))
  archive = join(data, 'state', 'tg-archive')
  business = join(data, 'state', 'tg-business')
  // Catch-up fixtures: one stored line with a file, one secretary draft sent before this build.
  const recent = new Date((NOW_S - 86400) * 1000).toISOString()
  mkdirSync(join(archive, String(FRIEND)), { recursive: true })
  writeFileSync(join(archive, String(FRIEND), `${recent.slice(0, 7)}.jsonl`), JSON.stringify({
    ts: recent, chat_id: String(FRIEND), msg_id: 3, sender_id: String(FRIEND), senderName: 'u', kind: 'voice', text: '(voice message)', file_id: 'OLD3',
  }) + '\n')
  mkdirSync(business, { recursive: true })
  writeFileSync(join(business, 'state.json'), JSON.stringify({
    drafts: { '9001': { chat_id: '444', text: 'было отправлено', created: recent, status: 'sent', approval: { kind: '👍', at: recent }, sent_msg_id: 77 } },
    unlisted: {}, watches: {},
  }))

  const callsLog = join(dir, 'calls.log')
  writeFileSync(callsLog, '')
  const preload = join(dir, 'fake-bot-api.ts')
  writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
const CALLS_LOG = ${JSON.stringify(callsLog)}
const UPDATES = ${JSON.stringify(UPDATES)}
let served = false
let next = 900
const fake = async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/file/bot')) {
    appendFileSync(CALLS_LOG, 'FILE ' + u.split('/').pop() + '\\n')
    return new Response('BYTES ' + u.split('/').pop())
  }
  const method = u.split('/').pop()!
  let payload: any = {}
  try { payload = JSON.parse(init?.body ?? '{}') } catch {}
  appendFileSync(CALLS_LOG, method + (payload.file_id ? ' ' + payload.file_id : '') + '\\n')
  let result: unknown = true
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' }
  else if (method === 'getUpdates') {
    if (!served) { served = true; result = UPDATES }
    else { await new Promise(r => setTimeout(r, 300)); result = [] }
  } else if (method === 'getFile') {
    const ext = payload.file_id.startsWith('P') ? 'jpg' : payload.file_id.startsWith('D') ? 'pdf' : 'oga'
    result = { file_id: payload.file_id, file_unique_id: 'u' + payload.file_id, file_size: 5, file_path: 'files/' + payload.file_id + '.' + ext }
  } else if (method === 'editMessageText') {
    result = { message_id: payload.message_id, date: ${NOW_S}, edit_date: ${NOW_S}, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text }
  } else if (method.startsWith('send')) {
    result = { message_id: next++, date: ${NOW_S}, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text }
  }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = fake as any
require('node-fetch').default = fake
`)
  const child = Bun.spawn(['bun', '--preload', preload, join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_BOT_TOKEN: '1:test',
      SAM_TRANSCRIBE_CMD: 'echo transcribed',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await new Promise(r => setTimeout(r, 4000))
  child.kill()
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  stderr = err
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      if (m.method === 'notifications/claude/channel') notifications.push(m.params)
    } catch {}
  }
  calls = readFileSync(callsLog, 'utf8').split('\n').filter(Boolean)
}, 30000)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const kept = (root: string, chat: number) => {
  const d = join(root, String(chat), 'files')
  return existsSync(d) ? readdirSync(d).sort() : []
}
const metaOf = (id: number) => notifications.find(n => n.meta.message_id === String(id))?.meta ?? {}

describe('D-883 server wiring (criteria 1–4)', () => {
  test('the server polled and delivered', () => {
    expect(calls, stderr).toContain('getUpdates')
    expect(notifications.length, stderr).toBeGreaterThanOrEqual(5)
  })

  test("someone else's voice: kept under files/, delivered from there (criterion 3)", () => {
    expect(kept(archive, FRIEND)).toContain('10.oga')
    const p = join(archive, String(FRIEND), 'files', '10.oga')
    expect(readFileSync(p, 'utf8')).toBe('BYTES V10.oga')
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(metaOf(10).attachment_path).toBe(p)
    // one download for the two callers (archive keep + delivery)
    expect(calls.filter(c => c === 'getFile V10').length).toBe(1)
  })

  test("his own voice: today's path (inbox), not kept", () => {
    expect(kept(archive, OWNER).filter(n => n.startsWith('11.'))).toEqual([])
    expect(metaOf(11).attachment_path).toContain(join(stateDir, 'inbox'))
  })

  test("someone else's photo: kept, image_path points there; his own photo: inbox, not kept", () => {
    expect(kept(archive, FRIEND)).toContain('12.jpg')
    expect(metaOf(12).image_path).toBe(join(archive, String(FRIEND), 'files', '12.jpg'))
    expect(kept(archive, OWNER).filter(n => n.startsWith('13.'))).toEqual([])
    expect(metaOf(13).image_path).toContain(join(stateDir, 'inbox'))
  })

  test('a document is kept on arrival (criterion 2)', () => {
    expect(kept(archive, FRIEND)).toContain('14.pdf')
  })

  test('a send through ctx.api to an allowed chat (permission button edit) → one out line (criterion 1: ctx.api inherits the transformer)', () => {
    const d = join(archive, String(FRIEND))
    const outs = readdirSync(d).filter(n => n.endsWith('.out.jsonl'))
    expect(outs.length).toBe(1)
    const lines = readFileSync(join(d, outs[0]), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toEqual([expect.objectContaining({ direction: 'out', via: 'bot', kind: 'text', msg_id: 50, of_msg_id: 50, chat_id: String(FRIEND) })])
    expect(lines[0].text).toContain('✅ Allowed')
  })

  test('the pairing reply to a stranger is sent but stored nowhere (tg-archive = allowed people only, D-520)', () => {
    expect(calls).toContain('sendMessage')
    expect(existsSync(join(archive, String(STRANGER)))).toBe(false)
  })

  test('start-up catch-up: a stored line\'s file is fetched; a pre-build secretary send is backfilled (criterion 4)', () => {
    expect(kept(archive, FRIEND)).toContain('3.oga')
    const d = join(business, '444')
    const outs = readdirSync(d).filter(n => n.endsWith('.out.jsonl'))
    const lines = outs.flatMap(n => readFileSync(join(d, n), 'utf8').trim().split('\n').map(l => JSON.parse(l)))
    expect(lines).toEqual([expect.objectContaining({ msg_id: 77, via: 'secretary', backfilled: true, text: 'было отправлено' })])
  })

  test('no store error line on the happy path', () => {
    expect(stderr).not.toContain('"error_class"')
  })
})
