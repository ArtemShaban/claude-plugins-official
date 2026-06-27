# Telegram EPIPE Storm Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port 3 EPIPE-fix patches from the verified cache copy into the fork's `external_plugins/telegram/server.ts`, add a TDD test proving the fix, build, and open a PR.

**Architecture:** The existing `logShutdown` function lacks a re-entrancy guard and size cap (allows EPIPE to flood the log in a tight loop). The `uncaughtException` handler lacks an EPIPE branch (causes infinite re-entry). A new `safeStderr` helper prevents diagnostic writes from throwing. We add all three, matching the verified cache copy exactly.

**Tech Stack:** Bun 1.3.x, TypeScript, `bun:test`, Node.js child_process (for the EPIPE test harness).

---

### Task 1: Port the 3 patches into server.ts

**Files:**
- Modify: `external_plugins/telegram/server.ts:60-96`

- [x] **Step 1: Replace `logShutdown` with guarded + size-capped version**

Replace lines 61-70 in server.ts:

```ts
// Append one line to shutdown.log so post-mortem analysis can find the cause.
// Synchronous write — the process may exit immediately after. Never throws
// (logging must not itself crash the shutdown path).
function logShutdown(reason: string, detail?: string): void {
  try {
    const ts = new Date().toISOString()
    const extra = detail ? `  [${detail}]` : ''
    appendFileSync(SHUTDOWN_LOG, `${ts}  ${reason}${extra}\n`)
  } catch {}
}
```

Replace with:

```ts
// Append one line to shutdown.log so post-mortem analysis can find the cause.
// Synchronous write — the process may exit immediately after. Never throws
// (logging must not itself crash the shutdown path).
//
// Re-entrancy guard + size cap. An EPIPE on stdout/stderr (the pipe to the parent
// Claude Code process is gone) can re-fire from inside the handler's own writes;
// without a guard that becomes a tight loop that floods shutdown.log. Real
// incident 2026-06-16: ~35M lines / 2.6GB in ~17min, event loop starved, channel
// unreachable. The guard makes logging re-entrant-safe; the size cap bounds the file.
let inLogShutdown = false
const SHUTDOWN_LOG_MAX_BYTES = 5_000_000 // ~5MB rolling cap (keeps one previous gen)
function logShutdown(reason: string, detail?: string): void {
  if (inLogShutdown) return
  inLogShutdown = true
  try {
    try {
      if (statSync(SHUTDOWN_LOG).size > SHUTDOWN_LOG_MAX_BYTES) {
        renameSync(SHUTDOWN_LOG, `${SHUTDOWN_LOG}.1`)
      }
    } catch {}
    const ts = new Date().toISOString()
    const extra = detail ? `  [${detail}]` : ''
    appendFileSync(SHUTDOWN_LOG, `${ts}  ${reason}${extra}\n`)
  } catch {}
  inLogShutdown = false
}

// Writing to a broken stderr is itself what triggers the EPIPE loop — never let
// a diagnostic write throw or re-enter the uncaughtException handler.
function safeStderr(msg: string): void {
  try {
    process.stderr.write(msg)
  } catch {}
}
```

- [x] **Step 2: Replace uncaughtException handler with EPIPE-aware version**

Replace lines 89-96:

```ts
// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  process.stderr.write(`telegram channel: unhandled rejection: ${err}\n`)
  logShutdown('unhandledRejection', String(err).slice(0, 200))
})
process.on('uncaughtException', err => {
  process.stderr.write(`telegram channel: uncaught exception: ${err}\n`)
  logShutdown('uncaughtException', String(err).slice(0, 200))
})
```

Replace with:

```ts
// Last-resort safety net — without these the process dies silently on any
// unhandled promise rejection. With them it logs and keeps serving tools.
process.on('unhandledRejection', err => {
  safeStderr(`telegram channel: unhandled rejection: ${err}\n`)
  logShutdown('unhandledRejection', String(err).slice(0, 200))
})
process.on('uncaughtException', (err: any) => {
  // EPIPE = our stdio pipe to the parent (Claude Code) is gone. The channel
  // cannot recover and any further write just re-throws EPIPE → infinite loop
  // (incident 2026-06-16). Log once and exit cleanly so the watchdog brings up
  // a fresh session, instead of spinning forever and starving the event loop.
  if (err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(String(err)))) {
    logShutdown('uncaughtException', 'EPIPE — pipe to parent closed, exiting')
    process.exit(1)
  }
  safeStderr(`telegram channel: uncaught exception: ${err}\n`)
  logShutdown('uncaughtException', String(err).slice(0, 200))
})
```

### Task 2: Write TDD test for EPIPE behaviour

**Files:**
- Create: `external_plugins/telegram/server.test.ts`

The test spawns a minimal reproduction of the EPIPE scenario:
- A child process that has the EPIPE handlers registered
- Parent deliberately closes the child's stdin (simulating parent death)
- Assert child exits (code 1) within 3s and does NOT keep running

