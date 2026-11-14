// «Да / Нет» buttons under a binary question to the owner (D-890; spec sam-data
// dev/analysis/2026-11-01-yes-no-buttons-spec.md).
//
// Send: the reply tool's `yes_no: true` puts ONE keyboard row «Да» «Нет» on the
// message — only when the setting `yes-no-buttons` is on: core default
// (tools/config-defaults.json) ⊕ the person's sam-data override, resolved by core
// itself (`tools/sam_data.py config-get`; owner tg 41857). Off → a plain message.
// Press: accepted only from the owner (config.json user.telegram_chat_id) or a
// co-owner (the admin's /etc/sam-telegram-access/co-owners, read fresh per press;
// spec sam-data dev/analysis/2026-11-04-yes-no-co-owner-spec.md), in their own DM or a group of the
// access list that lets them in (pressCounts; D-1049, spec sam-data
// dev/specs/2026-11-14-buttons-in-groups-spec.md), and only for a button that very message carries
// (callback data checked against its reply_markup). The send side asks the same predicate
// (buttonsCanCount): no keyboard where no press could count. One buttons.log line per press.
// It reaches the session as the SAME reaction envelope his 👍/👎 makes,
// plus `via="button"`, so every 👍/👎 reader works unchanged; tools/owner_approval.py
// check_thumbs refuses it by default and counts it only where a rail opts in (invite-mint).
// The press never feeds the secretary preview or the signed approval side-channel.
//
// «Готово» (spec sam-data dev/analysis/2026-11-08-buttons-da-gotovo-spec.md §2.4): the reply
// tool's `done_button: "<label>"` puts ONE button under a «do X, tell me» message, same switch,
// same press rules. Its press arrives as the same envelope with ✅ (never 👍/👎) + via="button",
// so «сделал» can never pass as «да»: no approval rail reads ✅.
//
// Pure + injected effects (no grammy import), so it is unit-testable.

import { spawnSync } from 'child_process'
import { closeSync, openSync, readSync } from 'fs'
import { join } from 'path'
import { LOCK_DIR } from './access-lock'
import { type GroupGatePolicy, groupReactionAllowed } from './group-access'
import { createStateLineWriter } from './state-line'
import { type UiLang, captions } from './ui-lang'

export const YES_NO_SWITCH = 'yes-no-buttons'
export const YES = 'yn:y'
export const NO = 'yn:n'
export const ANSWERED = 'yn:x'
export const DONE = 'yn:d'
export const DONE_LABEL_MAX = 32 // our cap, in characters (code points)
export const DONE_MARK = '✅'

export type Choice = 'y' | 'n' | 'd'
export type Button = { text: string; callback_data: string }

/** Core lives next to sam-data on every install (tools/start-sam.sh, the container image). */
export function coreDirOf(home: string): string {
  return join(home, 'Workspace', 'ClaudeProjects', 'sam-core')
}

/** The setting's effective value through core's one resolution (default ⊕ valid override):
 * `python3 <core>/tools/sam_data.py config-get yes-no-buttons` under HOME=home. ON only when it
 * prints exactly `true`. Any failure (no core / python, timeout, exit≠0, other output) → OFF:
 * the message goes plain and the answer comes by 👍/👎 or text — with one stderr line. */
export function yesNoButtonsOn(home: string, coreDir: string = coreDirOf(home)): boolean {
  const r = spawnSync('python3', [join(coreDir, 'tools', 'sam_data.py'), 'config-get', YES_NO_SWITCH], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  })
  const out = (r.stdout ?? '').trim()
  if (r.status === 0 && (out === 'true' || out === 'false')) return out === 'true'
  const why = r.error ? String(r.error) : `exit ${r.status}: ${(r.stderr ?? '').trim().slice(0, 200)}`
  process.stderr.write(`telegram channel: yes-no-buttons unresolved (${why}) — buttons off, plain text\n`)
  return false
}

