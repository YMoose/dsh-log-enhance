/**
 * Read-only access to the DSH session JSONL storage tree.
 *
 * Layout (upstream contract, harness revision `fcc0ad46`,
 * `dsh-session-persistence-jsonl`):
 *
 * ```
 * <root>/<projectKey>/<encodeSegment(sessionId)>/session.v<N>.jsonl[.zstd]
 * ```
 *
 * A session directory may keep several format generations; the highest version
 * is the current one and the only one read here. Compressed artifacts are
 * concatenated-frame zstd containers (see {@link ./zstd-frames.ts}); plain
 * `.jsonl` files are read line-wise. Parsing never mutates anything on disk.
 *
 * @module dsh-log-enhance/mcp/session-store
 */

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decompressFrame, scanZstdFrames } from './zstd-frames.js'

/** Canonical generation filename: `session.jsonl` (v0) or `session.vN.jsonl`, optional `.zstd`. */
const LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

/** Header reads never need more than the first frame plus slack. */
const HEADER_READ_BYTES = 65_536

/** Parsed session header line (`type: "session"`). */
export interface SessionHeader {
  readonly type: 'session'
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly isSeeded?: boolean
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly origin?: unknown
}

/** One persisted event row; fields beyond `type` are optional by tolerance, not by contract. */
export interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  readonly data?: unknown
  readonly [key: string]: unknown
}

/** One discovered session file with its header resolved. */
export interface SessionListing {
  readonly sessionId: string
  readonly path: string
  readonly formatVersion: number
  readonly compressed: boolean
  readonly fileBytes: number
  readonly lastModifiedMs: number
  readonly header: SessionHeader
}

/** A fully parsed session artifact. */
export interface ParsedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly listing: SessionListing
  /** A write-interrupted final frame was present and skipped. */
  readonly truncatedTail: boolean
}

export class SessionLookupError extends Error {
  constructor(message: string, readonly candidates: readonly string[] = []) {
    super(message)
    this.name = 'SessionLookupError'
  }
}

export class SessionReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionReadError'
  }
}

interface Artifact {
  readonly path: string
  readonly version: number
  readonly compressed: boolean
}

function logFilename(version: number, compressed: boolean): string {
  const generation = version === 0 ? 'session.jsonl' : `session.v${String(version)}.jsonl`
  return compressed ? `${generation}.zstd` : generation
}

/** List `<root>/<project>/<session>/` directories with their newest generation artifact. */
async function discoverArtifacts(root: string): Promise<Artifact[]> {
  const found: Artifact[] = []
  let projects: string[]
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return found
  }
  for (const project of projects) {
    let sessionDirs: string[]
    try {
      sessionDirs = (await readdir(join(root, project), { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const session of sessionDirs) {
      let names: string[]
      try {
        names = await readdir(join(root, project, session))
      } catch {
        continue
      }
      let best: { version: number; compressed: boolean } | undefined
      for (const name of names) {
        const match = LOG_FILENAME.exec(name)
        if (match === null) continue
        const version = match[1] === undefined ? 0 : Number(match[1])
        const compressed = match[2] !== undefined
        if (best === undefined
          || version > best.version
          || (version === best.version && compressed && !best.compressed)) {
          best = { version, compressed }
        }
      }
      if (best !== undefined) {
        found.push({ path: join(root, project, session, logFilename(best.version, best.compressed)), ...best })
      }
    }
  }
  return found
}

/** Read at most the first `limit` bytes of a file without loading the rest. */
async function readHead(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const { bytesRead, buffer } = await handle.read({
      buffer: Buffer.alloc(Math.min(limit, 4096)),
      position: 0,
    })
    if (bytesRead < buffer.length) return buffer.subarray(0, bytesRead)
    // Grow once for large heads; headers are far below the limit in practice.
    const whole = Buffer.alloc(limit)
    buffer.copy(whole, 0, 0, bytesRead)
    if (bytesRead < limit) {
      const more = await handle.read({ buffer: whole.subarray(bytesRead), position: bytesRead })
      return whole.subarray(0, bytesRead + more.bytesRead)
    }
    return whole
  } finally {
    await handle.close()
  }
}

function parseJsonLine(line: string, context: string): unknown {
  try {
    return JSON.parse(line)
  } catch (error) {
    throw new SessionReadError(`${context}: invalid JSON line: ${String(error)}`)
  }
}

function asHeader(value: unknown, path: string): SessionHeader {
  if (typeof value !== 'object' || value === null) {
    throw new SessionReadError(`${path}: first line is not a session header`)
  }
  const record = value as Record<string, unknown>
  if (record['type'] !== 'session' || typeof record['id'] !== 'string') {
    throw new SessionReadError(`${path}: first line is not a session header`)
  }
  return record as unknown as SessionHeader
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).trim()
}

/** Decode the header JSON out of an artifact's first frame (or first line). */
async function readHeader(path: string, compressed: boolean): Promise<SessionHeader> {
  if (!compressed) {
    return asHeader(parseJsonLine(firstLine((await readHead(path, HEADER_READ_BYTES)).toString('utf8')), path), path)
  }
  const buffer = await readHead(path, HEADER_READ_BYTES)
  const scan = scanZstdFrames(buffer, 1)
  const frame = scan.frames[0]
  if (frame === undefined) throw new SessionReadError(`${path}: no complete header frame`)
  return asHeader(parseJsonLine(firstLine(decompressFrame(buffer, frame).toString('utf8')), path), path)
}

interface ArtifactBody {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  readonly truncatedTail: boolean
}

