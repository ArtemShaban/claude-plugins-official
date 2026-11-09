/**
 * One appender for the plugin's own line logs in STATE_DIR (startup.log, voice.log).
 * The plugin's stderr is not kept anywhere durable, so a line meant for a post-mortem goes
 * to a file. Mode 0600, append-only, O_NOFOLLOW (never through a symlink planted at the path).
 * Never throws: a write failure = one stderr line per failure streak, the caller goes on.
 */
import { closeSync, constants as fsc, fchmodSync, openSync, writeSync } from 'node:fs'
import { basename } from 'node:path'

export function createStateLineWriter(opts: {
  file: string
  /** Words after the comma of the failure line, e.g. 'startup continues'. */
  goesOn: string
  log?: (line: string) => void
}): (text: string) => void {
  const log = opts.log ?? ((line: string) => { try { process.stderr.write(line) } catch {} })
  const name = basename(opts.file)
  let failing = false
  return text => {
    try {
      const fd = openSync(opts.file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, text)
      } finally {
        closeSync(fd)
      }
      failing = false
    } catch (err) {
      if (!failing) {
        failing = true
        const code = (err as { code?: unknown } | null)?.code
        const safe = typeof code === 'string' && /^[A-Z0-9_]{1,24}$/.test(code) ? code : 'unknown'
        try { log(`telegram channel: ${name} write failed (${safe}), ${opts.goesOn}\n`) } catch {}
      }
    }
  }
}
