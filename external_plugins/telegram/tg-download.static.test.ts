// D-1066 criterion 5 (OB-06, «одна общая функция скачивания вместо 4 копий», tg 48590): the file URL is built in ONE
// place (tg-download.ts), server.ts never calls getFile itself, and the four download sites call the helper —
// so a fifth unbounded copy cannot creep back in. Reads source text only.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = import.meta.dir
const src = (f: string) => readFileSync(join(DIR, f), 'utf8')
const nonTestTs = readdirSync(DIR).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))

/** The body of the block that starts at `anchor`, up to the next top-level / case boundary. */
function block(text: string, anchor: string, end: RegExp): string {
  const i = text.indexOf(anchor)
  expect(i).toBeGreaterThanOrEqual(0)
  const rest = text.slice(i + anchor.length)
  const m = end.exec(rest)
  return rest.slice(0, m ? m.index : undefined)
}

describe('one download helper', () => {
  test('`api.telegram.org/file/` occurs exactly once in non-test .ts, in tg-download.ts', () => {
    const hits = nonTestTs.flatMap(f => (src(f).split('api.telegram.org/file/').length - 1 > 0 ? [[f, src(f).split('api.telegram.org/file/').length - 1]] : []))
    expect(hits).toEqual([['tg-download.ts', 1]])
  })

  test('server.ts never calls getFile( itself', () => {
    expect(src('server.ts').includes('getFile(')).toBe(false)
  })

  test('the four sites call downloadTelegramFile', () => {
    const s = src('server.ts')
    expect(block(s, 'const fetchTelegramFile: Download = async fileId => {', /\n}\n/)).toContain('downloadTelegramFile(')
    expect(block(s, "case 'download_attachment': {", /\n      case '/)).toContain('downloadTelegramFile(')
    expect(block(s, "bot.on('message:photo', async ctx => {", /\n}\)\n/)).toContain('downloadTelegramFile(')
    expect(block(s, 'async function downloadFileToInbox(', /\n}\n/)).toContain('downloadTelegramFile(')
  })
})
