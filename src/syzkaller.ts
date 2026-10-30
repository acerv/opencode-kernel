/*
 * SPDX-License-Identifier: MIT
 *
 * List syzbot bugs and combine reports, reproducers, and local source evidence.
 * Adapted from pi-smarter/extensions/syzkaller.ts.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { classify, effectiveFrame, parseCrash } from "./crash.js";
import { decodeXml, HttpError, MAX_BYTES, text, type IO } from "./io.js";
import { localPath, readLocal, sourceSnippet } from "./local.js";
import type { CommandRequest } from "./platform.js";

const origin = "https://syzkaller.appspot.com";
export const syzListSchema = z.object({
  subsystem: z
    .string()
    .optional()
    .describe("Subsystem filter: fs, net, usb, bpf, kernel, input, mm, media."),
  timeframe: z
    .enum(["recent", "all"])
    .optional()
    .describe(
      "Default recent: active within 48 hours; all removes the age filter.",
    ),
  limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Maximum bugs; omit or zero for all matching bugs."),
  hasReproOnly: z
    .boolean()
    .optional()
    .describe("Require a C or syz reproducer; default false."),
  query: z.string().optional().describe("Case-insensitive title filter."),
});
export const syzReadSchema = z.object({
  target: z
    .string()
    .min(1)
    .max(MAX_BYTES)
    .describe(
      "Syzbot URL, hex ID, local crash file/directory, reproducer, or raw report.",
    ),
  fetchReproducer: z
    .boolean()
    .optional()
    .describe("Include linked/local companion reproducers; default true."),
  checkLocalSource: z
    .boolean()
    .optional()
    .describe(
      "Correlate crash/allocation/free frames against the working directory; default true.",
    ),
});

const clean = (value: string) =>
  decodeXml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
export interface Bug {
  id: string;
  title: string;
  url: string;
  labels: string[];
  repro: string;
  count: string;
  age: string;
}

export function recentAge(age: string): boolean {
  const parts = [...age.matchAll(/(\d+)([dhms])/g)];
  if (!parts.length || parts.map((m) => m[0]).join("") !== age) return false;
  const seconds: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  return (
    parts.reduce((sum, match) => sum + +match[1] * seconds[match[2]], 0) <
    48 * 3600
  );
}

export function parseBugs(html: string): Bug[] {
  if (!/<table\b/i.test(html))
    throw new Error(
      "Syzbot returned no bug table (possibly an access challenge)",
    );
  const bugs: Bug[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const title = row[1].match(
      /<td\b[^>]*class="title"[^>]*>\s*<a\b[^>]*href="(\/bug\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!title) continue;
    const url = new URL(decodeXml(title[1]), origin);
    const stats = [
      ...row[1].matchAll(
        /<td\b[^>]*class="stat[^\"]*"[^>]*>([\s\S]*?)<\/td>/gi,
      ),
    ].map((m) => clean(m[1]));
    const labels = [
      ...row[1].matchAll(/<span class="bug-label">([\s\S]*?)<\/span>/g),
    ].map((m) => clean(m[1]));
    bugs.push({
      id: url.searchParams.get("extid") ?? url.searchParams.get("id") ?? "",
      title: clean(title[2]),
      url: url.href,
      labels,
      repro: stats[1] || "none",
      count: stats[2] ?? "?",
      age: stats[3] ?? "?",
    });
  }
  return bugs;
}

export async function listSyz(
  input: z.infer<typeof syzListSchema>,
  io: IO = {},
): Promise<string> {
  const subsystem = input.subsystem?.trim().toLowerCase();
  const url =
    subsystem && subsystem !== "all"
      ? `${origin}/upstream/s/${encodeURIComponent(subsystem)}`
      : `${origin}/upstream`;
  let bugs = parseBugs(await text(url, io));
  const total = bugs.length;
  bugs = bugs.filter(
    (bug) =>
      (!input.hasReproOnly || /\bC\b|syz/i.test(bug.repro)) &&
      (!input.query ||
        bug.title.toLowerCase().includes(input.query.toLowerCase())),
  );
  let note = "";
  if (input.timeframe !== "all") {
    const recent = bugs.filter((bug) => recentAge(bug.age));
    if (!recent.length && bugs.length) {
      bugs = bugs.slice(0, input.limit || 10);
      note =
        "No matching bugs active within 48 hours. Showing recent open bugs instead.";
    } else bugs = recent;
  }
  if (input.limit) bugs = bugs.slice(0, input.limit);
  const cell = (value: string) => value.replaceAll("|", "\\|");
  return [
    `# Syzbot open bugs: ${subsystem || "all"}`,
    `Source: ${url}`,
    `${bugs.length} shown; ${total} open on the dashboard. Timeframe: ${input.timeframe ?? "recent"}.`,
    note,
    "| # | Title | Labels | Repro | Crashes | Last seen | ID |",
    "|---|---|---|---|---|---|---|",
    ...bugs.map(
      (bug, i) =>
        `| ${i + 1} | [${cell(bug.title)}](${bug.url}) | ${cell(bug.labels.join(", "))} | ` +
        `${cell(bug.repro)} | ${bug.count} | ${bug.age} | ${bug.id} |`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

interface ReportData {
  title?: string;
  report?: string;
  reproC?: string;
  reproSyz?: string;
  source?: string;
  metadata: string[];
  warnings: string[];
}

async function remoteReport(
  target: string,
  repro: boolean,
  io: IO,
): Promise<ReportData> {
  const url = new URL(target);
  const result: ReportData = { source: url.href, metadata: [], warnings: [] };
  const raw = await text(url.href, io);
  if (
    url.hostname !== "syzkaller.appspot.com" ||
    url.pathname === "/text" ||
    url.pathname.startsWith("/x/")
  ) {
    if (
      url.searchParams.get("tag") === "ReproC" ||
      /repro(?:\d*)\.(c|cprog)/.test(url.pathname)
    )
      result.reproC = raw;
    else if (
      url.searchParams.get("tag") === "ReproSyz" ||
      /repro(?:\d*)\.(syz|prog)/.test(url.pathname)
    )
      result.reproSyz = raw;
    else result.report = raw;
    return result;
  }
  if (!/CrashReport|ReproC|ReproSyz|Reported-by:|Status:/i.test(raw))
    throw new Error(
      "Syzbot returned no bug details (possibly an access challenge)",
    );
  result.title = clean(
    raw.match(/<b>([\s\S]*?)<\/b><br\s*\/?><br\s*\/?>/i)?.[1] ??
      raw.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
      "Syzbot Bug",
  );
  const reporter = raw.match(/Reported-by:\s*([^\s<]+)/i)?.[1];
  const status = raw.match(/Status:\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1];
  if (reporter) result.metadata.push(`Reported-by: ${decodeXml(reporter)}`);
  if (status) result.metadata.push(`Status: ${clean(status)}`);
  for (const label of raw.matchAll(
    /<span class="bug-label">([\s\S]*?)<\/span>/g,
  ))
    result.metadata.push(`Subsystem/label: ${clean(label[1])}`);
  for (const discussion of raw.matchAll(
    /<a href="(https:\/\/lore\.kernel\.org\/[^\"]+)">([^<]+)<\/a>/g,
  )) {
    result.metadata.push(
      `Discussion: ${clean(discussion[2])} ${decodeXml(discussion[1])}`,
    );
  }
  for (const [key, pattern] of [
    ["report", /href="([^\"]*(?:tag=CrashReport|report\.txt)[^\"]*)"/i],
    ...(repro
      ? ([
          ["reproC", /href="([^\"]*(?:tag=ReproC|repro\.c)[^\"]*)"/i],
          ["reproSyz", /href="([^\"]*(?:tag=ReproSyz|repro\.syz)[^\"]*)"/i],
        ] as const)
      : []),
  ] as const) {
    const link = raw.match(pattern)?.[1];
    if (!link) continue;
    const resource = new URL(decodeXml(link), url);
    try {
      result[key] = await text(resource.href, io);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      result.warnings.push(`${key} unavailable: ${error.message}`);
    }
  }
  if (!result.report)
    result.warnings.push(
      "No crash report retrieved; source correlation is unavailable.",
    );
  return result;
}

async function localReport(
  target: string,
  cwd: string,
  repro: boolean,
  io: IO,
): Promise<ReportData> {
  const resolved = await localPath(target, cwd, io);
  const result: ReportData = { source: resolved, metadata: [], warnings: [] };
  if ((await stat(resolved)).isDirectory()) {
    const entries = (await readdir(resolved)).sort();
    const patterns: ["title" | "report" | "reproC" | "reproSyz", RegExp][] = [
      ["title", /^description$/],
      ["report", /^(?:repro\.report|report\d*|report\.txt|crash\.log)$/i],
      ...(repro
        ? ([
            ["reproC", /^repro\d*\.(?:c|cprog)$/i],
            ["reproSyz", /^repro\d*\.(?:syz|prog)$/i],
          ] as typeof patterns)
        : []),
    ];
    for (const [key, pattern] of patterns) {
      const name = entries.find((entry) => pattern.test(entry));
      if (!name) continue;
      const file = await localPath(path.join(resolved, name), cwd, io);
      result[key] = await readLocal(file, io);
    }
    if (!result.report && !result.reproC && !result.reproSyz)
      throw new Error(
        "Directory contains no supported crash report or reproducer",
      );
  } else {
    const raw = await readLocal(resolved, io);
    if (/\.(c|cprog)$/i.test(resolved)) result.reproC = raw;
    else if (/\.(syz|prog)$/i.test(resolved)) result.reproSyz = raw;
    else result.report = raw;
  }
  return result;
}

function reproText(raw: string, language: string): string {
  const lines = raw.trim().split("\n");
  const body =
    lines.length <= 180
      ? raw.trim()
      : [
          ...lines.slice(0, 30),
          `/* ${lines.length - 180} middle lines omitted; not a complete reproducer */`,
          ...lines.slice(-150),
        ].join("\n");
  return `### ${language} reproducer (not executed)\n\n\`\`\`${language}\n${body}\n\`\`\``;
}