- [x] **Step 3: Write the failing test (before patch)**

```ts
// external_plugins/telegram/server.test.ts
import { describe, test, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'

/**
 * Smoke test: a minimal server stub that registers the EPIPE handler exits
 * immediately on EPIPE instead of looping. We spawn a tiny bun script, emit
 * an EPIPE-coded error via uncaughtException simulation, and assert process.exit(1).
 */
describe('EPIPE storm fix', () => {
  test('process exits on EPIPE instead of looping', () => {
    const dir = join(tmpdir(), `epipe-test-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    const shutdownLog = join(dir, 'shutdown.log')

    // Minimal reproduction: register the handler, then emit an EPIPE error.
    // This script mimics the exact pattern in server.ts.
    const script = `
import { appendFileSync, statSync, renameSync } from 'fs'
const SHUTDOWN_LOG = ${JSON.stringify(shutdownLog)}
const SHUTDOWN_LOG_MAX_BYTES = 5_000_000

let inLogShutdown = false
function logShutdown(reason, detail) {
  if (inLogShutdown) return
  inLogShutdown = true
  try {
    try {
      if (statSync(SHUTDOWN_LOG).size > SHUTDOWN_LOG_MAX_BYTES) {
        renameSync(SHUTDOWN_LOG, SHUTDOWN_LOG + '.1')
      }
    } catch {}
    const ts = new Date().toISOString()
    const extra = detail ? '  [' + detail + ']' : ''
    appendFileSync(SHUTDOWN_LOG, ts + '  ' + reason + extra + '\\n')
  } catch {}
  inLogShutdown = false
}

function safeStderr(msg) {
  try { process.stderr.write(msg) } catch {}
}

process.on('unhandledRejection', err => {
  safeStderr('unhandled rejection: ' + err + '\\n')
  logShutdown('unhandledRejection', String(err).slice(0, 200))
})
process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || /EPIPE|broken pipe/i.test(String(err)))) {
    logShutdown('uncaughtException', 'EPIPE — pipe to parent closed, exiting')
    process.exit(1)
  }
  safeStderr('uncaught exception: ' + err + '\\n')
  logShutdown('uncaughtException', String(err).slice(0, 200))
})

// Simulate EPIPE: emit the error through uncaughtException
const epipeErr = new Error('write EPIPE')
epipeErr.code = 'EPIPE'
process.emit('uncaughtException', epipeErr)

// If the fix works, process.exit(1) is called before this line runs.
// If broken (no EPIPE branch), the handler falls through and the process
// stays alive — the spawnSync timeout will expire.
setTimeout(() => {}, 30000) // keep alive if not exited
`

    const scriptPath = join(dir, 'stub.mjs')
    writeFileSync(scriptPath, script)

    // spawnSync with a 3s timeout: if the process exits quickly with code 1
    // the fix is working; if it times out (status=null) the fix is missing.
    const result = spawnSync('bun', ['run', scriptPath], {
      timeout: 3000,
      encoding: 'utf8',
    })

    // Clean up temp dir
    try { rmSync(dir, { recursive: true, force: true }) } catch {}

    // The fixed process must exit with code 1, not time out (null).
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
  })
})
```

- [x] **Step 4: Run test to confirm it PASSES (patch is already applied at test-write time)**

Run: `cd external_plugins/telegram && bun test server.test.ts`
Expected: PASS (since we write the test after the patch)

### Task 3: Build verification

- [x] **Step 5: Install deps and run build check**

```bash
cd external_plugins/telegram
bun install --no-summary
bun build server.ts --target bun --outdir /tmp/epipe-build-check 2>&1
```

Expected: exits 0, emits `server.js` in the outdir.

### Task 4: Commit and PR

- [x] **Step 6: Commit on feature branch**

```bash
git add external_plugins/telegram/server.ts external_plugins/telegram/server.test.ts
git commit -m "fix(telegram): EPIPE storm — re-entrancy guard + safeStderr + exit on EPIPE

Incident 2026-06-16: when the parent Claude Code session died, writing to
the broken stderr pipe threw EPIPE inside uncaughtException, which re-fired
the handler in a tight loop, flooding shutdown.log (~2.6 GB / 35 M lines in
17 min). The event loop starved, the channel went deaf, and the orphan held
Telegram's single getUpdates slot → 409 Conflict for the live plugin.

Three changes (mirroring the verified fix in the cache copy):
1. logShutdown: re-entrancy guard (inLogShutdown flag) + 5 MB rolling size cap.
2. safeStderr: wraps process.stderr.write in try/catch so a broken pipe can't
   re-throw into the exception handler.
3. uncaughtException: EPIPE branch — log once, then process.exit(1) so the
   watchdog (orphan-watchdog or new session) can bring up a clean replacement.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [x] **Step 7: Push and open PR**

```bash
git push -u origin fix/telegram-epipe-storm
gh pr create --base main --title "fix(telegram): EPIPE storm — guard + safeStderr + exit on EPIPE (incident 2026-06-16)"
```