/** Validates the reply args. Returns true when buttons were asked for. Throws on a forbidden combination. */
export function wantsYesNo(args: {
  yes_no?: unknown
  checklist?: unknown
  files?: unknown[]
  voice?: unknown
  as_owner_to?: unknown
}): boolean {
  if (args.yes_no == null || args.yes_no === false) return false
  if (args.yes_no !== true) throw new Error('yes_no must be a boolean')
  const clash: string[] = []
  if (Array.isArray(args.checklist) ? args.checklist.length > 0 : args.checklist != null) clash.push('checklist')
  if ((args.files ?? []).length > 0) clash.push('files')
  if (args.voice === true) clash.push('voice')
  if (args.as_owner_to != null) clash.push('as_owner_to (secretary)')
  if (clash.length) throw new Error(`yes_no cannot be combined with ${clash.join(', ')} — send those as a separate reply`)
  return true
}

/** Validates the reply args for the «Готово» button. Returns its label, or null when not asked for.
 * Throws on a bad label or a forbidden combination (the same five as yes_no, plus yes_no itself). */
export function wantsDoneButton(args: {
  done_button?: unknown
  yes_no?: unknown
  checklist?: unknown
  files?: unknown[]
  voice?: unknown
  as_owner_to?: unknown
}): string | null {
  if (args.done_button == null) return null
  if (typeof args.done_button !== 'string') throw new Error('done_button must be a string (the button label)')
  // One line: no control character (C0, DEL, C1 — incl. CR, LF, VT, FF, NEL) and no line / paragraph separator.
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(args.done_button)) throw new Error('done_button must be one line (no control or line-separator characters)')
  const label = args.done_button.trim()
  if (label === '') throw new Error('done_button must not be empty')
  if ([...label].length > DONE_LABEL_MAX) throw new Error(`done_button must be at most ${DONE_LABEL_MAX} characters`)
  const clash: string[] = []
  if (args.yes_no != null && args.yes_no !== false) clash.push('yes_no')
  if (Array.isArray(args.checklist) ? args.checklist.length > 0 : args.checklist != null) clash.push('checklist')
  if ((args.files ?? []).length > 0) clash.push('files')
  if (args.voice === true) clash.push('voice')
  if (args.as_owner_to != null) clash.push('as_owner_to (secretary)')
  if (clash.length) throw new Error(`done_button cannot be combined with ${clash.join(', ')} — send those as a separate reply`)
  return label
}

/** One row, one button: the label (e.g. «Готово», «Вошёл»). */
export function doneKeyboard(label: string): Button[][] {
  return [[{ text: label, callback_data: DONE }]]
}

/** One row, two columns: «Да» «Нет» — captions in the person's language (ui-lang.ts); data unchanged. */
export function yesNoKeyboard(lang: UiLang): Button[][] {
  const c = captions(lang)
  return [[{ text: c.yes, callback_data: YES }, { text: c.no, callback_data: NO }]]
}

/** After a press: one inert button showing the choice (for «Готово»: «✅ <label>»), in the person's language. */
export function answeredKeyboard(choice: Choice, lang: UiLang, doneLabel: string = captions(lang).done): Button[][] {
  const c = captions(lang)
  const text = choice === 'y' ? `✅ ${c.yes}` : choice === 'n' ? `❌ ${c.no}` : `${DONE_MARK} ${doneLabel}`
  return [[{ text, callback_data: ANSWERED }]]
}

/** The pressed «Готово» button's label, as Telegram returns it with the message; absent → the language's «done». */
export function doneLabelOf(m: PressInput['message'], lang: UiLang): string {
  for (const row of m?.reply_markup?.inline_keyboard ?? []) {
    for (const b of row) {
      if (b.callback_data === DONE && typeof b.text === 'string' && b.text.trim() !== '') return b.text.trim()
    }
  }
  return captions(lang).done
}

export function parseYesNoData(data: string): Choice | 'x' | null {
  if (data === YES) return 'y'
  if (data === NO) return 'n'
  if (data === DONE) return 'd'
  if (data === ANSWERED) return 'x'
  return null
}

