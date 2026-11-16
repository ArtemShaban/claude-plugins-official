// The one Telegram file download — review rounds r1 + r2 (D-1066; Codex r1 f2, f3, f5, f6:
// ~/.local/state/sam/codex-agent-runs/20261116T031735Z-driver-tg-file-download-r1/out.json).
// Hermetic: a local fake Bot API on 127.0.0.1 or a mocked global fetch, a fake token, no live state.
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createTelegramDownloader, MAX_PARALLEL_TRANSFERS, TelegramDownloadError, TRANSFER_CEILING_BYTES } from './tg-download'
import { voiceErrorClass } from './voice-delivery'

const TOKEN = '123456789:AAH-SECRET-fake-token-for-tests'
const SECRET = 'SECRET-fake-token'
const FILE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

type Kind = 'getfile' | 'file'
type Handler = (kind: Kind, n: number, req: IncomingMessage, res: ServerResponse) => void

interface Fake {
  origin: string
  server: Server
  sockets: Socket[]
  closed: Set<Socket>
  requests: { kind: Kind; socket: Socket }[]
}

const fakes: Fake[] = []

async function fakeApi(handler: Handler): Promise<Fake> {
  const sockets: Socket[] = []
  const closed = new Set<Socket>()
  const requests: Fake['requests'] = []
  const counts = { getfile: 0, file: 0 }
  const server = createServer((req, res) => {
    const kind: Kind = (req.url ?? '').includes('/getFile') ? 'getfile' : 'file'
    counts[kind]++
    requests.push({ kind, socket: req.socket })
    handler(kind, counts[kind], req, res)
  })
  server.on('connection', s => {
    sockets.push(s)
    s.on('close', () => closed.add(s))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  const f = { origin: `http://127.0.0.1:${port}`, server, sockets, closed, requests }
  fakes.push(f)
  return f
}

afterEach(() => {
  for (const f of fakes.splice(0)) {
    f.server.closeAllConnections()
    f.server.close()
  }
})

const okGetFile = (res: ServerResponse, extra: Record<string, unknown> = {}) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, result: { file_id: 'F', file_unique_id: 'AgAD-uniq', file_size: FILE.length, file_path: 'voice/file_7.oga', ...extra } }))
}
const okFile = (res: ServerResponse) => res.end(Buffer.from(FILE))
const never = () => {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const probe = async () => 12

async function waitClosed(f: Fake, s: Socket, ms = 2_000) {
  const t0 = Date.now()
  while (!f.closed.has(s) && Date.now() - t0 < ms) await sleep(20)
  return f.closed.has(s)
}

/** Unhandled rejections seen while `fn` runs and for `tailMs` after it. */
async function watchUnhandled<T>(fn: () => Promise<T>, tailMs = 300): Promise<{ value: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = []
  const h = (reason: unknown) => void unhandled.push(reason)
  process.on('unhandledRejection', h)
  try {
    const value = await fn()
    await sleep(tailMs)
    return { value, unhandled }
  } finally {
    process.off('unhandledRejection', h)
  }
}

/** The timers the downloader arms inside the synchronous call (hedge + cap), and which of them got cleared. */
function trackTimers() {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const armed: unknown[] = []
  const cleared = new Set<unknown>()
  let capturing = false
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = realSet(fn, ms, ...rest)
    if (capturing) armed.push(h)
    return h
  }) as typeof setTimeout
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.add(h)
    return realClear(h as Parameters<typeof clearTimeout>[0])
  }) as typeof clearTimeout
  return {
    armed,
    cleared,
    during<T>(fn: () => T): T {
      capturing = true
      try {
        return fn()
      } finally {
        capturing = false
      }
    },
    restore() {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    },
  }
}

// Round r2 (Codex r2 ~/.local/state/sam/codex-agent-runs/20261116T034251Z-driver-tg-file-download-r2/out.json):
// one fixed ceiling, no per-caller limit (every server.ts caller passed the same 20 MiB) → r2 f1 and f2 are moot by
// construction; these cases prove it, and r2 f3 (one body per file, no assembly copy, ≤ 4 transfers at once).
const MiB = 1024 * 1024

/** Write `total` bytes with backpressure; stop early once the client is gone; `end` → finish the response. */
function pump(res: ServerResponse, total: number, end: boolean, onWrite: (n: number) => void = () => {}) {
  const chunk = Buffer.alloc(256 * 1024, 7)
  let sent = 0
  const next = () => {
    while (!res.destroyed && sent < total) {
      const n = Math.min(chunk.length, total - sent)
      sent += n
      onWrite(n)
      if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void res.once('drain', next)
    }
    if (end && !res.destroyed) res.end()
  }
  next()
}

