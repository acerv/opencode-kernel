// Adapted from pi-smarter/extensions/patchwork.ts (MIT).
import { z } from "zod";
import { diffText, HttpError, json, yesterday, type IO } from "./io.js";
import { resolveList } from "./lore.js";

const origin = "https://patchwork.kernel.org";
const aliases: Record<string, string> = {
  netdev: "netdevbpf", net: "netdevbpf", bpf: "netdevbpf", dm: "dm-devel",
  dri: "dri-devel", drm: "dri-devel", intel: "intel-gfx", cifs: "cifs-client",
};
const linuxNames = new Set([
  "btrfs", "nfs", "nvme", "rdma", "media", "kbuild", "kselftest", "acpi",
  "input", "iio", "hwmon", "s390",
]);
export function resolveProject(raw = "all"): string {
  const name = raw.trim().toLowerCase() || "all";
  const plain = name.replace(/^linux-/, "");
  return aliases[plain] ?? (linuxNames.has(plain) ? `linux-${plain}` : resolveList(name));
}

export const patchworkListSchema = z.object({
  subsystem: z.string().optional().describe("Project or alias: ltp, netdev, bpf, arm, mm, all. Default all."),
  project: z.string().optional().describe("Alias for subsystem; subsystem takes precedence."),
  query: z.string().optional().describe("Keyword filter."),
  limit: z.union([z.number().int().min(-1), z.literal("all")]).optional()
    .describe("Explicit count or all. Omit for today and yesterday. Maximum 1000 results."),
  all: z.boolean().optional().describe("Remove the default date filter; default false."),
  state: z.string().optional().describe("Patch state: new, under-review, accepted, superseded, rejected, rfc."),
});
export const patchworkReadSchema = z.object({
  target: z.string().optional().describe("Patchwork URL, numeric patch/series ID, or Message-ID."),
  url: z.string().optional().describe("Backward-compatible alias for target."),
}).refine((input) => Boolean(input.target?.trim() || input.url?.trim()), "Either target or url is required");

const ref = z.object({ id: z.number().int().positive(), url: z.string().optional() }).passthrough();
const person = z.object({ name: z.string().nullish(), email: z.string().nullish() }).passthrough();
const patchSchema = z.object({
  id: z.number().int().positive(), name: z.string(), url: z.string().optional(),
  web_url: z.string().optional(), msgid: z.string().optional(), date: z.string().optional(),
  content: z.string().nullish(), diff: z.string().nullish(), state: z.string().optional(),
  check: z.string().optional(), submitter: person.nullish(), comments: z.string().nullish(),
  project: z.object({ name: z.string().optional(), link_name: z.string().optional() }).optional(),
  series: z.array(ref.extend({ name: z.string().optional(), version: z.number().optional() })).optional(),
}).passthrough();
type Patch = z.infer<typeof patchSchema>;
const seriesSchema = z.object({
  id: z.number().int().positive(), name: z.string(), version: z.number().optional(),
  total: z.number().optional(), web_url: z.string().optional(),
  cover_letter: ref.nullish(), patches: z.array(ref).max(100),
}).passthrough();

function api(base: string, collection: string, id?: string | number): string {
  return `${base}/api/1.3/${collection}/${id === undefined ? "" : `${encodeURIComponent(id)}/`}`;
}

function sameOrigin(url: string, base: string): string {
  const target = new URL(url, base);
  if (target.origin !== base) throw new Error("Patchwork API links must remain on the selected origin");
  return target.href;
}

function pageRows(raw: unknown): { items: unknown[]; next?: string | null } {
  if (Array.isArray(raw)) return { items: raw };
  const page = z.object({ results: z.array(z.unknown()), next: z.string().nullish() }).parse(raw);
  return { items: page.results, next: page.next };
}

