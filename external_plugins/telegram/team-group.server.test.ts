/**
 * Team group (`team: true`) — server.ts wiring end to end: the real server.ts against a fake Bot API
 * (preload; no network, no real token). Spec: sam-data dev/analysis/2026-11-18-tg-bot-team-group-spec.md
 * AC-01 (gate wiring), AC-02 (reaction), AC-03 (archive line), AC-04 (envelope, no buffer), AC-05 (keeper).
 *
 * STATE ISOLATION (dev-rules §1.2): HOME and TELEGRAM_STATE_DIR are a fresh mkdtemp dir; nothing under
 * the real ~/.claude or ~/Workspace is read or written (last test: the live archive dir's mtime).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

const OWNER = 111111111
const MEMBER = 444444444
const BOT_ID = 1
const BOT = 'test_bot'
const TEAM = -1001112223334
const OLD = -1005556667778 // an existing group: requireMention, everyone allowed, no buffer
const BUF = -1009990001112 // positive control: an existing group with contextBuffer + a stale buffer
const TOPIC = 7
const NOW_S = Math.floor(Date.now() / 1000)
const LIVE_ARCHIVE = join(homedir(), 'Workspace', 'ClaudeProjects', 'sam-data', 'state', 'tg-archive')
const liveStamp = () => (existsSync(LIVE_ARCHIVE) ? statSync(LIVE_ARCHIVE).mtimeMs : null)
const LIVE_BEFORE = liveStamp()

let dir: string
let archive: string
let notifications: { content: string; meta: Record<string, string> }[] = []
let calls: string[] = []
let stderr = ''

type From = { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean }
const owner: From = { id: OWNER, first_name: 'Артём', last_name: 'Ш', username: 'owner_u' }
const member: From = { id: MEMBER, first_name: 'Член', last_name: 'Команды', username: 'member_u' }
const botUser = { id: BOT_ID, is_bot: true, first_name: 'bot', username: BOT }
const at = (rest: string) => ({ text: `@${BOT}${rest}`, entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] })
const topicRoot = { message_id: 2, date: NOW_S, chat: { id: TEAM, type: 'supergroup' }, from: botUser, forum_topic_created: { name: 'Тема', icon_color: 1 } }

function groupMsg(id: number, chat: number, from: From, extra: Record<string, unknown>, topic: number | null = TOPIC) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: NOW_S,
      chat: { id: chat, type: 'supergroup', title: 't', is_forum: chat === TEAM },
      from: { is_bot: false, ...from },
      ...(topic != null ? { message_thread_id: topic, is_topic_message: true, reply_to_message: topicRoot } : {}),
      ...extra,
    },
  }
}
const voice = (id: string) => ({ voice: { file_id: id, file_unique_id: 'u' + id, duration: 2, file_size: 5 } })

const UPDATES = [
  // 101 owner @ in a topic, a reply with a quote → the one wake
  groupMsg(101, TEAM, owner, {
    ...at(' сделай X'),
    reply_to_message: { message_id: 100, date: NOW_S, chat: { id: TEAM, type: 'supergroup' }, from: { id: MEMBER, is_bot: false, first_name: 'Член', username: 'member_u' }, text: 'исходное сообщение' },
    quote: { text: 'исходное', position: 0 },
  }),
  groupMsg(102, TEAM, owner, { text: 'просто пишу' }), // owner, no @
  groupMsg(103, TEAM, owner, { text: 'да', reply_to_message: { message_id: 90, date: NOW_S, chat: { id: TEAM, type: 'supergroup' }, from: botUser, text: 'вопрос бота' } }), // reply to bot, no @
  groupMsg(104, TEAM, member, at(' сделай Y')), // member @
  groupMsg(105, TEAM, member, voice('V105')), // member voice
  groupMsg(106, TEAM, owner, voice('V106')), // owner voice, no @
  groupMsg(107, TEAM, member, { text: 'пересланное', forward_origin: { type: 'user', date: NOW_S - 3600, sender_user: { id: 555, is_bot: false, first_name: 'Third', username: 'third' } } }),
  groupMsg(108, TEAM, member, { text: 'ответ', reply_to_message: { message_id: 102, date: NOW_S, chat: { id: TEAM, type: 'supergroup' }, from: { id: OWNER, is_bot: false, first_name: 'Артём', username: 'owner_u' }, text: 'просто пишу' }, quote: { text: 'пишу', position: 7 } }),
  groupMsg(109, TEAM, owner, { ...voice('V109'), caption: `@${BOT} глянь`, caption_entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] }), // owner voice + @ → wake
  groupMsg(110, TEAM, member, { text: 'в General' }, null), // General: no thread
  groupMsg(111, TEAM, owner, { photo: [{ file_id: 'P111', file_unique_id: 'uP111', width: 9, height: 9, file_size: 5 }] }), // owner photo, no @
  groupMsg(112, TEAM, owner, { ...at(' переслал'), forward_origin: { type: 'hidden_user', date: NOW_S - 60, sender_user_name: 'Скрыт' } }), // owner forward with @
  // reaction: his 👍 on a bot message in the team group → nothing
  {
    update_id: 113,
    message_reaction: {
      chat: { id: TEAM, type: 'supergroup', title: 't', is_forum: true },
      message_id: 90,
      user: { id: OWNER, is_bot: false, first_name: 'Артём' },
      date: NOW_S,
      old_reaction: [],
      new_reaction: [{ type: 'emoji', emoji: '👍' }],
    },
  },
  // existing group: a member's plain message → archived, not delivered (old fields byte-equal)
  groupMsg(120, OLD, member, { text: 'старая группа' }, null),
  // positive control: existing contextBuffer group, a member's @ → delivered WITH the buffer block
  groupMsg(130, BUF, member, at(' привет'), null),
  // DM from the owner (old fields byte-equal)
  { update_id: 140, message: { message_id: 140, date: NOW_S, chat: { id: OWNER, type: 'private' }, from: { is_bot: false, ...owner }, text: 'в личке' } },
]

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tg-team-group-e2e-'))
  const stateDir = join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: [String(OWNER)],
    ackReaction: '👀',
    // mentionPatterns would match «просто пишу» if consulted
    mentionPatterns: ['просто'],
    groups: {
      [String(TEAM)]: { team: true, requireMention: true, allowFrom: ['none'], contextBuffer: true },
      [String(OLD)]: { requireMention: true, allowFrom: [] },
      [String(BUF)]: { requireMention: true, allowFrom: [], contextBuffer: true },
    },
    pending: {},
  }))
  // Stale buffer files: the team wake must ignore its own; the control group must carry its own.
  const bufDir = join(stateDir, 'group-buffer')
  mkdirSync(bufDir, { recursive: true })
  const stale = JSON.stringify({ ts: new Date((NOW_S - 100) * 1000).toISOString(), senderName: 'old', text: 'STALE-BUFFER-LINE' }) + '\n'
  writeFileSync(join(bufDir, `${String(TEAM)}.jsonl`), stale)
  writeFileSync(join(bufDir, `${String(BUF)}.jsonl`), stale)
  const data = join(dir, 'Workspace', 'ClaudeProjects', 'sam-data')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({ user: { telegram_chat_id: String(OWNER) } }))
  archive = join(data, 'state', 'tg-archive')

  const callsLog = join(dir, 'calls.log')
  writeFileSync(callsLog, '')
  const preload = join(dir, 'fake-bot-api.ts')
  writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
const CALLS_LOG = ${JSON.stringify(callsLog)}
const UPDATES = ${JSON.stringify(UPDATES)}
let served = false
const fake = async (url: any, init?: any) => {
  const u = String(url)
  if (u.includes('/file/bot')) return new Response('BYTES ' + u.split('/').pop())
  const method = u.split('/').pop()!
  let payload: any = {}
  try { payload = JSON.parse(init?.body ?? '{}') } catch {}
  appendFileSync(CALLS_LOG, method + (payload.message_id != null ? ' ' + payload.message_id : '') + (payload.file_id ? ' ' + payload.file_id : '') + '\\n')
  let result: unknown = true
  if (method === 'getMe') result = ${JSON.stringify(botUser)}
  else if (method === 'getUpdates') {
    if (!served) { served = true; result = UPDATES }
    else { await new Promise(r => setTimeout(r, 300)); result = [] }
  } else if (method === 'getFile') {
    const ext = payload.file_id.startsWith('P') ? 'jpg' : 'oga'
    result = { file_id: payload.file_id, file_unique_id: 'u' + payload.file_id, file_size: 5, file_path: 'files/' + payload.file_id + '.' + ext }
  } else if (method.startsWith('send')) {
    result = { message_id: 900, date: ${NOW_S}, chat: { id: Number(payload.chat_id), type: 'supergroup' }, text: payload.text }
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
  await new Promise(r => setTimeout(r, 4500))
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

const linesOf = (chat: number): Record<string, unknown>[] => {
  const d = join(archive, String(chat))
  if (!existsSync(d)) return []
  return readdirSync(d)
    .filter(n => /^\d{4}-\d{2}\.jsonl$/.test(n))
    .flatMap(n => readFileSync(join(d, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
}
const line = (chat: number, id: number) => linesOf(chat).find(l => l.msg_id === id)
const kept = (chat: number) => {
  const d = join(archive, String(chat), 'files')
  return existsSync(d) ? readdirSync(d).sort() : []
}
const notifIds = () => notifications.map(n => n.meta.message_id).filter(Boolean)
const metaOf = (id: number) => notifications.find(n => n.meta.message_id === String(id))

describe('team group — wake (AC-01 wiring, OB-03)', () => {
  test('the server polled', () => {
    expect(calls, stderr).toContain('getUpdates')
  })

  test('exactly the owner\'s own @ messages wake (text 101, voice+caption 109); every other team message does not', () => {
    const team = notifications.filter(n => n.meta.chat_id === String(TEAM))
    expect(team.map(n => n.meta.message_id).sort(), stderr).toEqual(['101', '109'])
    for (const id of [102, 103, 104, 105, 106, 107, 108, 110, 111, 112]) expect(notifIds()).not.toContain(String(id))
  })

  test('👀 only on the wake messages: no ack on his no-@ / reply-to-bot / forward, no ack on a member\'s @', () => {
    const acks = calls.filter(c => c.startsWith('setMessageReaction')).map(c => c.split(' ')[1])
    expect(acks).toContain('101')
    expect(acks).toContain('109')
    for (const id of ['102', '103', '104', '112']) expect(acks).not.toContain(id)
  })

  test('no bot reply to anyone in the team group', () => {
    expect(calls.filter(c => c.startsWith('sendMessage'))).toEqual([])
  })

  test('his 👍 on a bot message in the team group reaches nothing (AC-02)', () => {
    expect(notifications.filter(n => n.meta.event === 'reaction')).toEqual([])
  })
})

describe('team group — envelope (AC-04, OB-04)', () => {
  test('carries group_mode="team", the topic, reply_to_* and the quote', () => {
    const m = metaOf(101)!.meta
    expect(m).toMatchObject({
      chat_id: String(TEAM),
      user_id: String(OWNER),
      group_mode: 'team',
      message_thread_id: String(TOPIC),
      reply_to_message_id: '100',
      reply_to_text: 'исходное сообщение',
      reply_to_user: 'member_u',
      reply_to_quote: 'исходное',
    })
  })

  test('no <group-context-buffer> block even with contextBuffer:true and a stale buffer file', () => {
    expect(metaOf(101)!.content).toBe(`@${BOT} сделай X`)
    for (const n of notifications.filter(n => n.meta.chat_id === String(TEAM))) {
      expect(n.content).not.toContain('group-context-buffer')
      expect(n.content).not.toContain('STALE-BUFFER-LINE')
    }
  })

  test('positive control: an existing contextBuffer group still carries its buffer; no group_mode there', () => {
    const n = metaOf(130)!
    expect(n.content).toContain('<group-context-buffer')
    expect(n.content).toContain('STALE-BUFFER-LINE')
    expect('group_mode' in n.meta).toBe(false)
  })

  test('a DM envelope carries no group_mode', () => {
    expect('group_mode' in metaOf(140)!.meta).toBe(false)
  })
})

describe('team group — archive (AC-03, OB-01)', () => {
  test('every team message has exactly one line, the wakes included', () => {
    const ids = linesOf(TEAM).map(l => l.msg_id).sort()
    expect(ids).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112])
  })

  test('author fields: sender_id, senderName, sender_display', () => {
    expect(line(TEAM, 104)).toMatchObject({ sender_id: String(MEMBER), senderName: 'member_u', sender_display: 'Член Команды', thread_id: TOPIC, kind: 'text' })
  })

  test('a forward from a user: forward_* on the line', () => {
    expect(line(TEAM, 107)).toMatchObject({
      forward_origin: 'forward_user',
      forward_author: 'third',
      forward_author_id: '555',
      forward_date: new Date((NOW_S - 3600) * 1000).toISOString(),
    })
  })

  test('his forward with @ is archived with its hidden-user origin', () => {
    const l = line(TEAM, 112)!
    expect(l).toMatchObject({ forward_origin: 'forward_hidden_user', forward_author: 'Скрыт' })
    expect('forward_author_id' in l).toBe(false)
  })

  test('a reply with a quote: reply_to_* and the quote', () => {
    expect(line(TEAM, 108)).toMatchObject({ reply_to_message_id: '102', reply_to_text: 'просто пишу', reply_to_user: 'owner_u', reply_to_quote: 'пишу' })
  })

  test('a topic message replying to nothing (target = the topic root) carries no reply_to_*', () => {
    const l = line(TEAM, 102)!
    expect(l.thread_id).toBe(TOPIC)
    expect(Object.keys(l).filter(k => k.startsWith('reply_to'))).toEqual([])
  })

  test('General: no thread_id', () => {
    expect('thread_id' in line(TEAM, 110)!).toBe(false)
  })

  test('a DM line and an existing-group line keep their old fields byte-equal (old keys first, same values)', () => {
    const ts = new Date(NOW_S * 1000).toISOString()
    const dm = line(OWNER, 140)!
    expect(Object.keys(dm).slice(0, 7)).toEqual(['ts', 'senderName', 'text', 'chat_id', 'msg_id', 'sender_id', 'kind'])
    expect(dm).toMatchObject({ ts, senderName: 'owner_u', text: 'в личке', chat_id: String(OWNER), msg_id: 140, sender_id: String(OWNER), kind: 'text' })
    const old = line(OLD, 120)!
    expect(Object.keys(old).slice(0, 7)).toEqual(['ts', 'senderName', 'text', 'chat_id', 'msg_id', 'sender_id', 'kind'])
    expect(old).toMatchObject({ ts, senderName: 'member_u', text: 'старая группа', chat_id: String(OLD), msg_id: 120, sender_id: String(MEMBER), kind: 'text' })
    // the existing group is not woken by a plain member message
    expect(notifIds()).not.toContain('120')
  })
})

describe('team group — kept files (AC-05, OB-02)', () => {
  test('member voice → kept', () => {
    expect(kept(TEAM)).toContain('105.oga')
  })

  test('his archive-only voice and photo → kept', () => {
    expect(kept(TEAM)).toContain('106.oga')
    expect(kept(TEAM)).toContain('111.jpg')
  })

  test('his delivered voice → not kept in the store (delivery keeps it, as today)', () => {
    expect(kept(TEAM).filter(n => n.startsWith('109.'))).toEqual([])
  })
})

test('live archive dir untouched by this file (mtime)', () => {
  expect(liveStamp()).toBe(LIVE_BEFORE)
})
