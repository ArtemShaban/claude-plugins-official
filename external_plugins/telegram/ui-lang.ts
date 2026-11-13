// The person's language for the plugin's own words on screen — button captions and toasts
// (owner tg 46811: an English message got a Russian «✅ Да» button). One table, one resolver.
// The language is config.json user.language, read once at start (voice-delivery.ts
// userVoiceConfig). Known: ru, en, id; anything else, absent or 'auto' → en.
//
// Only what the person SEES changes. Callback data (yn:y / yn:n / yn:d / yn:x), the reaction
// envelope (👍 / 👎 / ✅, via="button") and its content «(button on message N: Да|Нет)» stay
// byte-identical in every language — the session's readers never see a translation.

export type UiLang = 'ru' | 'en' | 'id'

export type UiCaptions = {
  yes: string
  no: string
  done: string // the «done» label when the message no longer tells us its own
  notAuthorized: string
  noLonger: string
  alreadyAnswered: string
}

export const UI_CAPTIONS: Record<UiLang, UiCaptions> = {
  ru: {
    yes: 'Да',
    no: 'Нет',
    done: 'Готово',
    notAuthorized: 'Нет доступа.',
    noLonger: 'Вопрос уже неактуален.',
    alreadyAnswered: 'Уже ответили.',
  },
  en: {
    yes: 'Yes',
    no: 'No',
    done: 'Done',
    notAuthorized: 'Not authorized.',
    noLonger: 'Question no longer available.',
    alreadyAnswered: 'Already answered.',
  },
  id: {
    yes: 'Ya',
    no: 'Tidak',
    done: 'Selesai',
    notAuthorized: 'Tidak diizinkan.',
    noLonger: 'Pertanyaan sudah tidak tersedia.',
    alreadyAnswered: 'Sudah dijawab.',
  },
}

/** config user.language → a language we have captions for. 'ru', 'RU', 'ru-RU', 'ru_RU' → ru; unknown → en. */
export function uiLang(lang: unknown): UiLang {
  if (typeof lang !== 'string') return 'en'
  const base = lang.trim().toLowerCase().split(/[-_]/)[0]
  return base === 'ru' || base === 'id' || base === 'en' ? base : 'en'
}

export function captions(lang: UiLang): UiCaptions {
  return UI_CAPTIONS[lang] ?? UI_CAPTIONS.en
}
