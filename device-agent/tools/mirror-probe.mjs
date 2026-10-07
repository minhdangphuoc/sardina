#!/usr/bin/env node
// Test probe for the device agent's mirror protocol (not shipped; see PLAN-mirror-forward.md).
// Connects to an agent socket (usually the local end of an `ssh -N -L` forward), sends one
// request and prints one line per message. Exit codes: 0 success, 1 failure, 2 usage.
//
//   node mirror-probe.mjs <socket> [--ping] [--binary] [--frames N] [--duration S] [--no-ack]
//        [--fps N] [--width N] [--quality N] [--window-check] [--lease N] [--keepalive-ms N]
//        [--no-keepalive] [--expect-expiry S] [--bad-upstream] [--quiet] [--save-last FILE]
//        [--adapt] [--ack-delay MS] [--rate KIBPS | --rate S:KIBPS,S:KIBPS,...]
//        [--vp8] [--bitrate KBPS] [--keyframe-at S,S,...] [--save-ivf FILE]
//        [--input] [--phone-state] [--client TEXT]
//
// Phone settings (agent 1.9.0):
//   --input        asks for "input":true (the status line then reports input or inputError).
//   --phone-state  asks for "phoneState":true; every "settings" message prints a "settings" line.
//   --client       sends "client":TEXT (shown on the phone's Settings page).
//
// VP8 video (agent 1.6.0):
//   --vp8          asks for "encoding":"vp8" (binary framing, one VP8 frame per image record) and
//                  checks each frame: a key frame must carry the VP8 start code, the first frame
//                  must be a key frame. --bitrate sets the target in kbit/s.
//   --keyframe-at  sends {"keyframe":true} at these seconds from the start and reports how long
//                  the next key frame took.
//   --save-ivf     writes the stream as an IVF file (decodable with GStreamer's vp8dec, for example).
//
// Slow-link simulation (agent 1.4.0 adaptive quality):
//   --adapt      asks for "adapt":true and runs the extension's own controller
//                (src/agent/mirrorAdapt.ts, loaded through Node's type stripping, Node >= 22.18),
//                sending its {"set":...} lines; each decision prints an "adapt" line.
//   --ack-delay  holds every ack back for MS milliseconds (a long round trip).
//   --rate       lets received bytes through at most KIBPS KiB/s, like a slow link: the socket is
//                paused while more than 64 KiB wait, so the ssh channel and the agent's ack window
//                fill up as they would. A schedule switches the rate at the given seconds from
//                the start, e.g. 0:0,10:40,40:0 (0 = unlimited).

import net from 'node:net';
import { writeFileSync, openSync, writeSync, closeSync } from 'node:fs';

const USAGE = 'usage: mirror-probe.mjs <socket> [--ping] [--binary] [--frames N] [--duration S] [--no-ack] [--fps N] [--width N] [--quality N] [--window-check] [--lease N] [--keepalive-ms N] [--no-keepalive] [--expect-expiry S] [--bad-upstream] [--quiet] [--save-last FILE] [--adapt] [--ack-delay MS] [--rate KIBPS|S:KIBPS,...] [--vp8] [--bitrate KBPS] [--keyframe-at S,...] [--save-ivf FILE] [--input] [--phone-state] [--client TEXT]';

function parseRate(spec) {
  const steps = spec.split(',').map((part) => {
    const [a, b] = part.includes(':') ? part.split(':') : ['0', part];
    const at = Number(a);
    const kibps = Number(b);
    if (!Number.isFinite(at) || !Number.isFinite(kibps) || at < 0 || kibps < 0) throw new Error(`bad --rate ${spec}`);
    return { at: at * 1000, kibps };
  });
  return steps.sort((x, y) => x.at - y.at);
}