describe('the fixed 20 MiB ceiling holds on the bytes actually read (r1 f3, r2)', () => {
  for (const meta of [{ name: 'file_size omitted', extra: { file_size: undefined } }, { name: 'file_size under-reported', extra: { file_size: 4 } }]) {
    test(`${meta.name}, ceiling+1 bytes and the response held open → too_big, response closed, entry dropped`, async () => {
      const f = await fakeApi((kind, _n, _req, res) => {
        if (kind === 'getfile') return okGetFile(res, meta.extra)
        res.writeHead(200) // no Content-Length: only the byte count can end it, and the cut must abort it
        pump(res, TRANSFER_CEILING_BYTES + 1, false)
      })
      const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
      const got = await dl.downloadTelegramFile('F')
      expect(got.status).toBe('too_big')
      expect(dl.inflightCount()).toBe(0)
      expect(dl.buffered().now).toBe(0)
      expect(await waitClosed(f, f.requests.find(r => r.kind === 'file')!.socket)).toBe(true)
    }, 15_000)
  }

  test('Content-Length over the ceiling → too_big before the body is read', async () => {
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res, { file_size: undefined })
      res.writeHead(200, { 'content-length': String(TRANSFER_CEILING_BYTES + 1) })
      res.write(Buffer.alloc(1024))
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    const got = await dl.downloadTelegramFile('F')
    expect(got.status).toBe('too_big')
    expect(dl.buffered().peak).toBe(0)
    expect(await waitClosed(f, f.requests.find(r => r.kind === 'file')!.socket)).toBe(true)
  })

  test('a body of exactly the ceiling: ok, assembled once in place (peak = 1× the body, the result IS that buffer)', async () => {
    const f = await fakeApi((kind, _n, _req, res) => {
      if (kind === 'getfile') return okGetFile(res, { file_size: undefined })
      res.writeHead(200) // chunked: no size known up front
      pump(res, TRANSFER_CEILING_BYTES, true)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe })
    const got = await dl.downloadTelegramFile('F')
    expect(got.status).toBe('ok')
    if (got.status !== 'ok') return
    expect(got.bytes.byteLength).toBe(TRANSFER_CEILING_BYTES)
    expect(got.bytes[0]).toBe(7)
    expect(got.bytes[TRANSFER_CEILING_BYTES - 1]).toBe(7)
    expect(dl.buffered()).toEqual({ now: 0, peak: TRANSFER_CEILING_BYTES }) // never 2× during assembly
    // No final copy: the returned bytes are a view of the one assembly buffer, exactly the body long.
    expect((got.bytes.buffer as ArrayBuffer).resizable).toBe(true)
    expect(got.bytes.buffer.byteLength).toBe(TRANSFER_CEILING_BYTES)
    expect(dl.inflightCount()).toBe(0)
  }, 15_000)

  test('r2 f2: a junk caller limit (NaN, undefined, ±Infinity, negative, string) is ignored — an endless body stops at the ceiling', async () => {
    for (const junk of [Number.NaN, undefined, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, '5']) {
      let written = 0
      let serverSawClose = false
      const f = await fakeApi((kind, _n, _req, res) => {
        if (kind === 'getfile') return okGetFile(res, { file_size: undefined })
        res.writeHead(200)
        res.on('close', () => (serverSawClose = true))
        pump(res, 200 * MiB, false, n => (written += n))
      })
      const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, capMs: 20_000 })
      const got = await dl.downloadTelegramFile('F', { maxBytes: junk } as never).catch(e => e)
      expect(got.status).toBe('too_big')
      expect(JSON.stringify(got)).not.toContain(SECRET)
      expect(dl.inflightCount()).toBe(0)
      expect(dl.buffered()).toEqual({ now: 0, peak: expect.any(Number) })
      expect(dl.buffered().peak).toBeLessThanOrEqual(TRANSFER_CEILING_BYTES)
      expect(await waitClosed(f, f.requests.find(r => r.kind === 'file')!.socket)).toBe(true)
      await sleep(50)
      expect(serverSawClose).toBe(true)
      expect(written).toBeLessThan(TRANSFER_CEILING_BYTES + 32 * MiB) // socket buffers, never the 200 MiB
    }
  }, 60_000)
})