/** Read every frame (or line) and parse the header plus all event rows. */
async function parseArtifact(artifact: Artifact): Promise<ArtifactBody> {
  let headerText: string
  let eventChunks: string[]
  let truncatedTail = false
  if (artifact.compressed) {
    const buffer = await readFile(artifact.path)
    const scan = scanZstdFrames(buffer)
    truncatedTail = scan.tornStart !== undefined
    const [first, ...rest] = scan.frames
    if (first === undefined) throw new SessionReadError(`${artifact.path}: no complete header frame`)
    headerText = decompressFrame(buffer, first).toString('utf8')
    eventChunks = rest.map((frame, index) => {
      try {
        return decompressFrame(buffer, frame).toString('utf8')
      } catch (error) {
        throw new SessionReadError(`${artifact.path}: frame ${String(index + 1)} failed to decompress: ${String(error)}`)
      }
    })
  } else {
    const text = await readFile(artifact.path, 'utf8')
    const newline = text.indexOf('\n')
    headerText = newline === -1 ? text : text.slice(0, newline)
    eventChunks = [newline === -1 ? '' : text.slice(newline + 1)]
  }
  const header = asHeader(parseJsonLine(firstLine(headerText), artifact.path), artifact.path)
  const events: SessionEvent[] = []
  for (const chunk of eventChunks) {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      events.push(parseJsonLine(trimmed, artifact.path) as SessionEvent)
    }
  }
  return { header, events, truncatedTail }
}

interface CacheEntry {
  readonly statKey: string
  readonly parsed: ParsedSession
}

/**
 * Session storage reader with bounded caching. Headers are cached cheaply;
 * full parses are cached per file path and invalidated when stat changes.
 */
export class SessionStore {
  private readonly headerCache = new Map<string, { statKey: string; listing: SessionListing }>()
  private readonly parseCache = new Map<string, CacheEntry>()
  private cachedEvents = 0
  private readonly maxCachedEvents: number

  constructor(readonly root: string, options: { maxCachedEvents?: number } = {}) {
    this.maxCachedEvents = options.maxCachedEvents ?? 200_000
  }

  /** Whether the configured root directory currently exists. */
  async rootExists(): Promise<boolean> {
    try {
      return (await stat(this.root)).isDirectory()
    } catch {
      return false
    }
  }

  /** Discover sessions and resolve their headers. Unreadable entries are skipped. */
  async list(): Promise<SessionListing[]> {
    const artifacts = await discoverArtifacts(this.root)
    const listings: SessionListing[] = []
    for (const artifact of artifacts) {
      const cached = this.headerCache.get(artifact.path)
      try {
        const fileStat = await stat(artifact.path)
        const statKey = `${String(fileStat.mtimeMs)}:${String(fileStat.size)}`
        if (cached !== undefined && cached.statKey === statKey) {
          listings.push(cached.listing)
          continue
        }
        const header = await readHeader(artifact.path, artifact.compressed)
        const listing: SessionListing = {
          sessionId: header.id,
          path: artifact.path,
          formatVersion: artifact.version,
          compressed: artifact.compressed,
          fileBytes: fileStat.size,
          lastModifiedMs: fileStat.mtimeMs,
          header,
        }
        this.headerCache.set(artifact.path, { statKey, listing })
        listings.push(listing)
      } catch {
        this.headerCache.delete(artifact.path)
      }
    }
    return listings
  }

  /**
   * Resolve a session reference: the exact id, or a unique id suffix.
   * @throws {@link SessionLookupError} when nothing matches or a suffix is ambiguous.
   */
  async resolve(sessionRef: string): Promise<SessionListing> {
    const listings = await this.list()
    const exact = listings.find(listing => listing.sessionId === sessionRef)
    if (exact !== undefined) return exact
    const suffixes = listings.filter(listing => listing.sessionId.endsWith(sessionRef))
    if (suffixes.length === 1) return suffixes[0] as SessionListing
    if (suffixes.length > 1) {
      throw new SessionLookupError(
        `session reference "${sessionRef}" matches ${String(suffixes.length)} sessions`,
        suffixes.map(listing => listing.sessionId),
      )
    }
    throw new SessionLookupError(
      `unknown session "${sessionRef}" under ${this.root}`,
      listings.slice(0, 10).map(listing => listing.sessionId),
    )
  }

  /** Parse one session fully, through the bounded cache. */
  async load(sessionRef: string): Promise<ParsedSession> {
    const listing = await this.resolve(sessionRef)
    const fileStat = await stat(listing.path).catch(error => {
      throw new SessionReadError(`${listing.path}: ${String(error)}`)
    })
    const statKey = `${String(fileStat.mtimeMs)}:${String(fileStat.size)}`
    const cached = this.parseCache.get(listing.path)
    if (cached !== undefined && cached.statKey === statKey) {
      this.parseCache.delete(listing.path)
      this.parseCache.set(listing.path, cached)
      return cached.parsed
    }
    const artifact: Artifact = {
      path: listing.path,
      version: listing.formatVersion,
      compressed: listing.compressed,
    }
    const body = await parseArtifact(artifact)
    const parsed: ParsedSession = {
      header: body.header,
      events: body.events,
      truncatedTail: body.truncatedTail,
      listing: {
        ...listing,
        fileBytes: fileStat.size,
        lastModifiedMs: fileStat.mtimeMs,
      },
    }
    this.parseCache.delete(listing.path)
    while (this.cachedEvents + body.events.length > this.maxCachedEvents && this.parseCache.size > 0) {
      const oldest = this.parseCache.keys().next()
      if (oldest.done === true) break
      const evicted = this.parseCache.get(oldest.value)
      this.parseCache.delete(oldest.value)
      if (evicted !== undefined) this.cachedEvents -= evicted.parsed.events.length
    }
    this.parseCache.set(listing.path, { statKey, parsed })
    this.cachedEvents += body.events.length
    return parsed
  }
}