export const SUFFIX_ON = ' +yes/no buttons'
export const SUFFIX_OFF = ' — yes/no buttons are off on this install; the answer comes by 👍/👎 or text'
export const SUFFIX_DONE_ON = ' +done button'
export const SUFFIX_DONE_OFF = ' — button off, answer by text'
export const SUFFIX_NOT_HERE = ' — no yes/no buttons: a press would not count in this chat; the answer comes by 👍/👎 or text'
export const SUFFIX_DONE_NOT_HERE = ' — no button: a press would not count in this chat, answer by text'

/** The access list in force (server.ts loadAccess(), read fresh — the lock on a client install). */
export type PressAccess = { groups: Record<string, GroupGatePolicy> }

/** THE one rule «a press can count here» (D-1049), used by the press and by the send:
 * the presser's own DM (a private chat's id is the user's id), or a group of the access list in
 * force whose gate already lets that person's reaction reach the session (groupReactionAllowed:
 * allowFrom empty or naming them; wakeOnMention:false → never). */
export function pressCounts(chatId: string | number, presserId: string, access: PressAccess): boolean {
  const chat = String(chatId)
  if (presserId === '') return false
  if (chat === presserId) return true
  const groups = access.groups ?? {}
  if (!Object.prototype.hasOwnProperty.call(groups, chat)) return false
  const policy = groups[chat]
  return policy != null && typeof policy === 'object' && groupReactionAllowed(policy, presserId)
}

/** Send side: buttons go only where a press by the owner or a co-owner could count. */
export function buttonsCanCount(
  chatId: string | number,
  access: PressAccess,
  ownerId: string | undefined,
  coOwners: ReadonlySet<string>,
): boolean {
  if (ownerId && pressCounts(chatId, ownerId, access)) return true
  for (const co of coOwners) if (pressCounts(chatId, co, access)) return true
  return false
}

// ── buttons.log: one line per «Да / Нет» / «Готово» callback (spec §5) ─────────────────────────
// Never message text, a username, a token, or the id of a presser who is not the owner / a co-owner.
export const BUTTONS_LOG = 'buttons.log'
export type PressOutcome =
  | 'accepted'
  | 'refused:not-owner'
  | 'refused:not-here'
  | 'refused:no-message'
  | 'refused:answered'
  | 'refused:not-carried'
export type ButtonLineFields = {
  chatType: string | undefined
  chatId: string | undefined
  topic: boolean
  msg: number | undefined
  data: string
  who: 'owner' | 'co-owner' | 'other'
  outcome: PressOutcome
  answer: string // 'ok' | 'failed:<class>'
  edit?: string // 'failed:<class>' only
  notify?: string // 'failed:<class>' only
}

/** The failure class of a thrown value: its error name (+ Telegram error_code), never its message. */
export function failureClass(err: unknown): string {
  const e = err as { name?: unknown; error_code?: unknown } | null
  const name = typeof e?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.name) ? e.name : 'error'
  const code = typeof e?.error_code === 'number' && Number.isInteger(e.error_code) ? `_${e.error_code}` : ''
  return name + code
}

export function formatButtonLine(tsMs: number, pid: number, f: ButtonLineFields): string {
  const chat = f.chatType === 'private' || f.chatType === 'group' || f.chatType === 'supergroup' ? f.chatType : '-'
  // A private chat's id is its user's id: logged only when that user is the owner / a co-owner.
  const idOk = f.chatId != null && /^-?[0-9]{1,20}$/.test(f.chatId) && !(chat === 'private' && f.who === 'other')
  const chatId = idOk ? f.chatId : '-'
  const msg = f.msg != null && Number.isInteger(f.msg) && f.msg >= 0 ? String(f.msg) : '-'
  const data = /^yn:[ynxd]$/.test(f.data) ? f.data : '-'
  const res = (v: string) => (/^(ok|failed:[A-Za-z0-9_]{1,48})$/.test(v) ? v : 'failed:error')
  return (
    `${new Date(tsMs).toISOString()} pid=${pid} chat=${chat} chat_id=${chatId} topic=${f.topic ? 'y' : 'n'}` +
    ` msg=${msg} data=${data} who=${f.who} outcome=${f.outcome} answer=${res(f.answer)}` +
    (f.edit != null ? ` edit=${res(f.edit)}` : '') +
    (f.notify != null ? ` notify=${res(f.notify)}` : '') +
    '\n'
  )
}

