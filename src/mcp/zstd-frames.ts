/**
 * Zstandard frame-boundary scanning for DSH session artifacts.
 *
 * The session persistence backend stores one JSONL artifact as a container of
 * independently decodable, concatenated zstd frames: frame 0 holds the header
 * line and every later frame holds one durable event batch. `node:zlib`'s
 * `zstdDecompressSync` decodes exactly one frame and rejects trailing bytes,
 * so readers must split the container first.
 *
 * Frame boundaries are located structurally, without decompressing block
 * payloads, following the frame layout of RFC 8878 (magic number, frame
 * header descriptor, block headers, optional content checksum). The upstream
 * contract (checked at harness revision `fcc0ad46`,
 * `dsh-session-persistence-jsonl`) reserves frame-header bits and block types
 * this scanner treats as corrupt, and writes every frame checksummed.
 *
 * @module dsh-log-enhance/mcp/zstd-frames
 */

import { zstdDecompressSync } from 'node:zlib'

/** Frame magic common to all zstd frames, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = 0xFD2FB528

/** Byte range of one structurally complete frame. */
export interface ZstdFrameRange {
  /** Inclusive start offset. */
  start: number
  /** Exclusive end offset. */
  end: number
}

export interface ZstdFrameScan {
  /** Complete frames, in file order. */
  frames: ZstdFrameRange[]
  /** Start offset of an incomplete final frame when EOF interrupts one. */
  tornStart?: number
}

export class ZstdFrameFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ZstdFrameFormatError'
  }
}

/**
 * Locate complete frame ranges in a container buffer. Structural corruption
 * of a complete frame rejects; EOF inside the final frame returns its start as
 * a torn tail instead, matching how a session log may be read mid-write.
 * @param buffer - whole artifact bytes.
 * @param maxFrames - stop after this many complete frames (header-only reads pass `1`).
 * @returns complete frame ranges and an optional torn-final-frame start.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new ZstdFrameFormatError(`invalid zstd frame magic at byte ${String(offset)}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new ZstdFrameFormatError(`reserved frame-header descriptor bit at byte ${String(offset - 1)}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new ZstdFrameFormatError(`reserved block type at byte ${String(offset - 3)}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * Decompress one complete frame range out of its container buffer.
 * @param buffer - whole artifact bytes.
 * @param frame - range previously returned by {@link scanZstdFrames}.
 * @returns the frame's decoded bytes.
 */
export function decompressFrame(buffer: Buffer, frame: ZstdFrameRange): Buffer {
  try {
    return zstdDecompressSync(buffer.subarray(frame.start, frame.end))
  } catch (error) {
    throw new ZstdFrameFormatError(
      `frame at byte ${String(frame.start)} failed to decompress: ${String(error)}`,
      { cause: error },
    )
  }
}
