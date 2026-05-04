export interface TruncatedText {
  text: string;
  truncated: boolean;
}

export function truncateText(text: string, maxBytes: number): TruncatedText {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };

  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };

  const marker = `\n[flarbor-verify: output truncated to ${maxBytes} bytes]\n`;
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  if (markerBytes >= maxBytes) {
    return {
      text: new TextDecoder().decode(new TextEncoder().encode(marker).slice(0, maxBytes)),
      truncated: true,
    };
  }

  const budget = Math.max(0, maxBytes - markerBytes);
  return { text: sliceValidUtf8Prefix(bytes, budget) + marker, truncated: true };
}

function sliceValidUtf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  for (let end = maxBytes; end >= 0 && end >= maxBytes - 3; end -= 1) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return "";
}