/** Appender for STATE_DIR/buttons.log (0600, append-only, never throws — state-line.ts). */
export function createButtonsLog(opts: {
  stateDir: string
  pid?: number
  nowMs?: () => number
  log?: (line: string) => void
}): (f: ButtonLineFields) => void {
  const pid = opts.pid ?? process.pid
  const now = opts.nowMs ?? Date.now
  const write = createStateLineWriter({ file: join(opts.stateDir, BUTTONS_LOG), goesOn: 'the press goes on', log: opts.log })
  return f => {
    try {
      write(formatButtonLine(now(), pid, f))
    } catch {}
  }
}

export type PressInput = {
  data: string
  from: { id: number; username?: string }
  // callback_query.message; absent when Telegram no longer has it.
  message?: {
    message_id: number
    chat: { id: number; type: string }
    message_thread_id?: number
    is_topic_message?: boolean
    reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] }
  }
}

// The admin's co-owner list (CLAUDE.md §4 «Co-owners on a client install»: the only source,
// read fresh). Rules mirror the status Mini App (sam-core services/status-miniapp
// status_core.parse_co_owners + server.AdminFiles): each trimmed line is one id of 5-20
// digits without a leading 0; ANY other line → no co-owner at all; empty → none.
export const CO_OWNERS_FILE = join(LOCK_DIR, 'co-owners')
export const CO_OWNERS_MAX_BYTES = 4096
const CO_OWNER_ID_RE = /^[1-9][0-9]{4,19}$/

export function parseCoOwners(text: string): { ids: Set<string>; fault: string | null } {
  const lines = text.split(/\r\n|\n|\r/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // trailing newline, as Python splitlines
  const ids = new Set<string>()
  for (const line of lines) {
    const v = line.trim()
    if (!CO_OWNER_ID_RE.test(v)) return { ids: new Set(), fault: 'co_owners_bad_line' }
    ids.add(v)
  }
  return { ids, fault: null }
}

/** Absent → none, silently. Unreadable / not UTF-8 / bad line / over the size cap → none + one logError line. */
export function readCoOwners(path: string, logError: (line: string) => void): Set<string> {
  let fault: string
  try {
    const fd = openSync(path, 'r')
    let n: number
    const buf = Buffer.alloc(CO_OWNERS_MAX_BYTES + 1)
    try {
      n = readSync(fd, buf, 0, buf.length, 0)
    } finally {
      closeSync(fd)
    }
    if (n > CO_OWNERS_MAX_BYTES) {
      fault = 'co_owners_too_big' // a cut line could read as a different, shorter id
    } else {
      const r = parseCoOwners(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)))
      if (r.fault == null) return r.ids
      fault = r.fault
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return new Set()
    fault = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? 'error'
  }
  logError(`telegram channel: co-owners file ${path} ignored (${fault}) — no co-owner may press yes/no`)
  return new Set()
}

export type PressDeps = {
  ownerId: string | undefined
  // The person's language (config user.language through ui-lang.ts uiLang): captions and toasts only.
  lang: UiLang
  // The co-owner ids, read fresh on each call (readCoOwners). Called only for a non-owner press.
  coOwners: () => ReadonlySet<string>
  // The access list in force, read fresh on each press (server.ts loadAccess()).
  access: () => PressAccess
  // One buttons.log line per press (createButtonsLog); absent → no line.
  buttonsLog?: (f: ButtonLineFields) => void
  answer: (text: string) => Promise<unknown>
  editMarkup: (keyboard: Button[][]) => Promise<unknown>
  notify: (n: { content: string; meta: Record<string, string> }) => Promise<unknown>
  now: () => Date
  logError: (line: string) => void
}

