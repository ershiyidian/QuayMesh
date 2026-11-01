export function completeUtf8PrefixStart(bytes: Buffer): number {
  let index = 0;
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index++;
  return index;
}
export function completeUtf8PrefixEnd(bytes: Buffer): number {
  if (!bytes.length) return 0;
  let index = bytes.length - 1;
  while (index >= 0 && (bytes[index]! & 0xc0) === 0x80) index--;
  if (index < 0) return 0;
  const lead = bytes[index]!;
  const needed = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return bytes.length - index < needed ? index : bytes.length;
}
export function fitUtf8(text: string, maximumBytes: number): string {
  let size = 0, result = "";
  for (const point of text) {
    const bytes = Buffer.byteLength(point);
    if (size + bytes > maximumBytes && result) break;
    result += point; size += bytes;
    if (size >= maximumBytes) break;
  }
  return result;
}


/** Text may contain replacement characters; the cursor always counts source bytes. */
export function readUtf8BytePage(bytes: Buffer, maximumBytes: number, terminal: boolean): { chunk: string; consumedBytes: number } {
  let offset = 0, size = 0, chunk = "";
  while (offset < bytes.length) {
    const lead = bytes[offset]!;
    const width = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2
      : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    let consumed = 1, value = "\uFFFD";
    if (width) {
      while (consumed < width && offset + consumed < bytes.length) {
        const byte = bytes[offset + consumed]!;
        const valid = byte >= 0x80 && byte <= 0xbf && (consumed !== 1
          || (lead !== 0xe0 || byte >= 0xa0) && (lead !== 0xed || byte <= 0x9f)
            && (lead !== 0xf0 || byte >= 0x90) && (lead !== 0xf4 || byte <= 0x8f));
        if (!valid) break;
        consumed++;
      }
      if (consumed === width) value = bytes.subarray(offset, offset + width).toString("utf8");
      else if (offset + consumed === bytes.length && !terminal) break;
    }
    const renderedBytes = Buffer.byteLength(value);
    if (chunk && size + renderedBytes > maximumBytes) break;
    chunk += value; size += renderedBytes; offset += consumed;
    if (size >= maximumBytes) break;
  }
  return { chunk, consumedBytes: offset };
}