describe('r2 f1: a caller arriving while the cut is cancelling the body gets the same terminal answer', () => {
  test('the stream cancel hook starts a second caller: both too_big (one transfer), no truncated ok; a call after settle fetches anew', async () => {
    const realFetch = globalThis.fetch
    const calls = { getfile: 0, file: 0 }
    let dl: ReturnType<typeof createTelegramDownloader>
    let late: Promise<unknown> | undefined
    let inflightAtCancel = -1
    globalThis.fetch = (async (u: string | URL | Request) => {
      if (String(u).includes('/getFile')) {
        calls.getfile++
        return new Response(JSON.stringify({ ok: true, result: { file_id: 'F', file_unique_id: 'U', file_path: 'voice/f.oga' } }))
      }
      calls.file++
      let sent = 0
      return new Response(
        new ReadableStream({
          pull(c) {
            sent += MiB
            c.enqueue(new Uint8Array(MiB))
            if (sent > 64 * MiB) c.close() // never reached: the cut comes at 20 MiB
          },
          cancel() {
            if (late) return
            inflightAtCancel = dl.inflightCount()
            late = dl.downloadTelegramFile('F') // the irreversible cut is happening right now
          },
        }),
      )
    }) as typeof fetch
    try {
      dl = createTelegramDownloader({ token: TOKEN, probe, hedgeMs: 60_000 })
      const first = await dl.downloadTelegramFile('F')
      expect(late).toBeDefined()
      const second = (await late) as typeof first
      expect(first.status).toBe('too_big')
      expect(second.status).toBe('too_big') // the only limit is the ceiling: over it for every caller
      expect(second).toBe(first) // joined the same transfer
      expect(inflightAtCancel).toBe(1)
      expect(calls).toEqual({ getfile: 1, file: 1 })
      expect(dl.inflightCount()).toBe(0)
      expect(dl.buffered().now).toBe(0)
      const after = await dl.downloadTelegramFile('F') // the entry was dropped on settle: a new transfer
      expect(after.status).toBe('too_big')
      expect(calls).toEqual({ getfile: 2, file: 2 })
    } finally {
      globalThis.fetch = realFetch
    }
  }, 15_000)
})

describe('r2 f3: one body per file, at most MAX_PARALLEL_TRANSFERS transfers at once', () => {
  test('both hedged attempts get headers at the same moment → only the first reads a body, the other is aborted', async () => {
    const held: ServerResponse[] = []
    const fileSockets: Socket[] = []
    const f = await fakeApi((kind, n, req, res) => {
      if (kind === 'getfile') return n === 1 ? void setTimeout(() => okGetFile(res, { file_size: undefined }), 150) : okGetFile(res, { file_size: undefined })
      held.push(res)
      fileSockets.push(req.socket)
      if (held.length < 2) return
      for (const r of held) r.writeHead(200) // both bodies start in the same tick
      for (const r of held) pump(r, TRANSFER_CEILING_BYTES, true)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 })
    const got = await dl.downloadTelegramFile('F')
    expect(got.status).toBe('ok')
    if (got.status === 'ok') expect(got.bytes.byteLength).toBe(TRANSFER_CEILING_BYTES)
    expect(got.journal.dl_att).toBe(2)
    expect(dl.buffered()).toEqual({ now: 0, peak: TRANSFER_CEILING_BYTES }) // one body, not two
    // file requests arrive attempt 2 first (its getFile was instant), then attempt 1
    const loser = got.journal.dl_win === 2 ? fileSockets[1] : fileSockets[0]
    expect(await waitClosed(f, loser)).toBe(true)
    expect(dl.inflightCount()).toBe(0)
  }, 20_000)

  test('6 file_ids at once: never more than 4 transfers, body memory ≤ 4 bodies, all succeed', async () => {
    let open = 0
    let maxOpen = 0
    const f = await fakeApi((kind, _n, _req, res) => {
      open++
      maxOpen = Math.max(maxOpen, open)
      res.on('close', () => open--)
      if (kind === 'getfile') return void setTimeout(() => okGetFile(res, { file_size: undefined }), 20)
      res.writeHead(200)
      pump(res, 8 * MiB, true)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 60_000 })
    const got = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F'].map(id => dl.downloadTelegramFile(id)))
    for (const g of got) {
      expect(g.status).toBe('ok')
      if (g.status === 'ok') expect(g.bytes.byteLength).toBe(8 * MiB)
    }
    expect(maxOpen).toBe(MAX_PARALLEL_TRANSFERS) // the cap was reached and held
    expect(dl.buffered().peak).toBeLessThanOrEqual(MAX_PARALLEL_TRANSFERS * 8 * MiB)
    expect(dl.buffered().now).toBe(0)
    expect(f.requests.filter(r => r.kind === 'getfile').length).toBe(6)
    expect(dl.inflightCount()).toBe(0)
  }, 30_000)

  test('queued transfers time out cleanly: the cap clock runs while waiting, nothing keeps running, no slot leaks', async () => {
    let mode: 'stall' | 'ok' = 'stall'
    const f = await fakeApi((kind, _n, _req, res) => {
      if (mode === 'stall') return never()
      return kind === 'getfile' ? okGetFile(res) : okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 60_000, capMs: 300 })
    const t0 = performance.now()
    const errs = await Promise.all(['A', 'B', 'C', 'D', 'E', 'F'].map(id => dl.downloadTelegramFile(id).catch(e => e)))
    // All 6 end at their own 300 ms cap, the 2 queued ones too (not 300 ms after they got a slot).
    expect(performance.now() - t0).toBeLessThan(550)
    expect(errs.map(e => voiceErrorClass(e))).toEqual(Array(6).fill('timeout'))
    expect(dl.inflightCount()).toBe(0)
    await sleep(50)
    const seen = f.requests.length
    expect(seen).toBeGreaterThanOrEqual(MAX_PARALLEL_TRANSFERS) // a queued one may start in a freed slot, then hit its cap
    expect(seen).toBeLessThanOrEqual(6)
    await sleep(300)
    expect(f.requests.length).toBe(seen) // nothing starts after its download settled
    for (const s of f.sockets) expect(await waitClosed(f, s)).toBe(true)
    mode = 'ok'
    const again = await Promise.all(['A', 'B', 'C', 'D', 'E'].map(id => dl.downloadTelegramFile(id)))
    expect(again.every(g => g.status === 'ok')).toBe(true) // no slot leaked
    expect(dl.inflightCount()).toBe(0)
  }, 15_000)
})

