// Clip text to at most `max` UTF-16 code units without cutting a character in
// half. A plain .slice(0, max) can stop between the two halves of an emoji and
// leave a lone surrogate — invalid UTF-16 that broke the owner-log night sweep
// on 08.10 (BACKLOG «БЛОК · ДОРАБОТКИ ПЛАГИНА TELEGRAM» п.2). If the cut would
// split a surrogate pair, the whole pair is dropped instead.
export function clipUtf16(s: string | undefined, max: number): string | undefined {
  if (s == null || s.length <= max) return s
  let end = max
  if (end > 0) {
    const last = s.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
  }
  return s.slice(0, end)
}
