export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT = 100_000;

export interface IO {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  authorize?: (action: string, resources: string[]) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} fetching ${url}`);
  }
}

export async function request(url: string, io: IO = {}): Promise<Buffer> {
  const limit = io.maxBytes ?? MAX_BYTES;
  let target = new URL(url);
  const signal = AbortSignal.any([
    ...(io.signal ? [io.signal] : []), AbortSignal.timeout(io.timeoutMs ?? 20_000),
  ]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    if (target.protocol !== "https:" || target.username || target.password) {
      throw new Error("Only HTTPS URLs without embedded credentials are supported");
    }
    await io.authorize?.("webfetch", [target.href]);
    signal.throwIfAborted();
    const response = await (io.fetch ?? fetch)(target.href, {
      headers: { "User-Agent": "opencode-kernel/0.1", Accept: "*/*" },
      signal, redirect: "manual",
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without a Location header: ${target.href}`);
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, target.href);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error(`Response exceeds ${limit} bytes: ${target.href}`);
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many HTTP redirects");
}

export async function text(url: string, io: IO = {}): Promise<string> {
  return (await request(url, io)).toString("utf8");
}

export async function json<T>(url: string, io: IO = {}): Promise<T> {
  try {
    return JSON.parse(await text(url, io)) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON from ${url}`);
    throw error;
  }
}

export function bounded(content: string): string {
  if (content.length <= MAX_OUTPUT) return content;
  return content.slice(0, MAX_OUTPUT) +
    "\n\n[Output truncated at 100000 characters. Narrow the query or read an individual item.]";
}

export function diffText(diff: string, maxLines = 150): string {
  const lines = diff.split("\n");
  return lines.length <= maxLines ? diff : lines.slice(0, maxLines).join("\n") +
    `\n[Diff truncated: ${lines.length - maxLines} lines omitted]`;
}

export function yesterday(compact = false): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  const value = date.toISOString().slice(0, 10);
  return compact ? value.replaceAll("-", "") : value;
}

export function decodeXml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? raw;
    const hex = entity[1].toLowerCase() === "x";
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : raw;
  });
}
