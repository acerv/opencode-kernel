// Adapted from pi-smarter/extensions/lore.ts (MIT).
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { decodeXml, diffText, HttpError, MAX_BYTES, request, text, yesterday, type IO } from "./io.js";

const aliases: Record<string, string> = {
  "linux-kernel": "lkml", arm: "linux-arm-kernel", "linux-arm": "linux-arm-kernel",
  riscv: "linux-riscv", fs: "linux-fsdevel", fsdevel: "linux-fsdevel",
  mm: "linux-mm", ext4: "linux-ext4", bcachefs: "linux-bcachefs",
  wireless: "linux-wireless", block: "linux-block", io_uring: "io-uring",
  rust: "rust-for-linux", usb: "linux-usb", pci: "linux-pci",
  crypto: "linux-crypto", scsi: "linux-scsi", pm: "linux-pm",
};

export const loreListSchema = z.object({
  list: z.string().optional().describe("Mailing list or alias; default all. Examples: netdev, arm, mm, fs, rust."),
  query: z.string().optional().describe("Public-inbox query or keyword filter."),
  limit: z.union([z.number().int().min(-1), z.literal("all")]).optional()
    .describe("Explicit count, or all. Omit for today and yesterday. Results capped at 1000."),
  all: z.boolean().optional().describe("Remove the default date filter; default false."),
  onlyOriginalSubmissions: z.boolean().optional().describe("Exclude replies; default true."),
});
export const loreReadSchema = z.object({
  target: z.string().min(1).describe("Lore URL or Message-ID."),
  includeComments: z.boolean().optional().describe("Include review discussion; default true."),
  maxDiffLines: z.number().int().min(20).max(1000).optional().describe("Diff lines per patch; default 150."),
});

export function resolveList(raw = "all"): string {
  const name = raw.trim().toLowerCase() || "all";
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("Invalid mailing list name");
  return aliases[name] ?? name;
}

export function subjectInfo(subject: string) {
  if (/^\s*re:\s*/i.test(subject)) return { type: "reply" };
  const match = subject.match(/\[[^\]]*?\b(\d+)\/(\d+)\]/);
  if (!match) return { type: "patch", index: 1, total: 1 };
  return { type: +match[1] === 0 ? "cover" : "patch", index: +match[1], total: +match[2] };
}

export interface ListItem {
  title: string;
  author: string;
  date: string;
  url: string;
  msgId: string;
  snippet: string;
}

export function parseAtom(xml: string): ListItem[] {
  if (!/<feed\b/.test(xml)) throw new Error("Lore returned an invalid Atom feed (possibly an access challenge)");
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const value = (tag: string) => decodeXml(entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "");
    const url = decodeXml(entry.match(/<link\b[^>]*href="([^"]+)"/)?.[1] ?? "");
    return {
      title: value("title"), author: value("name"), date: value("updated"), url,
      msgId: decodeURIComponent(url.split("/").filter(Boolean).at(-1) ?? ""),
      snippet: value("content").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160),
    };
  });
}

