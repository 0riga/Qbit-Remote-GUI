/**
 * Minimal bencode decoder for .torrent files (CommonJS, no ESM).
 * Decodes strings, integers, lists, dictionaries.
 */
function decode(buffer, start) {
  start = start || 0;
  const c = buffer[start];
  if (c === 0x69) {
    const end = buffer.indexOf(0x65, start);
    const str = buffer.toString('ascii', start + 1, end);
    return { v: parseInt(str, 10), end: end + 1 };
  }
  if (c >= 0x30 && c <= 0x39) {
    const colon = buffer.indexOf(0x3a, start);
    const len = parseInt(buffer.toString('ascii', start, colon), 10);
    const end = colon + 1 + len;
    return { v: buffer.slice(colon + 1, end), end };
  }
  if (c === 0x6c) {
    const list = [];
    let pos = start + 1;
    while (buffer[pos] !== 0x65) {
      const r = decode(buffer, pos);
      list.push(r.v);
      pos = r.end;
    }
    return { v: list, end: pos + 1 };
  }
  if (c === 0x64) {
    const dict = {};
    let pos = start + 1;
    while (buffer[pos] !== 0x65) {
      const k = decode(buffer, pos);
      pos = k.end;
      const val = decode(buffer, pos);
      pos = val.end;
      const key = Buffer.isBuffer(k.v) ? k.v.toString('utf8') : String(k.v);
      dict[key] = val.v;
    }
    return { v: dict, end: pos + 1 };
  }
  throw new Error('Invalid bencode at ' + start);
}

module.exports = {
  decode: (buffer) => decode(buffer, 0).v,
};
