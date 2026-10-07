/**
 * The binary mirror stream (agent 1.2.0, `"encoding":"binary"`), pure and unit-tested under plain
 * mocha: a text status line, then records `u32be H, header (UTF-8 JSON, H bytes), payload`.
 * Memory stays bounded: one status line, one header (both at most 4 KiB) and one payload buffer
 * that is allocated once per image and filled from the incoming chunks.
 */

import { clientName } from './agentCore';
import {
  MIRROR_MAX_FRAME_BYTES,
  type AdaptFields,
  type MirrorFormat,
  type VideoFields,
  parseMirrorHeader,
  parseMirrorLine,
  type MirrorLine,
  type MirrorOptions,
} from './mirrorCore';

export { MIRROR_MAX_FRAME_BYTES };

const MAX_STATUS_LINE_BYTES = 4096;
const MAX_HEADER_BYTES = 4096;
const MIN_HEADER_BYTES = 2;

export type MirrorEvent =
  | Exclude<MirrorLine, { kind: 'frame' }>
  | {
      kind: 'frame';
      frame: number;
      ts: number;
      screen: [number, number];
      size: [number, number];
      format: MirrorFormat;
      payload: Buffer;
      cms?: number;
      ems?: number;
    } & AdaptFields & VideoFields;

type Frame = Extract<MirrorEvent, { kind: 'frame' }>;

type State = 'status-line' | 'length' | 'header' | 'payload';

/** Incremental reader of a binary mirror stream. Feed it socket chunks of any size. */
export class MirrorRecordParser {
  failed: string | undefined;
  private state: State = 'status-line';
  private done = false;
  /** Bytes of the status line, the 4-byte length or the header being collected. */
  private small = Buffer.alloc(0);
  private need = 0;
  private pending: Omit<Frame, 'payload'> | undefined;
  private payload: Buffer | undefined;
  private filled = 0;

  push(chunk: Buffer): MirrorEvent[] {
    const events: MirrorEvent[] = [];
    let pos = 0;
    while (pos < chunk.length && !this.failed && !this.done) {
      switch (this.state) {
        case 'status-line':
          pos = this.readStatusLine(chunk, pos, events);
          break;
        case 'length':
        case 'header':
          pos = this.readSmall(chunk, pos, events);
          break;
        case 'payload':
          pos = this.readPayload(chunk, pos, events);
          break;
      }
    }
    return events;
  }

  private fail(reason: string): void {
    this.failed = reason;
    this.small = Buffer.alloc(0);
    this.payload = undefined;
    this.pending = undefined;
  }

  private readStatusLine(chunk: Buffer, pos: number, events: MirrorEvent[]): number {
    const nl = chunk.indexOf(0x0a, pos);
    const end = nl === -1 ? chunk.length : nl;
    if (this.small.length + (end - pos) > MAX_STATUS_LINE_BYTES) {
      this.fail('corrupt stream');
      return chunk.length;
    }
    this.small = Buffer.concat([this.small, chunk.subarray(pos, end)]);
    if (nl === -1) return chunk.length;
    const line = parseMirrorLine(this.small.toString('utf8'));
    this.small = Buffer.alloc(0);
    if (!line) {
      this.fail('corrupt stream');
    } else if (line.kind === 'fatal') {
      events.push(line);
      this.fail('unexpected text stream');
    } else if (line.kind === 'status' && (line.encoding === 'binary' || line.encoding === 'vp8')) {
      events.push(line);
      this.state = 'length';
      this.need = 4;
    } else if (line.kind === 'status') {
      this.fail('unexpected text stream');
    } else {
      this.fail('corrupt stream');
    }
    return nl + 1;
  }

  /** Collects the 4-byte length, then the header it announces. */
  private readSmall(chunk: Buffer, pos: number, events: MirrorEvent[]): number {
    const take = Math.min(this.need - this.small.length, chunk.length - pos);
    this.small = Buffer.concat([this.small, chunk.subarray(pos, pos + take)]);
    pos += take;
    if (this.small.length < this.need) return pos;
    const bytes = this.small;
    this.small = Buffer.alloc(0);
    if (this.state === 'length') {
      const h = bytes.readUInt32BE(0);
      if (h < MIN_HEADER_BYTES || h > MAX_HEADER_BYTES) {
        this.fail('corrupt stream');
        return pos;
      }
      this.state = 'header';
      this.need = h;
      return pos;
    }
    this.onHeader(bytes, events);
    return pos;
  }

  private onHeader(bytes: Buffer, events: MirrorEvent[]): void {
    let o: unknown;
    try {
      o = JSON.parse(bytes.toString('utf8'));
    } catch {
      this.fail('corrupt stream');
      return;
    }
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      this.fail('corrupt stream');
      return;
    }
    const h = parseMirrorHeader(o as Record<string, unknown>, 'record');
    if (!h) {
      this.fail('corrupt stream');
      return;
    }
    if (h.kind === 'fatal') {
      events.push(h);
      this.done = true; // the daemon closes the connection after a fatal record
      return;
    }
    if (h.kind === 'frame') {
      const { bytes: n, ...rest } = h;
      this.pending = rest;
      this.payload = Buffer.allocUnsafe(n);
      this.filled = 0;
      this.state = 'payload';
      return;
    }
    events.push(h);
    this.state = 'length';
    this.need = 4;
  }

  private readPayload(chunk: Buffer, pos: number, events: MirrorEvent[]): number {
    const buf = this.payload;
    const meta = this.pending;
    if (!buf || !meta) {
      this.fail('corrupt stream');
      return chunk.length;
    }
    const take = Math.min(buf.length - this.filled, chunk.length - pos);
    chunk.copy(buf, this.filled, pos, pos + take);
    this.filled += take;
    pos += take;
    if (this.filled === buf.length) {
      events.push({ ...meta, payload: buf });
      this.payload = undefined;
      this.pending = undefined;
      this.state = 'length';
      this.need = 4;
    }
    return pos;
  }
}

/** Upstream acknowledgement of a fully received image record. */
export function ackLine(frame: number): string {
  return `{"ack":${frame}}\n`;
}

/**
 * The request sent first on the forwarded socket. `adapt` asks agent 1.4.0 for adaptive quality;
 * older agents ignore the field and stream as before (the status line then has no `adapt`).
 * `vp8` (agent 1.6.0) asks for video at `bitrate` kbit/s; it is only sent to an agent that lists
 * `vp8` in `mirrorEncodings`.
 */
export function mirrorRequestLine(
  o: MirrorOptions & { lease: number; adapt?: boolean; bitrate?: number; input?: boolean; phoneState?: boolean; client?: string },
  encoding: 'binary' | 'vp8',
): string {
  return (
    JSON.stringify({
      cmd: 'mirror',
      fps: o.fps,
      width: o.width,
      quality: o.quality,
      encoding,
      ...(encoding === 'vp8' && o.bitrate !== undefined ? { bitrate: o.bitrate } : {}),
      lease: o.lease,
      ...(o.adapt ? { adapt: true } : {}),
      ...(o.input ? { input: true } : {}),
      ...(o.phoneState ? { phoneState: true } : {}),
      ...(clientName(o.client ?? '') ? { client: clientName(o.client ?? '') } : {}),
    }) + '\n'
  );
}

/** Upstream request for a VP8 key frame (agent 1.6.0; older agents ignore it). */
export function keyframeLine(): string {
  return '{"keyframe":true}\n';
}