export async function listPatchwork(input: z.infer<typeof patchworkListSchema>, io: IO = {}): Promise<string> {
  const project = resolveProject(input.subsystem || input.project);
  const all = input.all || input.limit === "all" || (typeof input.limit === "number" && input.limit <= 0);
  const recent = !all && input.limit === undefined;
  const count = all ? 1000 : Math.min(typeof input.limit === "number" && input.limit > 0 ? input.limit : 1000, 1000);
  let source = "";
  async function batches(since: boolean, needed: number): Promise<Patch[]> {
    const rows: Patch[] = [];
    const seen = new Set<number>();
    let next: string | undefined;
    for (let page = 1; page <= 100 && rows.length < needed; page++) {
      const perPage = Math.min(needed - rows.length, 250);
      const query = new URLSearchParams({ order: "-id", per_page: String(perPage), page: String(page) });
      if (project !== "all") query.set("project", project);
      if (input.query) query.set("q", input.query);
      if (input.state) query.set("state", input.state);
      if (since) query.set("since", `${yesterday()}T00:00:00`);
      const url = next ?? `${api(origin, "patches")}?${query}`;
      source ||= url;
      const data = pageRows(await json(url, io));
      let added = 0;
      for (const raw of data.items) {
        const item = patchSchema.parse(raw);
        if (!seen.has(item.id)) { seen.add(item.id); rows.push(item); added++; }
      }
      if (!added || data.next === null || (data.next === undefined && data.items.length < perPage)) break;
      next = data.next ? sameOrigin(data.next, origin) : undefined;
    }
    return rows.slice(0, needed);
  }
  let rows = await batches(recent, count);
  let note = "";
  if (recent && !rows.length) {
    rows = await batches(false, 20);
    note = "No submissions from today or yesterday. Showing up to 20 recent submissions instead.";
  }
  if (rows.length >= 1000) note = "Results capped at 1000. Narrow the query for more detail.";
  return [`# Patchwork Patches: ${project} (${rows.length})`, `Source: ${source}`, note,
    ...rows.map((patch, i) => `\n## ${i + 1}. ${patch.name}\nID: ${patch.id}\n` +
      `Project: ${patch.project?.name ?? project}\nAuthor: ${author(patch.submitter)}\n` +
      `Date: ${patch.date ?? ""}\nState: ${patch.state ?? "unknown"}\nCheck: ${patch.check ?? "unknown"}\n` +
      `Message-ID: ${patch.msgid ?? ""}\nURL: ${patch.web_url ?? `${origin}/patch/${patch.id}/`}\n` +
      (patch.series?.length ? `Series: ${patch.series[0].name ?? ""} (ID ${patch.series[0].id})` : "")),
    ...(!rows.length ? ["No patches found."] : []),
  ].filter(Boolean).join("\n");
}

export function patchworkTarget(raw: string) {
  let base = origin;
  let value = raw.trim().replace(/^<|>$/g, "");
  let collection: "patches" | "series" | "covers" | undefined;
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use an HTTPS Patchwork URL without credentials");
    base = url.origin;
    const series = url.pathname.match(/\/series\/(\d+)/)?.[1] ?? url.searchParams.get("series");
    const item = url.pathname.match(/\/(patch(?:es)?|cover(?:s)?)\/([^/]+)/);
    if (series && /^\d+$/.test(series)) { collection = "series"; value = series; }
    else if (item) {
      collection = item[1].startsWith("cover") ? "covers" : "patches";
      value = decodeURIComponent(item[2]);
    } else throw new Error("Expected a Patchwork patch, cover, or series URL");
  }
  if (!/^\d+$/.test(value) && !value.includes("@")) throw new Error("Expected a numeric ID or Message-ID");
  return { base, collection, value };
}

function author(value: z.infer<typeof person> | null | undefined): string {
  return [value?.name, value?.email && `<${value.email}>`].filter(Boolean).join(" ") || "Unknown";
}