export async function listLore(input: z.infer<typeof loreListSchema>, io: IO = {}): Promise<string> {
  const name = resolveList(input.list);
  const all = input.all || input.limit === "all" || (typeof input.limit === "number" && input.limit <= 0);
  const recent = !all && input.limit === undefined;
  const count = Math.min(typeof input.limit === "number" && input.limit > 0 ? input.limit : 1000, 1000);
  const clauses = [input.onlyOriginalSubmissions !== false ? "s:PATCH AND NOT s:Re:" : "",
    input.query ? `(${input.query})` : ""].filter(Boolean);
  const query = [...clauses, ...(recent ? [`d:${yesterday(true)}..`] : [])].join(" AND ");
  let source = "";
  let note = "";
  let items: ListItem[] = [];
  const seen = new Set<string>();
  async function page(q: string, offset: number) {
    const url = q ? `https://lore.kernel.org/${name}/?q=${encodeURIComponent(q)}&x=A&o=${offset}` :
      `https://lore.kernel.org/${name}/new.atom?o=${offset}`;
    source ||= url;
    try { return parseAtom(await text(url, io)); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return [];
      throw error;
    }
  }
  for (let offset = 0; items.length < count && offset < 10000; offset += 200) {
    const rows = await page(query, offset);
    const fresh = rows.filter((item) => {
      const key = item.msgId || item.url || item.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    items.push(...fresh);
    if (rows.length < 200 || !fresh.length) break;
  }
  if (recent && !items.length) {
    items = (await page(clauses.join(" AND "), 0)).slice(0, 20);
    note = "No submissions from today or yesterday. Showing up to 20 recent submissions instead.";
  }
  if (items.length >= 1000) note = "Results capped at 1000. Narrow the query for more detail.";
  items = items.slice(0, count);
  return [`# Lore Patches: ${name} (${items.length})`, `Source: ${source}`, note,
    ...items.map((item, i) => `\n## ${i + 1}. ${item.title}\n` +
      `Author: ${item.author}\nDate: ${item.date}\nMessage-ID: ${item.msgId}\n` +
      `URL: ${item.url}\nType: ${subjectInfo(item.title).type}\n${item.snippet}`),
    ...(!items.length ? ["No patches found."] : []),
  ].filter(Boolean).join("\n");
}

function decodeBytes(value: string, charset = "utf-8"): string {
  const bytes = Buffer.from(value.replace(/=([\da-f]{2})/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))), "latin1");
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return bytes.toString("utf8"); }
}

export function decodeHeader(value: string): string {
  return value.replace(/(\?=)\s+(?==\?)/g, "$1").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_, charset, encoding, data) => {
      if (encoding.toLowerCase() === "q") return decodeBytes(data.replaceAll("_", " "), charset);
      try { return new TextDecoder(charset).decode(Buffer.from(data, "base64")); }
      catch { return Buffer.from(data, "base64").toString("utf8"); }
    });
}

function headersAndBody(raw: string): { headers: Record<string, string>; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) throw new Error("Malformed mail: missing header/body separator");
  const headers: Record<string, string> = {};
  for (const line of raw.slice(0, match.index).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: raw.slice(match.index + match[0].length) };
}

function mailBody(headers: Record<string, string>, body: string, depth = 0): string {
  const type = headers["content-type"] ?? "text/plain";
  if (depth > 8) throw new Error("MIME nesting is too deep");
  if (/multipart\//i.test(type)) {
    const boundary = type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
    if (boundary) {
      for (const part of body.split(`--${boundary[1] ?? boundary[2]}`).slice(1)) {
        if (part.startsWith("--")) break;
        const parsed = headersAndBody(part.replace(/^\r?\n/, ""));
        if (/^(text\/plain|multipart\/)/i.test(parsed.headers["content-type"] ?? "text/plain")) {
          return mailBody(parsed.headers, parsed.body, depth + 1);
        }
      }
    }
  }
  const encoding = headers["content-transfer-encoding"]?.toLowerCase();
  const charset = type.match(/charset="?([^";\s]+)/i)?.[1] ?? "utf-8";
  if (encoding === "quoted-printable") return decodeBytes(body.replace(/=\r?\n/g, ""), charset);
  if (encoding === "base64") {
    try { return new TextDecoder(charset).decode(Buffer.from(body, "base64")); }
    catch { return Buffer.from(body, "base64").toString("utf8"); }
  }
  return body.replace(/^>From /gm, "From ");
}

export interface Mail {
  id: string; subject: string; author: string; date: string; parent: string; body: string;
}

function cleanId(value: string): string { return value.trim().replace(/^<|>$/g, ""); }

