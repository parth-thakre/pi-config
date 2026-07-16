const OMITTED = "\n[… bytes omitted …]\n";

function utf8Head(buffer: Buffer, maxBytes: number) {
  let end = Math.min(buffer.length, Math.max(0, maxBytes));
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(buffer: Buffer, maxBytes: number) {
  let start = Math.max(0, buffer.length - Math.max(0, maxBytes));
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

/** Bounded UTF-8 initial-plus-tail retention for live/session snapshot fields. */
export function boundInitialTail(text: string, maxBytes: number) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(OMITTED, "utf8");
  if (maxBytes <= markerBytes) return utf8Head(buffer, maxBytes);
  const available = maxBytes - markerBytes;
  const headBytes = Math.floor(available / 3);
  return `${utf8Head(buffer, headBytes)}${OMITTED}${utf8Tail(
    buffer,
    available - headBytes,
  )}`;
}