function parseArgs(argv) {
  const o = { keepaliveMs: 20000 };
  const num = (i) => {
    const v = Number(argv[i]);
    if (!Number.isFinite(v)) throw new Error(`${argv[i - 1]} needs a number`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--ping': o.ping = true; break;
      case '--binary': o.binary = true; break;
      case '--frames': o.frames = num(++i); break;
      case '--duration': o.duration = num(++i); break;
      case '--no-ack': o.noAck = true; break;
      case '--fps': o.fps = num(++i); break;
      case '--width': o.width = num(++i); break;
      case '--quality': o.quality = num(++i); break;
      case '--window-check': o.windowCheck = true; o.noAck = true; break;
      case '--lease': o.lease = num(++i); break;
      case '--keepalive-ms': o.keepaliveMs = num(++i); break;
      case '--no-keepalive': o.noKeepalive = true; break;
      case '--expect-expiry': o.expectExpiry = num(++i); break;
      case '--bad-upstream': o.badUpstream = true; break;
      case '--quiet': o.quiet = true; break;
      case '--save-last': o.saveLast = argv[++i]; break;
      case '--adapt': o.adapt = true; break;
      case '--ack-delay': o.ackDelay = num(++i); break;
      case '--rate': o.rate = parseRate(argv[++i] ?? ''); break;
      case '--vp8': o.vp8 = true; o.binary = true; break;
      case '--bitrate': o.bitrate = num(++i); break;
      case '--keyframe-at': o.keyframeAt = (argv[++i] ?? '').split(',').map(Number).filter((n) => Number.isFinite(n)); break;
      case '--save-ivf': o.saveIvf = argv[++i]; break;
      case '--input': o.input = true; break;
      case '--phone-state': o.phoneState = true; break;
      case '--client': o.client = argv[++i] ?? ''; break;
      default:
        if (a.startsWith('--') || o.socket) throw new Error(`unknown argument ${a}`);
        o.socket = a;
    }
  }
  if (!o.socket) throw new Error('missing socket path');
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n${USAGE}\n`);
  process.exit(2);
}

// The extension's controller, the same file the extension bundles.
const adaptModule = opts.adapt ? await import(new URL('../../src/agent/mirrorAdapt.ts', import.meta.url)) : undefined;
let adapt;
const decisions = [];

const t0 = Date.now();
const elapsed = () => Date.now() - t0;
const out = (s) => { if (!opts.quiet) process.stdout.write(`${s}\n`); };
const isJpeg = (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a;

const stats = {
  connectMs: undefined, statusMs: undefined, firstImageMs: undefined,
  images: 0, same: 0, errors: 0, pongs: 0, bytes: 0, imageBytes: 0, sizes: {}, perFiveSeconds: [],
  cms: [], ems: [], latency: [], rtt: [], imageTimes: [],
  keyFrames: 0, keyBytes: [], deltaBytes: [], cvms: [], keyRequests: [], firstFrameKey: undefined,
  perSecond: [], deltaEms: [], keyEms: [], refresh: 0,
};
const pendingKeyRequests = [];
let ivf;
let ivfFrames = 0;
function ivfOpen(w, h) {
  if (!opts.saveIvf || ivf !== undefined) return;
  ivf = openSync(opts.saveIvf, 'w');
  const hdr = Buffer.alloc(32);
  hdr.write('DKIF', 0, 'latin1');
  hdr.writeUInt16LE(0, 4);
  hdr.writeUInt16LE(32, 6);
  hdr.write('VP80', 8, 'latin1');
  hdr.writeUInt16LE(w, 12);
  hdr.writeUInt16LE(h, 14);
  hdr.writeUInt32LE(1000, 16); // timebase: ms
  hdr.writeUInt32LE(1, 20);
  hdr.writeUInt32LE(0, 24); // frame count, patched at the end
  writeSync(ivf, hdr);
}
function ivfFrame(pts, payload) {
  if (ivf === undefined) return;
  const fh = Buffer.alloc(12);
  fh.writeUInt32LE(payload.length, 0);
  fh.writeBigUInt64LE(BigInt(pts), 4);
  writeSync(ivf, fh);
  writeSync(ivf, payload);
  ivfFrames++;
}
function ivfClose() {
  if (ivf === undefined) return;
  const n = Buffer.alloc(4);
  n.writeUInt32LE(ivfFrames, 0);
  writeSync(ivf, n, 0, 4, 24);
  closeSync(ivf);
  ivf = undefined;
}
// A VP8 key frame: bit 0 of the frame tag is 0 and the start code 9d 01 2a follows the 3-byte tag.
const isVp8Key = (b) => b.length >= 10 && (b[0] & 1) === 0 && b[3] === 0x9d && b[4] === 0x01 && b[5] === 0x2a;
const pingSent = new Map();
const offsets = [];
let lastKeepaliveAt;
let keepaliveTimer;
let seq = 0;
let windowSize;
let status;
let done = false;

function median(xs) {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs, p) {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const offsetMs = () => median(offsets.slice(-5));

function summary() {
  const span = stats.imageTimes.length > 1 ? (stats.imageTimes.at(-1) - stats.imageTimes[0]) / 1000 : 0;
  const s = {
    connectMs: stats.connectMs, statusMs: stats.statusMs, firstImageMs: stats.firstImageMs,
    images: stats.images, same: stats.same, refresh: stats.refresh, errors: stats.errors, pongs: stats.pongs,
    bytes: stats.bytes, imageBytes: stats.imageBytes, durationMs: elapsed(),
    bytesPerSec: Math.round(stats.bytes / (elapsed() / 1000)),
    imageFps: span > 0 ? +((stats.imageTimes.length - 1) / span).toFixed(2) : undefined,
    cmsMedian: median(stats.cms), cmsP90: pct(stats.cms, 90),
    emsMedian: median(stats.ems), emsP90: pct(stats.ems, 90),
    rttMedian: median(stats.rtt), offsetMs: offsetMs(),
    latencyMedian: median(stats.latency), latencyP90: pct(stats.latency, 90),
    imagesBySize: stats.sizes,
  };
  if (opts.vp8) {
    const sum = (xs) => xs.reduce((a, x) => a + x, 0);
    s.vp8 = {
      keyFrames: stats.keyFrames, firstFrameKey: stats.firstFrameKey,
      keyBytesMedian: median(stats.keyBytes), keyBytesMax: stats.keyBytes.length ? Math.max(...stats.keyBytes) : undefined,
      deltaBytesMedian: median(stats.deltaBytes), deltaBytesP90: pct(stats.deltaBytes, 90),
      kbitPerSec: span > 0 ? Math.round((sum(stats.keyBytes) + sum(stats.deltaBytes)) * 8 / 1000 / (elapsed() / 1000)) : undefined,
      cvmsMedian: median(stats.cvms), cvmsP90: pct(stats.cvms, 90),
      keyRequests: stats.keyRequests,
    };
    s.perFiveSeconds = stats.perFiveSeconds.map((b) => ({
      t: b.t, fps: +(b.images / 5).toFixed(1), kibps: Math.round(b.kib / 5), latencyMedian: median(b.latency),
    }));
  }
  if (opts.adapt || opts.rate) {
    s.perFiveSeconds = stats.perFiveSeconds.map((b) => ({
      t: b.t, fps: +(b.images / 5).toFixed(1), kibps: Math.round(b.kib / 5), latencyMedian: median(b.latency),
    }));
  }
  if (opts.adapt) s.adapt = decisions;
  // Frame-rate steadiness: images per whole second (the first 2 s and the last partial second are
  // left out), and the spread of the intervals between images.
  while (stats.perSecond.length < Math.floor(elapsed() / 1000)) stats.perSecond.push(0);
  const secs = stats.perSecond.slice(2, Math.floor(elapsed() / 1000));
  if (secs.length > 0) {
    const mean = secs.reduce((a, x) => a + x, 0) / secs.length;
    const sd = Math.sqrt(secs.reduce((a, x) => a + (x - mean) ** 2, 0) / secs.length);
    const gaps = stats.imageTimes.slice(1).map((t, i) => t - stats.imageTimes[i]);
    s.steadiness = {
      seconds: secs.length, fpsMean: +mean.toFixed(2), fpsSd: +sd.toFixed(2), fpsMin: Math.min(...secs), fpsMax: Math.max(...secs),
      intervalMedian: median(gaps), intervalP90: pct(gaps, 90), intervalP99: pct(gaps, 99),
      deltaEmsMedian: median(stats.deltaEms), deltaEmsP90: pct(stats.deltaEms, 90), keyEmsMedian: median(stats.keyEms),
    };
    s.perSecond = secs;
  }
  return s;
}

function finish(code, why) {
  if (done) return;
  done = true;
  clearInterval(keepaliveTimer);
  if (why) out(why);
  ivfClose();
  const s = summary();
  process.stderr.write(`summary ${JSON.stringify(s)}\n`);
  sock.destroy();
  process.exit(code);
}

function sendKeepalive() {
  if (done || sock.destroyed) return;
  seq++;
  const now = Date.now();
  pingSent.set(seq, now);
  lastKeepaliveAt = now;
  sock.write(`{"keepalive":${seq}}\n`);
}

function onPong(n, ts) {
  stats.pongs++;
  const sent = pingSent.get(n);
  const now = Date.now();
  if (sent !== undefined) {
    pingSent.delete(n);
    const rtt = now - sent;
    stats.rtt.push(rtt);
    offsets.push(ts - (sent + rtt / 2));
  }
  out(`pong ${n} ts ${ts}${sent !== undefined ? ` rtt ${now - sent} ms` : ''}`);
}

function onFatal(error) {
  out(`fatal ${error}`);
  if (opts.expectExpiry !== undefined) {
    if (error !== 'lease expired') return finish(1, `expected lease expired, got ${error}`);
    const since = lastKeepaliveAt ?? status.at;
    const after = (Date.now() - since) / 1000;
    const ok = Math.abs(after - opts.expectExpiry) <= 1;
    return finish(ok ? 0 : 1, `lease expired ${after.toFixed(2)} s after the ${lastKeepaliveAt ? 'last keepalive' : 'status line'} (expected ${opts.expectExpiry} ± 1)`);
  }
  finish(1);
}

function onHeader(h, payload) {
  if (h.pong !== undefined) return onPong(h.pong, h.ts);
  if (h.settings !== undefined) return out(`settings ${(elapsed() / 1000).toFixed(2)} s ${JSON.stringify(h)}`);
  if (h.ok === false) return onFatal(h.error);
  if (h.same) {
    stats.same++;
    return out(`frame ${h.frame} same`);
  }
  if (h.error !== undefined) {
    stats.errors++;
    return out(`frame ${h.frame} error ${h.error}`);
  }
  const now = Date.now();
  let magic;
  if (h.format === 'vp8') {
    const key = isVp8Key(payload);
    magic = key === (h.key === true) && (payload[0] & 1) === (h.key ? 0 : 1);
    if (stats.firstFrameKey === undefined) stats.firstFrameKey = key;
    if (key) {
      stats.keyFrames++;
      stats.keyBytes.push(payload.length);
      while (pendingKeyRequests.length > 0) {
        const at = pendingKeyRequests.shift();
        stats.keyRequests.push({ at: +(at / 1000).toFixed(2), keyAfterMs: elapsed() - at });
      }
    } else {
      stats.deltaBytes.push(payload.length);
    }
    if (h.cvms !== undefined) stats.cvms.push(h.cvms);
    ivfOpen(h.size[0], h.size[1]);
    ivfFrame(h.pts, payload);
  } else {
    magic = h.format === 'png' ? isPng(payload) : isJpeg(payload);
  }
  stats.images++;
  // Refreshes of an idle screen (agent 1.8.0) are not screen changes: counted apart from the rate.
  if (h.refresh) stats.refresh++;
  else {
    const second = Math.floor(elapsed() / 1000);
    while (stats.perSecond.length <= second) stats.perSecond.push(0);
    stats.perSecond[second]++;
    stats.imageTimes.push(now);
    if (h.format === 'vp8' && h.ems !== undefined) (h.key ? stats.keyEms : stats.deltaEms).push(h.ems);
  }
  stats.imageBytes += payload.length;
  if (stats.firstImageMs === undefined) stats.firstImageMs = elapsed();
  if (h.cms !== undefined) stats.cms.push(h.cms);
  if (h.ems !== undefined) stats.ems.push(h.ems);
  const off = offsetMs();
  let lat = '';
  if (off !== undefined && typeof h.ts === 'number') {
    const l = now - (h.ts - off);
    stats.latency.push(l);
    lat = ` latency ${Math.round(l)} ms`;
  }
  const timing = h.cms !== undefined ? ` cms ${h.cms} ems ${h.ems}` : '';
  const timingVp8 = h.format === 'vp8' ? ` ${h.key ? 'KEY' : h.refresh ? 'refresh' : 'delta'} pts ${h.pts} ems ${h.ems} cvms ${h.cvms}${h.pace !== undefined ? ` pace ${h.pace}` : ''}` : '';
  const adaptInfo = h.q !== undefined || h.kbps !== undefined || h.rtt !== undefined ? ` q ${h.q ?? h.kbps ?? '-'} rtt ${h.rtt ?? '-'} skips ${h.skips}/${h.ticks}` : '';
  out(`frame ${h.frame} image ${h.format} ${payload.length} B ${magic ? 'magic-ok' : 'MAGIC-BAD'} ${h.size?.join('x') ?? ''}${timing}${timingVp8}${adaptInfo}${lat}`);
  if (!magic) return finish(1, 'bad image magic');
  const sizeKey = h.format === 'vp8' ? `${h.size?.join('x')} ${h.kbps ?? '?'}k` : `${h.size?.join('x')} q${h.q ?? '?'}`;
  stats.sizes[sizeKey] = (stats.sizes[sizeKey] ?? 0) + 1;
  const bucket = Math.floor(elapsed() / 5000);
  while (stats.perFiveSeconds.length <= bucket) stats.perFiveSeconds.push({ t: stats.perFiveSeconds.length * 5, images: 0, kib: 0, latency: [] });
  stats.perFiveSeconds[bucket].images++;
  stats.perFiveSeconds[bucket].kib += payload.length / 1024;
  if (off !== undefined) stats.perFiveSeconds[bucket].latency.push(now - (h.ts - off));
  if (opts.saveLast) writeFileSync(opts.saveLast, payload);
  if (opts.binary && !opts.noAck) {
    const ack = `{"ack":${h.frame}}\n`;
    if (opts.ackDelay) setTimeout(() => { if (!done && !sock.destroyed) sock.write(ack); }, opts.ackDelay);
    else sock.write(ack);
  }
  if (adapt && Array.isArray(h.screen) && Array.isArray(h.size)) {
    const d = adapt.onFrame({
      at: now, frame: h.frame, bytes: payload.length, width: h.size[0], screenWidth: h.screen[0], screenHeight: h.screen[1],
      q: h.format === 'vp8' ? h.kbps : h.q, rtt: h.rtt, rttFrame: h.rttFrame, ticks: h.ticks, skips: h.skips, ems: h.ems,
      key: h.key === true, refresh: h.refresh === true, cvms: h.cvms,
    });
    if (d) {
      const size = `${d.width}x${adaptModule.scaledHeight(d.width, h.screen[0], h.screen[1])}`;
      decisions.push({ t: +(elapsed() / 1000).toFixed(2), direction: d.direction, level: d.level, size, quality: d.quality, cause: d.cause, reason: d.reason });
      const unit = opts.vp8 ? ' kbit/s' : '';
      process.stdout.write(`adapt ${(elapsed() / 1000).toFixed(2)} s ${d.direction} to ${size} ${opts.vp8 ? '' : 'q'}${d.quality}${unit} (level ${d.level + 1} of ${d.levels}: ${d.reason})\n`);
      sock.write(opts.vp8 ? adaptModule.setLine(d, 'vp8') : adaptModule.setLine(d));
    }
  }
  if (opts.frames !== undefined && stats.images >= opts.frames && !opts.windowCheck) finish(0);
}

/* ------------------------------------------------------------ parsing */

let state = 'status';
let buf = Buffer.alloc(0);
let need = 0;
let header;

function onStatusLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return finish(1, `corrupt status line: ${line.slice(0, 200)}`);
  }
  out(line);
  if (opts.ping) return finish(o.ok === true ? 0 : 1);
  if (o.ok !== true) return onFatal(o.error);
  status = { ...o, at: Date.now() };
  stats.statusMs = elapsed();
  windowSize = o.window;
  if (adaptModule && o.adapt === true) {
    adapt = o.encoding === 'vp8'
      ? new adaptModule.AdaptiveQuality({ fps: o.fps, width: o.width, quality: o.bitrate, codec: 'vp8', window: o.window })
      : new adaptModule.AdaptiveQuality({ fps: o.fps, width: o.width, quality: o.quality });
  } else if (opts.adapt) {
    out('the agent did not turn on adaptive quality (no "adapt" in the status line)');
  }
  if (opts.binary && o.encoding !== (opts.vp8 ? 'vp8' : 'binary')) return finish(1, `unexpected encoding ${o.encoding}`);
  for (const at of opts.keyframeAt ?? []) {
    setTimeout(() => {
      if (done || sock.destroyed) return;
      pendingKeyRequests.push(elapsed());
      sock.write('{"keyframe":true}\n');
      out(`keyframe requested at ${(elapsed() / 1000).toFixed(2)} s`);
    }, Math.max(0, at * 1000 - elapsed()));
  }
  if (o.lease !== undefined && !opts.noKeepalive) {
    sendKeepalive();
    keepaliveTimer = setInterval(sendKeepalive, opts.keepaliveMs);
  }
  if (opts.badUpstream) {
    sock.write(`${'x'.repeat(300)}\n`);
    const at = Date.now();
    sock.once('close', () => finish(Date.now() - at <= 1000 ? 0 : 1, `daemon disconnected ${Date.now() - at} ms after the 300-byte line`));
    setTimeout(() => finish(1, 'daemon did not disconnect within 3 s'), 3000);
  }
  if (opts.windowCheck) {
    setTimeout(() => {
      const ok = stats.images === windowSize;
      finish(ok ? 0 : 1, `window-check: ${stats.images} image records without acks, window ${windowSize}`);
    }, 5000);
  }
  state = opts.binary ? 'length' : 'text';
}

function onTextLine(line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return finish(1, `corrupt line: ${line.slice(0, 200)}`);
  }
  if (o.data !== undefined) {
    const payload = Buffer.from(o.data, 'base64');
    delete o.data;
    return onHeader(o, payload);
  }
  onHeader(o, Buffer.alloc(0));
}

function pump() {
  for (;;) {
    if (done) return;
    if (state === 'status' || state === 'text') {
      const i = buf.indexOf(0x0a);
      if (i < 0) {
        if (state === 'status' && buf.length > 4096) return finish(1, 'corrupt stream (status line too long)');
        return;
      }
      const line = buf.subarray(0, i).toString('utf8');
      buf = buf.subarray(i + 1);
      if (state === 'status') onStatusLine(line);
      else onTextLine(line);
      continue;
    }
    if (state === 'length') {
      if (buf.length < 4) return;
      need = buf.readUInt32BE(0);
      buf = buf.subarray(4);
      if (need < 2 || need > 4096) return finish(1, `framing error: header length ${need}`);
      state = 'header';
      continue;
    }
    if (state === 'header') {
      if (buf.length < need) return;
      try {
        header = JSON.parse(buf.subarray(0, need).toString('utf8'));
      } catch {
        return finish(1, 'framing error: header is not JSON');
      }
      buf = buf.subarray(need);
      if (typeof header.bytes === 'number') {
        if (header.bytes < 1 || header.bytes > 16 * 1024 * 1024) return finish(1, `framing error: bytes ${header.bytes}`);
        need = header.bytes;
        state = 'payload';
        continue;
      }
      state = 'length';
      onHeader(header, Buffer.alloc(0));
      continue;
    }
    if (state === 'payload') {
      if (buf.length < need) return;
      const payload = Buffer.from(buf.subarray(0, need));
      buf = buf.subarray(need);
      state = 'length';
      onHeader(header, payload);
      continue;
    }
  }
}

/* ------------------------------------------------------------ main */

const sock = net.connect(opts.socket);
sock.on('connect', () => {
  stats.connectMs = elapsed();
  let req;
  if (opts.ping) {
    req = { cmd: 'ping' };
  } else {
    req = { cmd: 'mirror' };
    if (opts.fps !== undefined) req.fps = opts.fps;
    if (opts.width !== undefined) req.width = opts.width;
    if (opts.quality !== undefined) req.quality = opts.quality;
    if (opts.binary) req.encoding = opts.vp8 ? 'vp8' : 'binary';
    if (opts.bitrate !== undefined) req.bitrate = opts.bitrate;
    if (opts.lease !== undefined) req.lease = opts.lease;
    if (opts.adapt) req.adapt = true;
    if (opts.input) req.input = true;
    if (opts.phoneState) req.phoneState = true;
    if (opts.client !== undefined) req.client = opts.client;
  }
  sock.write(`${JSON.stringify(req)}\n`);
  if (opts.duration !== undefined) setTimeout(() => finish(0), opts.duration * 1000);
});
function deliver(d) {
  stats.bytes += d.length;
  buf = buf.length ? Buffer.concat([buf, d]) : d;
  pump();
}

/* A slow link: bytes wait in `link` and are let through at the scheduled rate. */
const link = [];
let linkBytes = 0;
let linkTimer;
let linkLast = Date.now();
let credit = 0;
const LINK_HIGH = 64 * 1024;
const LINK_LOW = 16 * 1024;
function currentKibps() {
  let r = 0;
  for (const step of opts.rate ?? []) if (elapsed() >= step.at) r = step.kibps;
  return r;
}
function drainLink() {
  linkTimer = undefined;
  const now = Date.now();
  const kibps = currentKibps();
  // A burst of at most 20 ms worth of bytes: an image takes its transfer time, as on a real link.
  const burst = Math.max(1500, (20 * kibps * 1024) / 1000);
  credit = kibps === 0 ? Infinity : Math.min(credit + ((now - linkLast) * kibps * 1024) / 1000, burst);
  linkLast = now;
  while (link.length > 0 && credit > 0 && !done) {
    const head = link[0];
    const n = Math.min(head.length, credit === Infinity ? head.length : Math.floor(credit));
    if (n <= 0) break;
    const part = n === head.length ? link.shift() : head.subarray(0, n);
    if (n !== head.length) link[0] = head.subarray(n);
    linkBytes -= n;
    if (credit !== Infinity) credit -= n;
    deliver(part);
  }
  if (credit === Infinity) credit = 0;
  if (linkBytes < LINK_LOW && sock.isPaused()) sock.resume();
  if ((link.length > 0 || opts.rate.some((s) => s.at > elapsed())) && !done) linkTimer = setTimeout(drainLink, 10);
}

sock.on('data', (d) => {
  if (!opts.rate) return deliver(d);
  link.push(d);
  linkBytes += d.length;
  if (linkBytes > LINK_HIGH) sock.pause();
  if (!linkTimer) linkTimer = setTimeout(drainLink, 0);
});
sock.on('error', (err) => finish(1, `socket error: ${err.code ?? err.message}`));
sock.on('close', () => {
  if (opts.badUpstream && status) return; // handled by the once('close') above
  finish(state === 'status' ? 1 : opts.frames === undefined && opts.duration === undefined ? 0 : 1, 'connection closed');
});
