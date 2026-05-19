export function safeFilePart(value, fallback = 'item') {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|%#{}^~[\]`]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
    .slice(0, 80);

  return cleaned || fallback;
}

export function extensionFromUrl(url, fallback = 'jpg') {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
    if (match) {
      return match[1].toLowerCase();
    }
  } catch {
    return fallback;
  }

  return fallback;
}