describe('f2 — attempt 2 never reuses a pooled connection (Bun 1.4.0 `keepalive: false`)', () => {
  for (const winner of [2, 1] as const) {
    test(`idle keep-alive connections in the pool; attempt ${winner} wins; attempt 2 is on its own new connections; loser closed`, async () => {
      let phase: 'warm' | 'race' = 'warm'
      let raceGetFile = 0
      const f = await fakeApi((kind, _n, _req, res) => {
        if (phase === 'warm') return kind === 'getfile' ? void setTimeout(() => okGetFile(res), 50) : okFile(res)
        if (kind === 'getfile') {
          raceGetFile++
          if (winner === 2) return raceGetFile === 1 ? never() : okGetFile(res)
          return raceGetFile === 1 ? void setTimeout(() => okGetFile(res), 400) : never()
        }
        okFile(res)
      })
      const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 })
      // Warm Bun's pool: two concurrent downloads leave two idle keep-alive sockets to this origin.
      await Promise.all([dl.downloadTelegramFile('W1'), dl.downloadTelegramFile('W2')])
      await sleep(50)
      const warm = f.sockets.filter(s => !f.closed.has(s))
      expect(warm.length).toBeGreaterThanOrEqual(2) // the pool really holds idle reusable connections
      phase = 'race'
      const before = f.requests.length
      const got = await dl.downloadTelegramFile('R')
      expect(got.status).toBe('ok')
      expect(got.journal.dl_att).toBe(2)
      expect(got.journal.dl_win).toBe(winner)
      const race = f.requests.slice(before)
      const a1 = race[0].socket // attempt 1's getFile — the pool may reuse a warm socket for it
      const a2 = race.filter((r, i) => i > 0 && r.kind === 'getfile')[0].socket
      expect(a2).not.toBe(a1)
      expect(warm.includes(a2)).toBe(false) // a NEW connection, although an idle pooled one was free
      for (const r of race) {
        if (r.socket !== a1) expect(warm.includes(r.socket)).toBe(false)
      }
      const loser = winner === 2 ? a1 : a2
      expect(await waitClosed(f, loser)).toBe(true)
      expect(dl.inflightCount()).toBe(0)
    }, 15_000)
  }
})

