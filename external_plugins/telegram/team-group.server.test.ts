/**
 * Team group (`team: true`) — server.ts wiring end to end: the real server.ts against a fake Bot API
 * (preload; no network, no real token). Spec: sam-data dev/analysis/2026-11-18-tg-bot-team-group-spec.md
 * AC-01 (gate wiring), AC-02 (reaction), AC-03 (archive line), AC-04 (envelope, no buffer), AC-05 (keeper).
 *
 * STATE ISOLATION (dev-rules §1.2): HOME, TELEGRAM_STATE_DIR and IDEA_INBOX_DIR are under a fresh mkdtemp dir,
 * and the preload points access-lock.ts's LOCK_DIR (and so the co-owners file) at a path inside it that does not
 * exist (r1 f14, the access-lock.server.test.ts seam; production code has no seam): the real home, the live
 * archive and /etc/sam-telegram-access are never read or written.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const OWNER = 111111111
const MEMBER = 444444444
const BOT_ID = 1
const BOT = 'test_bot'
const TEAM = -1001112223334
const TEAM2 = -1001112229999 // a team group whose archive month file cannot be written (r1 f4)
const OLD = -1005556667778 // an existing group: requireMention, everyone allowed, no buffer
const BUF = -1009990001112 // positive control: an existing group with contextBuffer + a stale buffer
const TOPIC = 7
// Topic-name spec (sam-data dev/analysis/2026-11-19-tg-topic-name-spec.md) AC-01..AC-05: own chats, so the
// exhaustive TEAM assertions below stay as they were.
const TNAME = -1001112227777 // a team group: names learned from roots and service messages
const TRO = -1001112226666 // a team group whose archive chat folder is read-only
const UNLISTED = -1001112225555 // not in access.groups: its service messages teach nothing
const NOW_S = Math.floor(Date.now() / 1000)
const MONTH = new Date(NOW_S * 1000).toISOString().slice(0, 7)

let dir: string
let archive: string
let ideaDir: string
let notifications: { content: string; meta: Record<string, string> }[] = []
let calls: string[] = []
let stderr = ''

type From = { id: number; first_name: string; last_name?: string; username?: string; is_bot?: boolean }
const owner: From = { id: OWNER, first_name: 'Владелец', last_name: 'Бота', username: 'owner_u' }
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
const rootOf = (chat: number, thread: number, name: string) =>
  ({ message_id: thread, date: NOW_S, chat: { id: chat, type: 'supergroup' }, from: botUser, forum_topic_created: { name, icon_color: 1 } })
const replyTo = (chat: number, id: number) =>
  ({ message_id: id, date: NOW_S, chat: { id: chat, type: 'supergroup' }, from: { id: MEMBER, is_bot: false, first_name: 'Член' }, text: 'другое' })
const HOSTILE = 'a<b>[c];d\re\nf'
const voice = (id: string) => ({ voice: { file_id: id, file_unique_id: 'u' + id, duration: 2, file_size: 5 } })

// r2 f3: one fixture per fallback content kind (server.ts OTHER_CONTENT_KINDS) — kind → its update id. The coverage
// test below reads OTHER_CONTENT_KINDS from server.ts itself, so a kind added there without a fixture here fails.
const FALLBACK_KINDS: Record<string, number> = {
  dice: 115, game: 116, story: 117, paid_media: 118, animation: 125, giveaway: 126, giveaway_winners: 127, checklist: 128,
}

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
  groupMsg(108, TEAM, member, { text: 'ответ', reply_to_message: { message_id: 102, date: NOW_S, chat: { id: TEAM, type: 'supergroup' }, from: { id: OWNER, is_bot: false, first_name: 'Владелец', username: 'owner_u' }, text: 'просто пишу' }, quote: { text: 'пишу', position: 7 } }),
  groupMsg(109, TEAM, owner, { ...voice('V109'), caption: `@${BOT} глянь`, caption_entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] }), // owner voice + @ → wake
  groupMsg(110, TEAM, member, { text: 'в General' }, null), // General: no thread
  groupMsg(111, TEAM, owner, { photo: [{ file_id: 'P111', file_unique_id: 'uP111', width: 9, height: 9, file_size: 5 }] }), // owner photo, no @
  groupMsg(112, TEAM, owner, { ...at(' переслал'), forward_origin: { type: 'hidden_user', date: NOW_S - 60, sender_user_name: 'Скрыт' } }), // owner forward with @
  // r1 f1: his from.id, but an inline-bot result (via_bot) carrying a valid @<bot> → archive only
  groupMsg(114, TEAM, owner, { ...at(' от инлайн-бота'), via_bot: { id: 77, is_bot: true, first_name: 'gif', username: 'gif' } }),
  // r1 f3: content kinds with no handler of their own → one archive line each, no wake
  groupMsg(115, TEAM, owner, { dice: { emoji: '🎲', value: 3 } }),
  groupMsg(116, TEAM, member, { game: { title: 'g', description: 'd', photo: [] } }),
  groupMsg(117, TEAM, member, { story: { chat: { id: 5, type: 'private' }, id: 1 } }),
  groupMsg(118, TEAM, member, { paid_media: { star_count: 1, paid_media: [] } }),
  groupMsg(119, TEAM, member, { animation: { file_id: 'A119', file_unique_id: 'uA', width: 1, height: 1, duration: 1 }, document: { file_id: 'A119', file_unique_id: 'uA' } }),
  // r2 f3: a bare animation (no document), a giveaway, its winners, a checklist → the fallback, one line each
  groupMsg(125, TEAM, member, { animation: { file_id: 'A125', file_unique_id: 'uA125', width: 1, height: 1, duration: 1 } }),
  groupMsg(126, TEAM, member, { giveaway: { chats: [{ id: -1007, type: 'channel', title: 'c' }], winners_selection_date: NOW_S + 60, winner_count: 1 } }),
  groupMsg(127, TEAM, member, { giveaway_winners: { chat: { id: -1007, type: 'channel', title: 'c' }, giveaway_message_id: 3, winners_selection_date: NOW_S, winner_count: 1, winners: [{ id: 9, is_bot: false, first_name: 'w' }] } }),
  groupMsg(128, TEAM, owner, { checklist: { title: 'список', tasks: [{ id: 1, text: 'пункт' }] } }),
  groupMsg(121, TEAM, member, { location: { latitude: 1, longitude: 2 }, venue: { location: { latitude: 1, longitude: 2 }, title: 'V', address: 'A' } }),
  groupMsg(122, TEAM, member, { new_chat_members: [{ id: 9, is_bot: false, first_name: 'n' }] }), // service: not archived
  groupMsg(123, OLD, member, { dice: { emoji: '🎲', value: 1 } }, null), // another group: unchanged (dropped)
  // r1 f4: archive append throws (the month file is a directory) → his no-@ voice is still kept
  groupMsg(124, TEAM2, owner, voice('V124'), null),
  // reaction: his 👍 on a bot message in the team group → nothing
  {
    update_id: 113,
    message_reaction: {
      chat: { id: TEAM, type: 'supergroup', title: 't', is_forum: true },
      message_id: 90,
      user: { id: OWNER, is_bot: false, first_name: 'Владелец' },
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
  // ── topic names (topic-name spec) ──
  // AC-01: his @ in topic 26, the root says «Отчёты», nothing stored
  groupMsg(150, TNAME, owner, { ...at(' отчёт'), reply_to_message: rootOf(TNAME, 26, 'Отчёты') }, 26),
  // AC-02: a reply to another message in topic 26 (no root) — «Отчёты» is stored by now
  groupMsg(151, TNAME, owner, { ...at(' ещё'), reply_to_message: replyTo(TNAME, 150) }, 26),
  // AC-02: a reply to another message in topic 27 (no root), nothing stored there
  groupMsg(152, TNAME, owner, { ...at(' там'), reply_to_message: replyTo(TNAME, 140) }, 27),
  // AC-03: renamed, then an icon-only edit, then a new topic is created — no line, no wake for any of them
  groupMsg(153, TNAME, owner, { forum_topic_edited: { name: 'Отчёты Q4' }, reply_to_message: rootOf(TNAME, 26, 'Отчёты') }, 26),
  groupMsg(154, TNAME, owner, { forum_topic_edited: { icon_custom_emoji_id: '5' }, reply_to_message: rootOf(TNAME, 26, 'Отчёты') }, 26),
  groupMsg(155, TNAME, owner, { forum_topic_created: { name: 'Новая', icon_color: 1 }, reply_to_message: undefined }, 155),
  // AC-03: the next message in 26, its root still says «Отчёты»
  groupMsg(156, TNAME, owner, { ...at(' после'), reply_to_message: rootOf(TNAME, 26, 'Отчёты') }, 26),
  // AC-04: a hostile name on the root, and one of spaces
  groupMsg(157, TNAME, owner, { ...at(' x'), reply_to_message: rootOf(TNAME, 40, HOSTILE) }, 40),
  groupMsg(158, TNAME, owner, { ...at(' y'), reply_to_message: rootOf(TNAME, 41, '   ') }, 41),
  // AC-05: a service message in a chat absent from access.groups
  groupMsg(159, UNLISTED, owner, { forum_topic_created: { name: 'Чужая', icon_color: 1 }, reply_to_message: undefined }, 159),
  // AC-05: a read-only chat folder — the wake still carries the root's name
  groupMsg(160, TRO, owner, { ...at(' ro'), reply_to_message: rootOf(TRO, 5, 'RO') }, 5),
  // AC-05: a non-forum group reply carrying message_thread_id but no root
  groupMsg(161, OLD, member, { ...at(' в старой'), reply_to_message: replyTo(OLD, 99) }, 99),
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
      // r1 f2: asyncThreads on his wake topic must not turn his @ into an idea capture
      [String(TEAM)]: { team: true, requireMention: true, allowFrom: ['none'], contextBuffer: true, asyncThreads: [String(TOPIC)] },
      [String(TEAM2)]: { team: true, requireMention: true, allowFrom: ['none'] },
      [String(TNAME)]: { team: true, requireMention: true, allowFrom: ['none'] },
      [String(TRO)]: { team: true, requireMention: true, allowFrom: ['none'] },
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
  mkdirSync(join(archive, String(TEAM2), `${MONTH}.jsonl`), { recursive: true }) // r1 f4: appendArchive throws there
  mkdirSync(join(archive, String(TRO)), { recursive: true })
  chmodSync(join(archive, String(TRO)), 0o500) // topic-name AC-05: topics.json cannot be written there
  ideaDir = join(dir, 'ideas')
  mkdirSync(ideaDir, { recursive: true })

  const callsLog = join(dir, 'calls.log')
  writeFileSync(callsLog, '')
  const preload = join(dir, 'fake-bot-api.ts')
  writeFileSync(preload, /* ts */ `
import { appendFileSync } from 'fs'
import { plugin } from 'bun'
// r1 f14: LOCK_DIR (and the co-owners file under it) → a path inside the test dir that does not exist.
plugin({
  name: 'test-lock-dir',
  setup(build) {
    build.onLoad({ filter: /access-lock\\.ts$/ }, async args => {
      const src = await Bun.file(args.path).text()
      const out = src.replace("'/etc/sam-telegram-access'", ${JSON.stringify(JSON.stringify(join(dir, 'no-lock')))})
      if (out === src) throw new Error('test preload: LOCK_DIR constant not found')
      return { contents: out, loader: 'ts' }
    })
  },
})
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
      IDEA_INBOX_DIR: ideaDir,
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
  chmodSync(join(archive, String(TRO)), 0o700)
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
    for (const id of [102, 103, 104, 105, 106, 107, 108, 110, 111, 112, 114, 115, 116, 117, 118, 119, 121, 122, 123, 124, 125, 126, 127, 128]) {
      expect(notifIds()).not.toContain(String(id))
    }
  })

  test('r1 f2: his @ in an asyncThreads topic of the team group still wakes; nothing became an idea', () => {
    expect(notifIds()).toContain('101')
    const ideas = existsSync(ideaDir) ? readdirSync(ideaDir, { recursive: true }).map(String) : []
    expect(ideas.filter(n => n.endsWith('.json') || n.endsWith('.md'))).toEqual([])
  })

  test('👀 only on the wake messages: no ack on his no-@ / reply-to-bot / forward, no ack on a member\'s @', () => {
    const acks = calls.filter(c => c.startsWith('setMessageReaction')).map(c => c.split(' ')[1])
    expect(acks).toContain('101')
    expect(acks).toContain('109')
    for (const id of ['102', '103', '104', '112', '114', '115']) expect(acks).not.toContain(id)
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
    expect(ids).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 114, 115, 116, 117, 118, 119, 121, 125, 126, 127, 128])
  })

  test('r1 f1: the inline-bot result is archived with via_bot', () => {
    expect(line(TEAM, 114)).toMatchObject({ sender_id: String(OWNER), via_bot: '@gif' })
    expect('via_bot' in line(TEAM, 101)!).toBe(false)
  })

  test('r1 f3: dice / game / story / paid media / animation / venue — one line each, with their kind; service and other-group not archived', () => {
    expect([115, 116, 117, 118].map(id => line(TEAM, id)!.kind)).toEqual(['dice', 'game', 'story', 'paid_media'])
    expect(line(TEAM, 115)!.text).toBe('(dice)')
    expect(line(TEAM, 119)!.kind).toBe('document') // an animation carries document too: that handler archives it
    expect(line(TEAM, 121)!.kind).toBe('location')
    expect(line(TEAM, 122)).toBeUndefined()
    expect(line(OLD, 123)).toBeUndefined()
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

describe('team group — r2 f3 fallback content kinds, exhaustive', () => {
  test('the tested kinds are exactly server.ts OTHER_CONTENT_KINDS', () => {
    const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    const m = src.match(/const OTHER_CONTENT_KINDS = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    const kinds = [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]).sort()
    expect(kinds.length).toBeGreaterThan(0)
    expect(Object.keys(FALLBACK_KINDS).sort()).toEqual(kinds)
  })

  for (const [kind, id] of Object.entries(FALLBACK_KINDS)) {
    test(`${kind} (${id}): exactly one archive line with its kind, no notification, no reaction`, () => {
      const rows = linesOf(TEAM).filter(l => l.msg_id === id)
      expect(rows.length).toBe(1)
      expect(rows[0]).toMatchObject({ kind, text: `(${kind})` })
      expect(notifIds()).not.toContain(String(id))
      expect(calls.filter(c => c.startsWith('setMessageReaction')).map(c => c.split(' ')[1])).not.toContain(String(id))
    })
  }
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

  test('rr3-1: his archive-only voice and photo rows carry archive_only:true (the catch-up retry signal); delivered and member rows do not', () => {
    expect(line(TEAM, 106)?.archive_only).toBe(true)
    expect(line(TEAM, 111)?.archive_only).toBe(true)
    expect('archive_only' in (line(TEAM, 109) ?? {})).toBe(false)
    expect('archive_only' in (line(TEAM, 105) ?? {})).toBe(false)
  })

  test('r1 f4: the archive append threw, the keeper still kept his no-@ voice', () => {
    expect(stderr).toContain('tg-archive append failed')
    expect(kept(TEAM2)).toContain('124.oga')
  })
})

describe('topic names in the wake and the archive (topic-name spec AC-01..AC-05)', () => {
  const topics = (chat: number) => {
    const p = join(archive, String(chat), 'topics.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined
  }
  const keysOf = (o: Record<string, unknown>) => Object.keys(o)

  test('AC-01: root «Отчёты», empty store → wake topic_name right after message_thread_id, row too, topics.json holds it', () => {
    const m = metaOf(150)!.meta
    expect(m).toMatchObject({ message_thread_id: '26', topic_name: 'Отчёты' })
    const k = keysOf(m)
    expect(k.indexOf('topic_name')).toBe(k.indexOf('message_thread_id') + 1)
    expect(line(TNAME, 150)).toMatchObject({ thread_id: 26, topic_name: 'Отчёты' })
  })

  test('AC-02: no root + nothing stored → no key in wake or row; no root + «Отчёты» stored → both carry it', () => {
    expect('topic_name' in metaOf(152)!.meta).toBe(false)
    expect('topic_name' in line(TNAME, 152)!).toBe(false)
    expect(metaOf(151)!.meta.topic_name).toBe('Отчёты')
    expect(line(TNAME, 151)!.topic_name).toBe('Отчёты')
  })

  test('AC-03: rename → store says «Отчёты Q4», the next message (root still «Отчёты») carries «Отчёты Q4»; icon-only edit changes nothing; created → stored', () => {
    const t = topics(TNAME)
    expect(t['26'].name).toBe('Отчёты Q4')
    expect(t['155'].name).toBe('Новая')
    expect(metaOf(156)!.meta.topic_name).toBe('Отчёты Q4')
    expect(line(TNAME, 156)!.topic_name).toBe('Отчёты Q4')
  })

  test('AC-03: the three service messages → no archive line, no wake, no 👀', () => {
    const acks = calls.filter(c => c.startsWith('setMessageReaction')).map(c => c.split(' ')[1])
    for (const id of [153, 154, 155, 159]) {
      expect(line(TNAME, id)).toBeUndefined()
      expect(notifIds()).not.toContain(String(id))
      expect(acks).not.toContain(String(id))
    }
  })

  test('AC-04: <>[];CR LF → _ in the wake and the row; a name of spaces → no attribute', () => {
    expect(metaOf(157)!.meta.topic_name).toBe('a_b__c__d_e_f')
    expect(line(TNAME, 157)!.topic_name).toBe('a_b__c__d_e_f')
    expect('topic_name' in metaOf(158)!.meta).toBe(false)
    expect('topic_name' in line(TNAME, 158)!).toBe(false)
  })

  test('AC-05: General, a DM, a non-forum reply with message_thread_id → no topic_name in wake or row', () => {
    expect('topic_name' in line(TEAM, 110)!).toBe(false)
    expect('topic_name' in metaOf(140)!.meta).toBe(false)
    expect('topic_name' in line(OWNER, 140)!).toBe(false)
    expect(metaOf(161)!.meta.message_thread_id).toBe('99')
    expect('topic_name' in metaOf(161)!.meta).toBe(false)
    expect('topic_name' in line(OLD, 161)!).toBe(false)
    expect(existsSync(join(archive, String(OWNER), 'topics.json'))).toBe(false)
  })

  test('AC-05: a service message in a chat absent from access.groups → no topics.json', () => {
    expect(existsSync(join(archive, String(UNLISTED), 'topics.json'))).toBe(false)
  })

  test('AC-05: a read-only chat folder → one stderr line, the wake still delivered with the root\'s name', () => {
    expect(metaOf(160)!.meta.topic_name).toBe('RO')
    expect(stderr.split('\n').filter(l => l.includes('topics.json') && l.includes(String(TRO))).length).toBe(1)
  })
})
