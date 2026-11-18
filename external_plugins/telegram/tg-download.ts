/**
 * The ONE Telegram file download (D-1066; owner tg 48590 → «да, супер, делай» tg 48591;
 * spec sam-data dev/analysis/2026-11-16-tg-file-download-fix-spec.md, RCA
 * dev/analysis/2026-11-16-voice-transcription-fallback-rca.md).
 *
 * «одна общая функция скачивания вместо 4 копий … повторный запрос того же файла не качает заново» (tg 48590).
 * D-1087 (owner tg 49565 «вырежи повтор в 8 сек, если он бесполезен»; RCA dev/analysis/2026-11-18-tg-voice-getfile-rca.md
 * M1: the 8 s second attempt won 0 of 14 — Telegram's getFile stall is per file, not per connection): ONE attempt.
 *
 * - The only place that calls getFile and builds the file URL (both carry the bot token).
 * - One attempt = getFile → file GET, under one AbortSignal. It fails or succeeds once; never a second attempt here
 *   (a voice whose file did not come is re-fetched later by voice-delivery.ts's late fetcher, not by this module).
 * - Each attempt reads at most TRANSFER_CEILING_BYTES (the Bot API getFile limit): Content-Length over it, or the
 *   bytes actually read going over it (Telegram's file_size is optional and may be wrong) → too_big, body cancelled.
 * - Single-flight per file_id: a call while that file is in flight joins its transfer and gets the same answer. The
 *   entry is dropped when the download settles — a failure is never reused.
 * - DOWNLOAD_CAP_MS hard cap: all attempts aborted, entry dropped, a `timed out` error.
 * - Every error that leaves this module passes one boundary (`closedError`): never the URL (= never the token), never
 *   Telegram's description text, never a `cause` — also for a failure inside the module itself.
 * - PROBE_AFTER_MS (8 s) with no file-GET headers yet → one bare TCP connect to api.telegram.org:443 (PROBE_CAP_MS cap)
 *   is recorded in the journal — «следующий сбой сам покажет, чья сторона» (tg 48590). Diagnostic only: it starts
 *   nothing else, never runs on the happy path, never awaited by delivery.
 *
 * No top-level side effects: server.ts wires the token; tests inject a local fake Bot API (`origin`).
 */
import { connect } from 'node:net'

/** When a still-waiting download records its TCP probe (the old 8 s hedge mark; D-1087 kept only the probe). */
export const PROBE_AFTER_MS = 8_000
export const DOWNLOAD_CAP_MS = 180_000
export const PROBE_CAP_MS = 5_000
/** The most one attempt ever reads: the Bot API's getFile limit («files of up to 20MB»), = server.ts MAX_DOWNLOAD_BYTES. */
export const TRANSFER_CEILING_BYTES = 20 * 1024 * 1024

const TG_API = 'https://api.telegram.org/bot'
const TG_FILE = 'https://api.telegram.org/file/bot'

/** Where the most advanced attempt is: getFile in flight · file GET waiting for headers · body · finished. */
export type DownloadPhase = 'getfile' | 'headers' | 'body' | 'done'
export type ProbeResult = number | 'timeout' | 'error'

/** Live, shared by every joiner; read by the voice journal at any moment (also after the voice stopped waiting). */
export interface DownloadJournal {
  /** Attempts started: always 1 since D-1087 (the voice.log key stays). */
  dl_att: number
  /** 1 once the attempt returned the file; absent otherwise. */
  dl_win?: number
  /** getFile ms. */
  gf_ms?: number
  /** File GET ms (headers + body). */
  fx_ms?: number
  dl_phase: DownloadPhase
  /** TCP connect ms to api.telegram.org:443, started at PROBE_AFTER_MS; absent = not reached (or still running). */
  probe_ms?: ProbeResult
}

export type DownloadResult =
  | { status: 'ok'; bytes: Uint8Array; ext: string; uniqueId: string; journal: DownloadJournal }
  | { status: 'no_file'; journal: DownloadJournal }
  | { status: 'too_big'; journal: DownloadJournal }

export interface DownloadOpts {
  /** Called once, synchronously, with the live journal (a joiner gets the in-flight one). */
  onStart?: (journal: DownloadJournal) => void
}

