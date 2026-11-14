/**
 * buttons-da-gotovo r1 f6 — the reply tool's `done_button` path, run for real: server.ts against a fake Bot API
 * (preload; no network, no real token), driven over MCP stdio with `tools/call reply`. Observed: the sendMessage
 * payloads and the tool results. Covers switch on (one `yn:d` button on the LAST chunk only, result «+done button»),
 * switch off (no markup, the off suffix) and every incompatible argument (an error, no send).
 *
 * STATE ISOLATION: HOME and TELEGRAM_STATE_DIR are a fresh mkdtemp dir; the switch is resolved by a tiny
 * `sam_data.py` fixture under that HOME's core path that implements only `config-get` (prints exactly true / false,
 * the contract `yesNoButtonsOn` reads) — self-contained: no neighbouring core checkout, never the live sam-data,
 * nothing skipped (buttons-da-gotovo r2 f4).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const OWNER = 111111111
const OTHER = 222222222 // another allowlisted DM person — not the owner, not a co-owner
// D-1049 (spec sam-data dev/specs/2026-11-14-buttons-in-groups-spec.md AC-1 / AC-3): groups of the access list.
const G_OPEN = -1001000000001 // allowFrom empty → the owner's press counts
const G_OMIT = -1001000000002 // allowFrom names someone else only → it does not
const G_QUIET = -1001000000003 // wakeOnMention:false → it does not
const G_NONE = -1001000000009 // not in the access list
// `python3 sam_data.py config-get <key>` → the key's value from config-defaults.json beside it, as true / false.
const SAM_DATA_FIXTURE = `import json, os, sys
if len(sys.argv) != 3 or sys.argv[1] != "config-get":
    sys.exit(2)
d = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "config-defaults.json")))
v = d["defaults"][sys.argv[2]]["value"]
print("true" if v is True else "false")
`

let dir: string
let defaultsFile: string
let callsLog: string
let updatesFile: string
let stateDirG: string
const notifications: any[] = []
let nextUpdate = 1
let child: ReturnType<typeof Bun.spawn> | null = null
let stdoutBuf = ''
let stderr = ''
const responses = new Map<number, any>()
let nextId = 10

function setSwitch(on: boolean) {
  writeFileSync(defaultsFile, JSON.stringify({
    defaults: { 'yes-no-buttons': { value: on, what: 'w', why: 'w' } }, known_exceptions: [],
  }))
}

function sends(): any[] {
  return readFileSync(callsLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function rpc(method: string, params: unknown): Promise<any> {
  const id = nextId++
  child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  child!.stdin!.flush?.()
  const until = Date.now() + 15000
  while (!responses.has(id)) {
    if (Date.now() > until) throw new Error(`no response to ${method} #${id}; stderr: ${stderr.slice(-2000)}`)
    await new Promise(r => setTimeout(r, 25))
  }
  return responses.get(id)
}

async function reply(args: Record<string, unknown>): Promise<{ text: string; isError: boolean; sent: any[] }> {
  const before = sends().length
  const r = await rpc('tools/call', { name: 'reply', arguments: { chat_id: String(OWNER), ...args } })
  const res = r.result ?? {}
  return { text: res.content?.[0]?.text ?? JSON.stringify(r), isError: res.isError === true, sent: sends().slice(before) }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-done-button-e2e-'))
  const stateDir = join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  // A small chunk limit, so one text becomes three chunks (last-chunk placement).
  stateDirG = stateDir
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [String(OWNER), String(OTHER)], pending: {}, textChunkLimit: 20, chunkMode: 'length',
    groups: {
      [String(G_OPEN)]: { requireMention: true, allowFrom: [] },
      [String(G_OMIT)]: { requireMention: true, allowFrom: [String(OTHER)] },
      [String(G_QUIET)]: { requireMention: true, allowFrom: [], wakeOnMention: false },
    },
  }))
  const data = join(dir, 'Workspace', 'ClaudeProjects', 'sam-data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ user: { telegram_chat_id: String(OWNER) } }))
  const tools = join(dir, 'Workspace', 'ClaudeProjects', 'sam-core', 'tools')
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, 'sam_data.py'), SAM_DATA_FIXTURE)
  defaultsFile = join(tools, 'config-defaults.json')
  setSwitch(true)

  callsLog = join(dir, 'sends.log')
  writeFileSync(callsLog, '')
  updatesFile = join(dir, 'updates.json')
  writeFileSync(updatesFile, '[]')
  const preload = join(dir, 'fake-bot-api.ts')
  writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
import { readFileSync, writeFileSync } from 'fs'
const LOG = ${JSON.stringify(callsLog)}
const UPDATES = ${JSON.stringify(updatesFile)}
let next = 700
const fake = async (url: any, init?: any) => {
  const method = String(url).split('/').pop()!
  let payload: any = {}
  try { payload = JSON.parse(init?.body ?? '{}') } catch {}
  let result: unknown = true
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' }
  else if (method === 'getUpdates') {
    await new Promise(r => setTimeout(r, 100))
    let q: any[] = []
    try { q = JSON.parse(readFileSync(UPDATES, 'utf8')) } catch {}
    writeFileSync(UPDATES, '[]')
    result = q
  }
  else if (method === 'answerCallbackQuery' || method === 'editMessageReplyMarkup') {
    appendFileSync(LOG, JSON.stringify({ method, text: payload.text ?? null, chat_id: payload.chat_id ?? null, reply_markup: payload.reply_markup ?? null }) + '\\n')
  }
  else if (method.startsWith('send')) {
    appendFileSync(LOG, JSON.stringify({ method, text: payload.text, reply_markup: payload.reply_markup ?? null }) + '\\n')
    result = { message_id: next++, date: 1, chat: { id: Number(payload.chat_id), type: 'private' }, text: payload.text }
  }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}
globalThis.fetch = fake as any
require('node-fetch').default = fake
`)
  child = Bun.spawn(['bun', '--preload', preload, join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_BOT_TOKEN: '1:test' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  ;(async () => {
    const dec = new TextDecoder()
    for await (const c of child!.stdout as ReadableStream<Uint8Array>) {
      stdoutBuf += dec.decode(c, { stream: true })
      let i: number
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i)
        stdoutBuf = stdoutBuf.slice(i + 1)
        try {
          const m = JSON.parse(line)
          if (typeof m.id === 'number') responses.set(m.id, m)
          else if (m.method === 'notifications/claude/channel') notifications.push(m.params)
        } catch {}
      }
    }
  })()
  ;(async () => {
    const dec = new TextDecoder()
    for await (const c of child!.stderr as ReadableStream<Uint8Array>) stderr += dec.decode(c, { stream: true })
  })()
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } })
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
}, 60000)

afterAll(() => {
  child?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const LONG = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee' // > 2 × the 20-char chunk limit

describe('reply done_button — the real call path (r1 f6, self-contained r2 f4)', () => {
  test('switch on: one `yn:d` button with the label on the LAST chunk only; result «+done button»', async () => {
    setSwitch(true)
    const r = await reply({ text: LONG, done_button: 'Вошёл' })
    expect(r.isError, r.text + stderr.slice(-1000)).toBe(false)
    expect(r.text.startsWith('sent ')).toBe(true)
    expect(r.text.endsWith(' +done button')).toBe(true)
    expect(r.sent.length).toBeGreaterThanOrEqual(3)
    for (const s of r.sent.slice(0, -1)) expect(s.reply_markup).toBeNull()
    expect(r.sent[r.sent.length - 1].reply_markup).toEqual({ inline_keyboard: [[{ text: 'Вошёл', callback_data: 'yn:d' }]] })
  })

  test('switch on, short text: the one message carries the button', async () => {
    setSwitch(true)
    const r = await reply({ text: 'зайди, скажи', done_button: 'Готово' })
    expect(r.isError).toBe(false)
    expect(r.sent.length).toBe(1)
    expect(r.sent[0].reply_markup).toEqual({ inline_keyboard: [[{ text: 'Готово', callback_data: 'yn:d' }]] })
  })

  test('switch off: no markup on any chunk; the result names it «button off, answer by text»', async () => {
    setSwitch(false)
    const r = await reply({ text: LONG, done_button: 'Готово' })
    expect(r.isError).toBe(false)
    expect(r.text.startsWith('sent ')).toBe(true)
    expect(r.text.endsWith(' — button off, answer by text')).toBe(true)
    expect(r.sent.length).toBeGreaterThanOrEqual(3)
    for (const s of r.sent) expect(s.reply_markup).toBeNull()
    setSwitch(true)
  })

  for (const [name, extra] of [
    ['yes_no', { yes_no: true }],
    ['checklist', { checklist: ['a', 'b'] }],
    ['files', { files: ['/nonexistent/x.png'] }],
    ['voice', { voice: true }],
    ['as_owner_to', { as_owner_to: '123456' }],
  ] as const) {
    test(`done_button with ${name}: an error, nothing sent`, async () => {
      const r = await reply({ text: 'сделай', done_button: 'Готово', ...extra })
      expect(r.isError).toBe(true)
      expect(r.text).toContain(name)
      expect(r.sent).toEqual([])
    })
  }

  for (const [name, label] of [['empty', ''], ['a newline', 'a\nb'], ['a form feed', 'a\u000cb'], ['33 characters', 'Г'.repeat(33)]] as const) {
    test(`done_button label ${name}: an error, nothing sent`, async () => {
      const r = await reply({ text: 'сделай', done_button: label })
      expect(r.isError).toBe(true)
      expect(r.sent).toEqual([])
    })
  }
})

// ── D-1049: buttons in an allowlisted group work exactly as in DM — the real server path ────────
describe('buttons in groups — send side (AC-3)', () => {
  for (const [kind, args, onSuffix, notHere] of [
    ['yes_no', { yes_no: true }, ' +yes/no buttons', ' — no yes/no buttons: a press would not count in this chat; the answer comes by 👍/👎 or text'],
    ['done_button', { done_button: 'Готово' }, ' +done button', ' — no button: a press would not count in this chat, answer by text'],
  ] as const) {
    for (const [name, chat, ok] of [
      ["the owner's DM", OWNER, true],
      ['an allowlisted group that lets him in', G_OPEN, true],
      ["another person's DM", OTHER, false],
      ['a wakeOnMention:false group', G_QUIET, false],
      ['an allowlisted group whose allowFrom omits him', G_OMIT, false],
    ] as const) {
      test(`${kind} into ${name} → ${ok ? 'keyboard' : 'plain + the not-here suffix'}`, async () => {
        setSwitch(true)
        const r = await reply({ chat_id: String(chat), text: 'вопрос?', ...args })
        expect(r.isError, r.text + stderr.slice(-1000)).toBe(false)
        expect(r.text.startsWith('sent ')).toBe(true)
        expect(r.sent.length).toBe(1)
        if (ok) {
          expect(r.text.endsWith(onSuffix)).toBe(true)
          expect(r.sent[0].reply_markup).not.toBeNull()
        } else {
          expect(r.text.endsWith(notHere)).toBe(true)
          expect(r.sent[0].reply_markup).toBeNull()
        }
      })
    }
  }
})

function logLines(): string[] {
  try { return readFileSync(join(stateDirG, 'buttons.log'), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
function calls(method: string): any[] {
  return sends().filter(s => s.method === method)
}

async function pressE2E(fromId: number, chat: { id: number; type: string }, data: string, keyboard: any[][]) {
  const before = { n: notifications.length, answers: calls('answerCallbackQuery').length, edits: calls('editMessageReplyMarkup').length, log: logLines().length }
  const id = nextUpdate++
  writeFileSync(updatesFile, JSON.stringify([{
    update_id: id,
    callback_query: {
      id: `q${id}`, chat_instance: 'ci', data,
      from: { id: fromId, is_bot: false, first_name: 'x', username: 'artem' },
      message: { message_id: 233, date: 1, chat, text: 'вопрос?', reply_markup: { inline_keyboard: keyboard } },
    },
  }]))
  const until = Date.now() + 10000
  while (calls('answerCallbackQuery').length === before.answers || logLines().length === before.log) {
    if (Date.now() > until) throw new Error(`press not handled; stderr: ${stderr.slice(-1500)}`)
    await new Promise(r => setTimeout(r, 25))
  }
  await new Promise(r => setTimeout(r, 50))
  return {
    notes: notifications.slice(before.n),
    answers: calls('answerCallbackQuery').slice(before.answers),
    edits: calls('editMessageReplyMarkup').slice(before.edits),
    log: logLines().slice(before.log),
  }
}

describe('buttons in groups — press through the real callback path (AC-1 yn:d, AC-4, AC-5)', () => {
  const DONE_KB = [[{ text: 'Готово', callback_data: 'yn:d' }]]
  const YN_KB = [[{ text: 'Да', callback_data: 'yn:y' }, { text: 'Нет', callback_data: 'yn:n' }]]
  const sg = (id: number) => ({ id, type: 'supergroup' })
  const dm = (id: number) => ({ id, type: 'private' })
  for (const [data, kb] of [['yn:d', DONE_KB], ['yn:y', YN_KB]] as const) {
    for (const [name, from, chat, outcome] of [
      ['owner in own DM', OWNER, dm(OWNER), 'accepted'],
      ['owner in an allowlisted group with empty allowFrom', OWNER, sg(G_OPEN), 'accepted'],
      ['another member in that group', OTHER, sg(G_OPEN), 'refused:not-owner'],
      ['owner in a group not in the access list', OWNER, sg(G_NONE), 'refused:not-here'],
      ['owner in an allowlisted group whose allowFrom omits him', OWNER, sg(G_OMIT), 'refused:not-here'],
      ['owner in a wakeOnMention:false group', OWNER, sg(G_QUIET), 'refused:not-here'],
      ["owner in another person's DM", OWNER, dm(OTHER), 'refused:not-here'],
    ] as const) {
      test(`${data}: ${name} → ${outcome}`, async () => {
        const r = await pressE2E(from, chat, data, kb as any)
        expect(r.log.length).toBe(1)
        expect(r.log[0]).toContain(` outcome=${outcome} `)
        expect(r.log[0]).not.toContain('artem')
        expect(r.answers.length).toBe(1)
        const press = r.notes.filter(n => n.meta?.via === 'button')
        if (outcome === 'accepted') {
          expect(press.length).toBe(1)
          expect(press[0].meta).toMatchObject({ event: 'reaction', chat_id: String(chat.id), message_id: '233', user_id: String(from), via: 'button' })
          expect(Object.keys(press[0].meta).sort()).toEqual(['chat_id', 'event', 'message_id', 'reaction_added', 'ts', 'user', 'user_id', 'via'])
          expect(r.edits.length).toBe(1)
          expect(r.log[0]).toContain(`chat_id=${chat.id} `)
        } else {
          expect(press).toEqual([])
          expect(r.edits).toEqual([])
          expect(r.answers[0].text).toBe('Not authorized.') // config has no user.language → en
          if (from === OTHER) expect(r.log[0]).not.toContain(String(OTHER))
        }
      })
    }
  }
})