/**
 * Handles one callback_query. Returns false when `data` is not a yes/no
 * callback (the caller tries its other branches). Never throws.
 */
export async function handleYesNoPress(p: PressInput, d: PressDeps): Promise<boolean> {
  const choice = parseYesNoData(p.data)
  if (choice == null) return false
  const m = p.message
  const line: ButtonLineFields = {
    chatType: m?.chat.type,
    chatId: m ? String(m.chat.id) : undefined,
    topic: m != null && (m.is_topic_message === true || m.message_thread_id != null),
    msg: m?.message_id,
    data: p.data,
    who: 'other',
    outcome: 'refused:not-owner',
    answer: 'ok',
  }
  try {
    await pressBody(p, d, choice, line)
  } finally {
    try { d.buttonsLog?.(line) } catch {}
  }
  return true
}

async function pressBody(p: PressInput, d: PressDeps, choice: Choice | 'x', line: ButtonLineFields): Promise<void> {
  const toast = (t: string) => d.answer(t).then(() => {}, err => { line.answer = `failed:${failureClass(err)}` })
  const c = captions(d.lang)
  const fromId = String(p.from.id)
  const isOwner = !!d.ownerId && fromId === d.ownerId
  if (isOwner) line.who = 'owner'
  else if (d.coOwners().has(fromId)) line.who = 'co-owner'
  else {
    line.outcome = 'refused:not-owner'
    await toast(c.notAuthorized)
    return
  }
  const m = p.message
  if (m == null) {
    line.outcome = 'refused:no-message'
    await toast(c.noLonger)
    return
  }
  // D-1049: the one rule «a press can count here» — own DM, or a group of the access list that lets them in.
  if (!pressCounts(m.chat.id, fromId, d.access())) {
    line.outcome = 'refused:not-here'
    await toast(c.notAuthorized)
    return
  }
  if (choice === 'x') {
    line.outcome = 'refused:answered'
    await toast(c.alreadyAnswered)
    return
  }
  // The data must be a button this very message carries (as Telegram returns it): a forged `yn:y` on a message
  // with only «Готово», with no keyboard, or after the swap never becomes an envelope (buttons-da-gotovo r1 f3).
  const carried = (m.reply_markup?.inline_keyboard ?? []).some(row => row.some(b => b.callback_data === p.data))
  if (!carried) {
    line.outcome = 'refused:not-carried'
    await toast(c.noLonger)
    return
  }
  line.outcome = 'accepted'
  // The envelope label stays «Да» / «Нет» in every language (byte-identical for the session's readers);
  // only the «done» label is the button's own text, as before.
  const doneLabel = choice === 'd' ? doneLabelOf(m, d.lang) : ''
  const label = choice === 'y' ? 'Да' : choice === 'n' ? 'Нет' : doneLabel
  const message_id = String(m.message_id)
  await d
    .notify({
      content: `(button on message ${message_id}: ${label})`,
      meta: {
        event: 'reaction',
        chat_id: String(m.chat.id),
        message_id,
        user: p.from.username ?? fromId,
        user_id: fromId,
        ts: d.now().toISOString(),
        reaction_added: choice === 'y' ? '👍' : choice === 'n' ? '👎' : DONE_MARK,
        via: 'button',
      },
    })
    .catch(err => {
      line.notify = `failed:${failureClass(err)}`
      d.logError(`telegram channel: failed to deliver yes/no press to Claude: ${err}`)
    })
  // The keyboard swap is cosmetic; its failure never blocks the event above.
  const answered = answeredKeyboard(choice, d.lang, doneLabel || undefined)
  await d.editMarkup(answered).catch(err => {
    line.edit = `failed:${failureClass(err)}`
    d.logError(`telegram channel: yes/no keyboard edit failed: ${err}`)
  })
  await toast(answered[0][0].text)
}
