// «Да / Нет» buttons under a binary question to the owner (D-890; spec sam-data
// dev/analysis/2026-11-01-yes-no-buttons-spec.md).
//
// Send: the reply tool's `yes_no: true` puts ONE keyboard row «Да» «Нет» on the
// message — only when the owner's sam-data override `yes-no-buttons` is exactly
// boolean true (default off, owner first: D-475). Off → a plain message.
// Press: accepted only from the owner (config.json user.telegram_chat_id) in his
// own DM. It reaches the session as the SAME reaction envelope his 👍/👎 makes,
// plus `via="button"`, so every 👍/👎 reader works unchanged and the 👍-only
// rails (tools/owner_approval.py check_thumbs) can refuse it. The press never
// feeds the secretary preview or the signed approval side-channel.
//
// Pure + injected effects (no grammy import), so it is unit-testable.

import { readConfigJson } from './secretary'

export const YES_NO_SWITCH = 'yes-no-buttons'
export const YES = 'yn:y'
export const NO = 'yn:n'
export const ANSWERED = 'yn:x'

export type Choice = 'y' | 'n'
export type Button = { text: string; callback_data: string }

/** ON only for exactly boolean `true` in sam-data config.json overrides. */
export function yesNoButtonsOn(home: string): boolean {
  const ov = readConfigJson(home)?.overrides
  return ov != null && typeof ov === 'object' && (ov as Record<string, unknown>)[YES_NO_SWITCH] === true
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

/** One row, two columns: «Да» «Нет». */
export function yesNoKeyboard(): Button[][] {
  return [[{ text: 'Да', callback_data: YES }, { text: 'Нет', callback_data: NO }]]
}

/** After a press: one inert button showing the choice. */
export function answeredKeyboard(choice: Choice): Button[][] {
  return [[{ text: choice === 'y' ? '✅ Да' : '❌ Нет', callback_data: ANSWERED }]]
}

export function parseYesNoData(data: string): Choice | 'x' | null {
  if (data === YES) return 'y'
  if (data === NO) return 'n'
  if (data === ANSWERED) return 'x'
  return null
}

export const SUFFIX_ON = ' +yes/no buttons'
export const SUFFIX_OFF = ' — yes/no buttons are off on this install; the answer comes by 👍/👎 or text'

export type PressInput = {
  data: string
  from: { id: number; username?: string }
  // callback_query.message; absent when Telegram no longer has it.
  message?: { message_id: number; chat: { id: number; type: string } }
}

export type PressDeps = {
  ownerId: string | undefined
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
  const toast = (t: string) => d.answer(t).catch(() => {})
  const fromId = String(p.from.id)
  if (!d.ownerId || fromId !== d.ownerId) {
    await toast('Not authorized.')
    return true
  }
  const m = p.message
  if (m == null) {
    await toast('Question no longer available.')
    return true
  }
  if (m.chat.type !== 'private' || String(m.chat.id) !== fromId) {
    await toast('Not authorized.')
    return true
  }
  if (choice === 'x') {
    await toast('Already answered.')
    return true
  }
  const label = choice === 'y' ? 'Да' : 'Нет'
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
        reaction_added: choice === 'y' ? '👍' : '👎',
        via: 'button',
      },
    })
    .catch(err => d.logError(`telegram channel: failed to deliver yes/no press to Claude: ${err}`))
  // The keyboard swap is cosmetic; its failure never blocks the event above.
  await d.editMarkup(answeredKeyboard(choice)).catch(err => d.logError(`telegram channel: yes/no keyboard edit failed: ${err}`))
  await toast(choice === 'y' ? '✅ Да' : '❌ Нет')
  return true
}