describe('f6 — one attempt fails after the hedge, the sibling returns the bytes', () => {
  for (const failing of [1, 2] as const) {
    test(`attempt ${failing} fails after the hedge → success from the other, loser closed, no unhandled rejection, timers cleared`, async () => {
      let gf = 0
      const f = await fakeApi((kind, _n, req, res) => {
        if (kind === 'file') return okFile(res)
        gf++
        const mine = gf
        if (mine === failing) return void setTimeout(() => req.socket.destroy(), 200) // fails at ~200 ms of its own life
        // the sibling answers after the failure
        setTimeout(() => okGetFile(res), failing === 1 ? 350 : 500)
      })
      const timers = trackTimers()
      try {
        const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100, capMs: 5_000 })
        const { value: got, unhandled } = await watchUnhandled(async () => {
          const p = timers.during(() => dl.downloadTelegramFile('F'))
          return await p
        })
        expect(got.status).toBe('ok')
        if (got.status === 'ok') expect([...got.bytes]).toEqual([...FILE])
        expect(got.journal.dl_att).toBe(2)
        expect(got.journal.dl_win).toBe(failing === 1 ? 2 : 1)
        expect(unhandled).toEqual([])
        expect(timers.armed.length).toBe(2) // hedge + cap
        for (const h of timers.armed) expect(timers.cleared.has(h)).toBe(true)
        const loserSock = f.requests.filter(r => r.kind === 'getfile')[failing - 1].socket
        expect(await waitClosed(f, loserSock)).toBe(true)
        expect(dl.inflightCount()).toBe(0)
      } finally {
        timers.restore()
      }
    }, 10_000)
  }

  test('the losing attempt, aborted after the winner settled, raises no unhandled rejection', async () => {
    const f = await fakeApi((kind, n, _req, res) => {
      if (kind === 'getfile' && n === 1) return void setTimeout(() => okGetFile(res), 300)
      if (kind === 'getfile') return never()
      okFile(res)
    })
    const dl = createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 })
    const { value: got, unhandled } = await watchUnhandled(() => dl.downloadTelegramFile('F'))
    expect(got.status).toBe('ok')
    expect(got.journal.dl_win).toBe(1)
    expect(unhandled).toEqual([])
    expect(dl.inflightCount()).toBe(0)
  })
})