export interface DownloaderOpts {
  token: string
  /** Test seam: a local fake Bot API, e.g. `http://127.0.0.1:1234`. Default: api.telegram.org. */
  origin?: string
  probeAfterMs?: number
  capMs?: number
  probe?: () => Promise<ProbeResult>
  nowMs?: () => number
}

/** The thrown error: message and fields from a closed set only. `code` / `error_code` / `name` feed the callers' classifiers. */
export class TelegramDownloadError extends Error {
  code?: string
  error_code?: number
  constructor(message: string, fields: { code?: string; error_code?: number; name?: string } = {}) {
    super(message)
    this.name = fields.name ?? 'TelegramDownloadError'
    if (fields.code != null) this.code = fields.code
    if (fields.error_code != null) this.error_code = fields.error_code
  }
}

const PHASE_ORDER: Record<DownloadPhase, number> = { getfile: 0, headers: 1, body: 2, done: 3 }

function httpCode(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 999 ? n : undefined
}

/** A network failure, rebuilt: only a short code survives (Bun / node codes), never the message (it can hold the URL). */
function networkError(err: unknown): TelegramDownloadError {
  const code = (err as { code?: unknown } | null)?.code
  return new TelegramDownloadError('telegram file download failed: network', {
    name: 'HttpError',
    ...(typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code) ? { code } : {}),
  })
}

/** The one exit for errors: ours pass as they are (already closed); anything else becomes a fieldless internal error. */
function closedError(err: unknown): TelegramDownloadError {
  return err instanceof TelegramDownloadError ? err : new TelegramDownloadError('telegram file download failed: internal')
}

/** One bare TCP connect to api.telegram.org:443 — ms, or `timeout` past the cap, or `error`. Never throws. */
export function tcpProbe(host = 'api.telegram.org', port = 443, capMs = PROBE_CAP_MS): Promise<ProbeResult> {
  return new Promise(resolve => {
    const t0 = Date.now()
    let done = false
    const sock = connect({ host, port })
    const end = (r: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => end('timeout'), capMs)
    sock.once('connect', () => end(Date.now() - t0))
    sock.once('error', () => end('error'))
  })
}

type Fetched = { status: 'ok'; bytes: Uint8Array; ext: string; uniqueId: string } | { status: 'no_file' } | { status: 'too_big' }