export async function readPatchwork(input: z.infer<typeof patchworkReadSchema>, io: IO = {}): Promise<string> {
  const { base, collection, value } = patchworkTarget(input.target || input.url || "");
  const numeric = /^\d+$/.test(value);
  async function lookup(kind: string) {
    const url = numeric ? api(base, kind, value) : `${api(base, kind)}?msgid=${encodeURIComponent(value)}`;
    try {
      const result = await json<unknown>(url, io);
      return numeric ? result : pageRows(result).items[0];
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }
  let series: z.infer<typeof seriesSchema> | undefined;
  let patch: Patch | undefined;
  let standaloneCover = false;
  for (const kind of collection ? [collection] : numeric ? ["patches", "series", "covers"] : ["patches", "covers"]) {
    const raw = await lookup(kind);
    if (!raw) continue;
    if (kind === "series") series = seriesSchema.parse(raw);
    else {
      patch = patchSchema.parse(raw);
      standaloneCover = kind === "covers";
      if (patch.series?.length) series = seriesSchema.parse(await json(api(base, "series", patch.series[0].id), io));
    }
    break;
  }
  if (!series && !patch) throw new Error(`Patchwork item not found: ${value}`);
  const warnings: string[] = [];
  async function comments(item: Patch): Promise<string> {
    if (!item.comments) return "No review comments recorded.";
    const result: string[] = [];
    const seen = new Set<string>();
    const first = new URL(sameOrigin(item.comments, base));
    first.searchParams.set("per_page", "100");
    first.searchParams.set("page", "1");
    let url = first.href;
    for (let page = 1; page <= 10; page++) {
      if (seen.has(url)) { warnings.push("Repeated comment page; remaining comments omitted."); break; }
      seen.add(url);
      let data: ReturnType<typeof pageRows>;
      try { data = pageRows(await json(url, io)); }
      catch (error) {
        if (!(error instanceof HttpError)) throw error;
        warnings.push(`Comments unavailable for ${item.id}: ${error.message}`);
        break;
      }
      for (const raw of data.items) {
        const comment = z.object({ content: z.string(), date: z.string().optional(), submitter: person.nullish() }).parse(raw);
        result.push(`#### Review by ${author(comment.submitter)} (${comment.date ?? ""})\n${comment.content}`);
      }
      if (data.next === null || (data.next === undefined && data.items.length < 100)) break;
      if (page === 10) { warnings.push("Comments capped at 10 pages."); break; }
      if (data.next) url = sameOrigin(data.next, base);
      else {
        const next = new URL(url);
        next.searchParams.set("page", String(page + 1));
        next.searchParams.set("per_page", "100");
        url = next.href;
      }
    }
    return result.join("\n\n") || "No review comments retrieved.";
  }
  async function format(item: Patch, heading: string) {
    return `## ${heading}: ${item.name}\nID: ${item.id}\nAuthor: ${author(item.submitter)}\n` +
      `Date: ${item.date ?? ""}\nState: ${item.state ?? ""}\nMessage-ID: ${item.msgid ?? ""}\n` +
      `URL: ${item.web_url ?? ""}\n\n### Description\n${item.content ?? "(No description)"}\n` +
      (item.diff ? `\n### Diff\n\`\`\`diff\n${diffText(item.diff)}\n\`\`\`\n` : "") +
      `\n### Review comments\n${await comments(item)}`;
  }
  const result = [`# Patchwork: ${series?.name ?? patch!.name}`, `Source: ${base}`];
  if (series) {
    result.push(`Series ID: ${series.id}; version: ${series.version ?? 1}; patches: ${series.patches.length}`);
    if (series.total && series.total !== series.patches.length) warnings.push("Patchwork reports an incomplete series.");
    if (series.cover_letter) {
      const ref = series.cover_letter;
      const cover = patchSchema.parse(await json(ref.url ? sameOrigin(ref.url, base) : api(base, "covers", ref.id), io));
      result.push(await format(cover, "Cover letter"));
    }
    for (const [i, ref] of series.patches.entries()) {
      const item = patchSchema.parse(await json(ref.url ? sameOrigin(ref.url, base) : api(base, "patches", ref.id), io));
      result.push(await format(item, `Patch ${i + 1}/${series.patches.length}`));
    }
  } else result.push(await format(patch!, standaloneCover ? "Cover letter" : "Patch 1/1"));
  if (warnings.length) result.push("## Retrieval warnings\n" + warnings.join("\n"));
  return result.join("\n\n");
}