describe('f5 — the bot token never leaves, on every error path', () => {
  // Our closed fields + the source position Bun itself puts on every Error (no data in them).
  const CLOSED_FIELDS = new Set(['stack', 'message', 'name', 'code', 'error_code', 'line', 'column', 'originalLine', 'originalColumn', 'sourceURL'])

  /** Every sink a caller could print: String(), message, stack, JSON, own fields (enumerable or not), cause, class. */
  function sinks(e: unknown): string {
    const x = e as Record<string, unknown>
    const own = Object.getOwnPropertyNames(x ?? {}).map(k => `${k}=${String(x[k])}`)
    return [String(e), x?.message, x?.stack, JSON.stringify(e), JSON.stringify(Object.entries(x ?? {})), ...own, String(x?.cause), voiceErrorClass(e)].join('\n')
  }

  function expectClosed(e: unknown) {
    expect(e).toBeInstanceOf(TelegramDownloadError)
    for (const k of Object.getOwnPropertyNames(e as object)) expect(CLOSED_FIELDS.has(k)).toBe(true)
    expect((e as { cause?: unknown }).cause).toBeUndefined()
    const all = sinks(e)
    expect(all.includes(SECRET)).toBe(false)
    expect(all.includes(TOKEN)).toBe(false)
  }

  /** stderr / console output written while `fn` runs. */
  async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
    const chunks: string[] = []
    const realWrite = process.stderr.write.bind(process.stderr)
    const realOut = process.stdout.write.bind(process.stdout)
    const realErr = console.error
    const realWarn = console.warn
    const realLog = console.log
    process.stderr.write = ((c: unknown) => (chunks.push(String(c)), true)) as typeof process.stderr.write
    process.stdout.write = ((c: unknown) => (chunks.push(String(c)), true)) as typeof process.stdout.write
    console.error = console.warn = console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' '))
    try {
      return { value: await fn(), out: chunks.join('') }
    } finally {
      process.stderr.write = realWrite
      process.stdout.write = realOut
      console.error = realErr
      console.warn = realWarn
      console.log = realLog
    }
  }

  const realFetch = globalThis.fetch
  async function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
    globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => impl(String(u), i)) as typeof fetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = realFetch
    }
  }

  const getFileOk = () =>
    new Response(JSON.stringify({ ok: true, result: { file_id: 'F', file_unique_id: 'U', file_size: 8, file_path: 'voice/f.oga' } }), {
      headers: { 'content-type': 'application/json' },
    })

  // Mocked fetch rejections, shaped as Bun / node / undici errors that carry the URL (= the token).
  const shapes: { name: string; at: 'getfile' | 'file'; err: (url: string) => unknown; cls: string }[] = [
    {
      name: 'DNS-shaped rejection (getaddrinfo ENOTFOUND, URL in message + path)',
      at: 'getfile',
      err: url => Object.assign(new Error(`getaddrinfo ENOTFOUND api.telegram.org ${url}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'api.telegram.org', path: url }),
      cls: 'sys_ENOTFOUND',
    },
    {
      name: 'Bun-style connect error (code ConnectionRefused, URL in path)',
      at: 'file',
      err: url => Object.assign(new TypeError(`Unable to connect. Is the computer able to access the url? ${url}`), { code: 'ConnectionRefused', path: url, errno: 0 }),
      cls: 'network',
    },
    {
      name: 'nested cause with the URL two levels down',
      at: 'getfile',
      err: url => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${url}`), { code: 'ECONNREFUSED', url, cause: { url, href: url } }) }),
      cls: 'network',
    },
    {
      name: 'a code field that itself holds the token',
      at: 'file',
      err: url => Object.assign(new Error('boom'), { code: TOKEN, url }),
      cls: 'network',
    },
    {
      name: 'a non-Error rejection (a bare string with the URL)',
      at: 'getfile',
      err: url => `failed ${url}`,
      cls: 'network',
    },
  ]

  for (const s of shapes) {
    test(`mocked fetch: ${s.name}`, async () => {
      let journal: unknown
      const { value: e, out } = await captureOutput(() =>
        withFetch(
          async url => {
            const isFile = !url.includes('/getFile')
            if ((s.at === 'getfile') !== isFile) throw s.err(url)
            return isFile ? new Response(FILE) : getFileOk()
          },
          () =>
            createTelegramDownloader({ token: TOKEN, probe, hedgeMs: 60_000 })
              .downloadTelegramFile('F', { onStart: j => (journal = j) })
              .catch(err => err),
        ),
      )
      expectClosed(e)
      expect(voiceErrorClass(e)).toBe(s.cls as ReturnType<typeof voiceErrorClass>)
      expect(JSON.stringify(journal)).not.toContain(SECRET)
      expect(out.includes(SECRET)).toBe(false)
    })
  }

  test('mocked fetch: the body stream errors with the URL in its reason', async () => {
    const { value: e, out } = await captureOutput(() =>
      withFetch(
        async url => {
          if (url.includes('/getFile')) return getFileOk()
          const stream = new ReadableStream({
            pull(c) {
              c.error(Object.assign(new Error(`socket hang up ${url}`), { url }))
            },
          })
          return new Response(stream)
        },
        () => createTelegramDownloader({ token: TOKEN, probe, hedgeMs: 60_000 }).downloadTelegramFile('F').catch(err => err),
      ),
    )
    expectClosed(e)
    expect(voiceErrorClass(e)).toBe('network')
    expect(out.includes(SECRET)).toBe(false)
  })

  test('fake API: getFile answers 200 with malformed JSON that echoes the URL', async () => {
    const f = await fakeApi((kind, _n, req, res) => {
      if (kind === 'getfile') {
        res.setHeader('content-type', 'application/json')
        return res.end(`{"ok": tru ${req.url}`)
      }
      okFile(res)
    })
    const { value: e, out } = await captureOutput(() =>
      createTelegramDownloader({ token: TOKEN, origin: f.origin, probe }).downloadTelegramFile('F').catch(err => err),
    )
    expectClosed(e)
    expect(voiceErrorClass(e)).toBe('http_200')
    expect(out.includes(SECRET)).toBe(false)
  })

  test('fake API: an aborted loser (attempt 1 stalls, attempt 2 wins) leaks nothing anywhere', async () => {
    const f = await fakeApi((kind, n, req, res) => {
      if (kind === 'getfile' && n === 1) return never()
      if (kind === 'getfile') return okGetFile(res)
      okFile(res)
    })
    const { value, out } = await captureOutput(() =>
      watchUnhandled(() => createTelegramDownloader({ token: TOKEN, origin: f.origin, probe, hedgeMs: 100 }).downloadTelegramFile('F')),
    )
    expect(value.value.status).toBe('ok')
    expect(value.unhandled).toEqual([])
    expect(JSON.stringify(value.value.journal)).not.toContain(SECRET)
    expect(out.includes(SECRET)).toBe(false)
  })
})
