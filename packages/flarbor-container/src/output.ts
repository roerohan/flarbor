export interface TruncatedText {
  text: string;
  truncated: boolean;
}

export function truncateText(text: string, maxBytes: number): TruncatedText {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };

  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };

  const marker = `\n[flarbor-container: output truncated to ${maxBytes} bytes]\n`;
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  if (markerBytes >= maxBytes) {
    return {
      text: new TextDecoder().decode(new TextEncoder().encode(marker).slice(0, maxBytes)),
      truncated: true,
    };
  }

  const budget = Math.max(0, maxBytes - markerBytes);
  const sliced = bytes.slice(0, budget);

  return {
    text: new TextDecoder().decode(sliced) + marker,
    truncated: true,
  };
}
