// The assistant's retired name must never come back into this plugin — not in
// source, tests, docs or config (owner promise: the old name returns neither to
// core nor to the bridge). Scans every file under this plugin folder except
// node_modules. The needle is built from character codes so this file itself
// stays clean.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const NEEDLE = new RegExp(String.fromCharCode(115, 101, 109, 101, 110), 'i')
const ROOT = import.meta.dir

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
}

describe('retired assistant name', () => {
  test('appears nowhere in the plugin folder (node_modules excluded)', () => {
    const files: string[] = []
    walk(ROOT, files)
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const f of files) {
      const rel = relative(ROOT, f)
      if (NEEDLE.test(rel)) hits.push(`${rel} (path)`)
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => { if (NEEDLE.test(l)) hits.push(`${rel}:${i + 1}`) })
    }
    expect(hits).toEqual([])
  })
})