export function parseMbox(mbox: string): Mail[] {
  const messages = mbox.split(/\r?\n(?=From \S+[^\r\n]*\r?\n)/).filter((item) => item.trim());
  const parsed = messages.map((raw) => {
    const { headers, body } = headersAndBody(raw);
    if (!headers.subject || !headers["message-id"]) throw new Error("Malformed mail: missing Subject or Message-ID");
    return {
      id: cleanId(headers["message-id"]), subject: decodeHeader(headers.subject),
      author: decodeHeader(headers.from ?? "Unknown"), date: headers.date ?? "",
      parent: cleanId(headers["in-reply-to"] ?? ""), body: mailBody(headers, body).trim(),
    };
  });
  if (!parsed.length) throw new Error("No mail messages found");
  return parsed;
}

export function loreTarget(raw: string): { list: string; id: string } {
  let id = cleanId(raw);
  let list = "all";
  if (/^https?:\/\//.test(id)) {
    const url = new URL(id);
    if (url.hostname !== "lore.kernel.org") throw new Error("Expected a lore.kernel.org URL");
    const parts = url.pathname.split("/").filter(Boolean);
    list = resolveList(parts[0]);
    id = decodeURIComponent(parts[1] ?? "").replace(/\.(mbox(?:\.gz)?|raw)$/, "");
  }
  if (!id.includes("@") || /[\r\n]/.test(id)) throw new Error("Expected a Message-ID or Lore URL");
  return { list, id };
}

export function formatThread(messages: Mail[], url: string, includeComments = true, maxLines = 150): string {
  const cover = messages.find((mail) => subjectInfo(mail.subject).type === "cover");
  const patches = messages.filter((mail) => subjectInfo(mail.subject).type === "patch")
    .sort((a, b) => (subjectInfo(a.subject).index ?? 1) - (subjectInfo(b.subject).index ?? 1));
  const replies = messages.filter((mail) => subjectInfo(mail.subject).type === "reply");
  const map = new Map(messages.map((mail) => [mail.id, mail]));
  function root(reply: Mail) {
    let current = map.get(reply.parent);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (subjectInfo(current.subject).type !== "reply") return current.id;
      seen.add(current.id);
      current = map.get(current.parent);
    }
  }
  const format = (mail: Mail) => {
    const split = mail.body.search(/^diff --git /m);
    const body = split < 0 ? mail.body : mail.body.slice(0, split) +
      "\n```diff\n" + diffText(mail.body.slice(split), maxLines) + "\n```";
    return `### ${mail.subject}\nAuthor: ${mail.author}\nDate: ${mail.date}\n` +
      `Message-ID: ${mail.id}\n\n${body}`;
  };
  const output = [`# ${cover?.subject ?? patches[0]?.subject ?? "Lore discussion"}`, `URL: ${url}`,
    `Patches: ${patches.length}; review comments: ${replies.length}`];
  for (const mail of [...(cover ? [cover] : []), ...patches]) {
    output.push(format(mail));
    if (includeComments) output.push(...replies.filter((reply) => root(reply) === mail.id).map(format));
  }
  if (includeComments) output.push(...replies.filter((reply) => !root(reply)).map(format));
  return output.join("\n\n");
}

export async function readLore(input: z.infer<typeof loreReadSchema>, io: IO = {}): Promise<string> {
  const { list, id } = loreTarget(input.target);
  const base = `https://lore.kernel.org/${list}/${encodeURIComponent(id)}/`;
  const fallback = `https://lore.kernel.org/all/${encodeURIComponent(id)}/`;
  const urls = [...new Set([base + "t.mbox.gz", fallback + "t.mbox.gz", base + "raw", fallback + "raw"])];
  let lastError: unknown;
  for (const url of urls) {
    let bytes: Buffer;
    try { bytes = await request(url, io); }
    catch (error) {
      // Only absent endpoints permit fallback; never swallow approval or cancellation errors.
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      lastError = error;
      continue;
    }
    try {
      const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ?
        gunzipSync(bytes, { maxOutputLength: MAX_BYTES }).toString("utf8") : bytes.toString("utf8");
      return formatThread(parseMbox(raw), base, input.includeComments !== false, input.maxDiffLines ?? 150);
    } catch (error) { lastError = error; }
  }
  throw new Error(`Could not read Lore thread: ${String(lastError)}`);
}