export async function readSyz(
  input: z.infer<typeof syzReadSchema>,
  cwd: string,
  io: IO = {},
): Promise<string> {
  let target = input.target.trim();
  if (/^[\da-f]{16,40}$/i.test(target))
    target = `${origin}/bug?${target.length === 40 ? "id" : "extid"}=${target}`;
  const repro = input.fetchReproducer !== false;
  let data: ReportData;
  if (/^https?:\/\//i.test(target))
    data = await remoteReport(target, repro, io);
  else if (
    target.includes("\n") ||
    /Call Trace:|KASAN:|BUG:|WARNING:/.test(target)
  ) {
    data = { report: target, metadata: [], warnings: [] };
  } else data = await localReport(target, cwd, repro, io);
  const report = data.report ? parseCrash(data.report) : undefined;
  const output = [
    `# ${report?.title ?? data.title ?? "Syzkaller reproducer"}`,
    `Category: ${report?.category ?? classify(data.title ?? "")}`,
    data.source && `Source: ${data.source}`,
    ...data.metadata,
    ...(report?.metadata ?? []),
  ].filter(Boolean) as string[];
  if (report) {
    if (report.fault) output.push(`Fault: ${report.fault.raw}`);
    if (input.checkLocalSource !== false) {
      for (const [role, frame] of [
        ["Crash", report.fault],
        ["Allocation", effectiveFrame(report.alloc)],
        ["Free", effectiveFrame(report.free)],
      ] as const) {
        if (frame?.file && frame.line)
          output.push(
            `## ${role} source\n${await sourceSnippet(frame, cwd, io)}`,
          );
      }
    }
    for (const [name, trace, count] of [
      ["Crash", report.crash, 25],
      [`Allocation (task ${report.allocTask ?? "unknown"})`, report.alloc, 18],
      [`Free (task ${report.freeTask ?? "unknown"})`, report.free, 18],
    ] as const) {
      if (trace.length)
        output.push(
          `## ${name} trace\n` +
            trace
              .slice(0, count)
              .map((frame) => frame.raw)
              .join("\n") +
            (trace.length > count
              ? `\n[${trace.length - count} deeper frames omitted]`
              : ""),
        );
    }
    output.push(
      "## Raw report excerpt\n```text\n" +
        report.raw.slice(0, 16000) +
        (report.raw.length > 16000 ? "\n[Raw report truncated]" : "") +
        "\n```",
    );
  }
  if (data.reproSyz) output.push(reproText(data.reproSyz, "syz"));
  if (data.reproC) output.push(reproText(data.reproC, "c"));
  if (data.warnings.length)
    output.push("## Retrieval warnings\n" + data.warnings.join("\n"));
  output.push(
    "Local snippets describe the current working tree, not necessarily the crashing kernel. " +
      "Use the evidence to explain a possible root cause and propose a fix only when supported. " +
      "Do not invent commit IDs, review tags, or sign-offs.",
  );
  return output.join("\n\n");
}

export function syzCommand(raw: string): CommandRequest | undefined {
  const args = raw.trim();
  if (args === "help") return;
  if (args === "read")
    throw new Error("A syzbot URL, ID, file, or directory is required");
  if (/^read\s+/.test(args))
    return {
      tool: "syzkaller_read_report",
      input: { target: args.replace(/^read\s+/, "") },
    };
  if (
    /^https?:\/\//i.test(args) ||
    /^[\da-f]{16,40}$/i.test(args) ||
    /[/.\\]|\n|KASAN:|BUG:/.test(args)
  ) {
    return { tool: "syzkaller_read_report", input: { target: args } };
  }
  const input: Record<string, unknown> = { timeframe: "recent" };
  for (const token of args.split(/\s+/).filter(Boolean)) {
    if (token.toLowerCase() === "all") input.timeframe = "all";
    else if (/^\d+$/.test(token)) {
      input.limit = Number(token);
      input.timeframe = "all";
    } else if (/^[\w-]+$/.test(token)) input.subsystem = token.toLowerCase();
    else throw new Error("Use a subsystem, count, all, or 'read <target>'");
  }
  return { tool: "syzkaller_list_bugs", input };
}