export function createTelegramDownloader(opts: DownloaderOpts) {
  const apiBase = opts.origin ? `${opts.origin}/bot` : TG_API
  const fileBase = opts.origin ? `${opts.origin}/file/bot` : TG_FILE
  const probeAfterMs = opts.probeAfterMs ?? PROBE_AFTER_MS
  const capMs = opts.capMs ?? DOWNLOAD_CAP_MS
  const probe = opts.probe ?? (() => tcpProbe())
  const now = opts.nowMs ?? Date.now
  type Entry = { promise: Promise<DownloadResult>; journal: DownloadJournal }
  const inflight = new Map<string, Entry>()

  async function get(url: string, signal: AbortSignal, json?: unknown): Promise<Response> {
    try {
      return await fetch(url, {
        signal,
        // Bot API methods: POST + JSON body, the form grammY uses (the file id never sits in a URL either).
        ...(json !== undefined
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }
          : {}),
      })
    } catch (err) {
      if (signal.aborted) throw new TelegramDownloadError('telegram file download aborted', { name: 'AbortError' })
      throw networkError(err)
    }
  }

  async function body<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await read()
    } catch (err) {
      if (signal.aborted) throw new TelegramDownloadError('telegram file download aborted', { name: 'AbortError' })
      throw networkError(err)
    }
  }

  type AttemptState = { phase: DownloadPhase; gf_ms?: number; fx_ms?: number }

  /** The whole body, or null once it is over the ceiling (by Content-Length or by the running count). */
  async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array | null> {
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > TRANSFER_CEILING_BYTES) {
      void res.body?.cancel().catch(() => {})
      return null
    }
    const reader = res.body?.getReader()
    if (!reader) return new Uint8Array(0)
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await body(() => reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > TRANSFER_CEILING_BYTES) {
        void reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
  }

  async function attempt(
    fileId: string,
    st: AttemptState,
    signal: AbortSignal,
    onPhase: () => void,
  ): Promise<Fetched> {
    const t0 = now()
    const gfRes = await get(`${apiBase}${opts.token}/getFile`, signal, { file_id: fileId })
    const parsed = await body(() => gfRes.json() as Promise<unknown>, signal).catch(err => {
      if ((err as Error).name === 'AbortError') throw err
      // Not JSON (a proxy page): classify by the HTTP status only.
      throw new TelegramDownloadError(`getFile failed: HTTP ${gfRes.status}`, { error_code: httpCode(gfRes.status) })
    })
    const r = parsed as { ok?: unknown; error_code?: unknown; result?: { file_path?: unknown; file_size?: unknown; file_unique_id?: unknown } }
    if (r?.ok !== true || r.result == null || typeof r.result !== 'object') {
      const code = httpCode(r?.error_code) ?? httpCode(gfRes.status)
      throw new TelegramDownloadError(`getFile failed: HTTP ${code ?? 'unknown'}`, code != null ? { error_code: code } : {})
    }
    st.gf_ms = now() - t0
    const filePath = typeof r.result.file_path === 'string' ? r.result.file_path : ''
    if (!filePath) return { status: 'no_file' }
    const size = r.result.file_size
    if (typeof size === 'number' && size > TRANSFER_CEILING_BYTES) return { status: 'too_big' }
    st.phase = 'headers'
    onPhase()
    const t1 = now()
    const res = await get(`${fileBase}${opts.token}/${filePath}`, signal)
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      throw new TelegramDownloadError(`file download failed: HTTP ${res.status}`, { code: `HTTP_${res.status}` })
    }
    st.phase = 'body'
    onPhase()
    const bytes = await readCapped(res, signal)
    if (bytes == null) return { status: 'too_big' }
    st.fx_ms = now() - t1
    const last = filePath.split('/').pop() ?? ''
    const ext = last.includes('.') ? last.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '') : ''
    const rawUid = r.result.file_unique_id
    const uniqueId = typeof rawUid === 'string' ? rawUid.replace(/[^a-zA-Z0-9_-]/g, '') : ''
    return { status: 'ok', bytes, ext, uniqueId }
  }

  function start(fileId: string): Entry {
    const journal: DownloadJournal = { dl_att: 1, dl_phase: 'getfile' }
    const entry = { journal } as Entry
    const ctrl = new AbortController()
    const st: AttemptState = { phase: 'getfile' }
    let settled = false
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    let capTimer: ReturnType<typeof setTimeout> | undefined

    entry.promise = new Promise<DownloadResult>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(probeTimer)
        clearTimeout(capTimer)
        ctrl.abort()
        inflight.delete(fileId)
        fn()
      }
      attempt(fileId, st, ctrl.signal, () => (journal.dl_phase = st.phase)).then(
        got =>
          finish(() => {
            journal.dl_win = 1
            if (st.gf_ms != null) journal.gf_ms = st.gf_ms
            if (st.fx_ms != null) journal.fx_ms = st.fx_ms
            journal.dl_phase = 'done'
            resolve({ ...got, journal } as DownloadResult)
          }),
        err => finish(() => reject(closedError(err))),
      )
      probeTimer = setTimeout(() => {
        // Only while there are no file-GET headers yet: a streaming body is not a stall of the path.
        if (settled || PHASE_ORDER[st.phase] > PHASE_ORDER.headers) return
        void probe()
          .then(r => {
            journal.probe_ms = r
          })
          .catch(() => {
            journal.probe_ms = 'error'
          })
      }, probeAfterMs)
      capTimer = setTimeout(
        () => finish(() => reject(new TelegramDownloadError(`telegram file download timed out after ${capMs}ms`))),
        capMs,
      )
    })
    return entry
  }

  /** Download one Telegram file (see the module header). Joins an in-flight transfer of the same file_id. */
  function downloadTelegramFile(fileId: string, o: DownloadOpts = {}): Promise<DownloadResult> {
    let entry = inflight.get(fileId)
    if (!entry) {
      entry = start(fileId)
      // A download that settled synchronously is impossible (fetch is async), so the entry is live here.
      inflight.set(fileId, entry)
    }
    o.onStart?.(entry.journal)
    return entry.promise
  }

  return { downloadTelegramFile, inflightCount: () => inflight.size }
}
