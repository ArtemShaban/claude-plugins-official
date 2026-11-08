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
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [String(OWNER)], groups: {}, pending: {}, textChunkLimit: 20, chunkMode: 'length',
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
  const preload = join(dir, 'fake-bot-api.ts')
  writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
const LOG = ${JSON.stringify(callsLog)}
let next = 700
const fake = async (url: any, init?: any) => {
  const method = String(url).split('/').pop()!
  let payload: any = {}
  try { payload = JSON.parse(init?.body ?? '{}') } catch {}
  let result: unknown = true
  if (method === 'getMe') result = { id: 1, is_bot: true, first_name: 'bot', username: 'test_bot' }
  else if (method === 'getUpdates') { await new Promise(r => setTimeout(r, 300)); result = [] }
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
