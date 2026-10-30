// Adapted from pi-smarter/extensions/syzkaller.ts (MIT).
export interface Frame {
  func: string; file?: string; line?: number; offset?: string; size?: string;
  inline: boolean; raw: string;
}

export function classify(title: string, text = ""): string {
  const value = `${title}\n${text}`.toLowerCase();
  const rules: [RegExp, string][] = [
    [/use-after-free/, "Use-After-Free (UAF)"],
    [/null-ptr-deref|null pointer|dereferencing a null/, "Null Pointer Dereference"],
    [/out-of-bounds/, "Out-Of-Bounds (OOB)"], [/double[- ]free/, "Double Free"],
    [/kmsan|uninit-value|uninitialized memory/, "Uninitialized Memory (KMSAN)"],
    [/circular locking|possible deadlock|lockdep/, "Deadlock / Lockdep"],
    [/kernel bug at|bug_on|warn_on|warning in|warning:/, "Kernel Warning / Assertion"],
    [/general protection fault|non-canonical address/, "General Protection Fault (GPF)"],
    [/page fault/, "Page Fault"], [/memory leak|kmemleak/, "Memory Leak"],
    [/task hung|soft lockup|rcu stalls|blocked for more than/, "Hung Task / Lockup"],
  ];
  return rules.find(([pattern]) => pattern.test(value))?.[1] ?? "Kernel Crash / Bug";
}

export function frames(raw: string): Frame[] {
  const output: Frame[] = [];
  for (const line of raw.split("\n")) {
    const clean = line.replace(/^\s*\[\s*\d+\.\d+\]\s*/, "").trim();
    const match = clean.match(/^(?:\[\s*<[\da-fx]+>\s*\]\s*)?(?:\?\s+)?([\w.]+)(?:\+0x([\da-f]+)\/0x([\da-f]+))?(?:\s+([\w./-]+):(\d+))?(\s+\[inline\])?/i);
    if (match && (match[2] || match[4])) output.push({
      func: match[1], offset: match[2], size: match[3], file: match[4],
      line: match[5] ? +match[5] : undefined, inline: Boolean(match[6]), raw: clean,
    });
  }
  return output;
}

export function effectiveFrame(trace: Frame[]): Frame | undefined {
  const infra = /^(?:__)?(?:dump_stack|kasan|kfence|kmsan|ubsan|print_report|print_address|panic|check_panic_on_warn|warn_slowpath|report_bug|oops_end|die|do_trap)/;
  return trace.find((frame) => !infra.test(frame.func)) ?? trace[0];
}

export function parseCrash(raw: string) {
  const text = raw.replace(/^\s*\[\s*\d+\.\d+\]\s*/gm, "");
  const title = text.match(/(?:BUG:\s*[^\n]+|Oops:\s*[^\n]+|kernel BUG at[^\n]+|WARNING:\s*[^\n]+|general protection fault[^\n]*|INFO:\s*[^\n]+|possible circular locking[^\n]+)/i)?.[0]
    .replace(/^BUG:\s*/, "").trim() ?? "Kernel Crash";
  const section = (start: RegExp) => {
    const match = start.exec(text);
    if (!match) return "";
    const rest = text.slice(match.index + match[0].length);
    return rest.split(/\n\s*(?:Allocated by task|Freed by task|The buggy|Modules linked|---\[ end trace|Memory state around)/i)[0];
  };
  const crash = frames(section(/Call Trace:\s*/i));
  const alloc = frames(section(/Allocated by task \d+:\s*/i));
  const free = frames(section(/Freed by task \d+:\s*/i));
  const rip = text.match(/RIP:\s*(?:[\da-f]+:)?\s*([^\n]+)/i)?.[1];
  const fault = (rip ? frames(rip)[0] : undefined) ?? effectiveFrame(crash);
  const access = text.match(/(Read|Write|Execute) of size (\d+) at addr ([\da-fx]+)(?:\s+by task ([^\n]+))?/i);
  const slab = text.match(/The buggy address belongs to the object at ([\da-fx]+)\s+which belongs to the cache ([\w-]+)(?:\s+of size (\d+))?/i);
  const region = text.match(/The buggy address is located (\d+) bytes inside of\s+(freed|allocated)?\s*(\d+)-byte region \[([\da-fx]+),\s*([\da-fx]+)\)/i);
  const cpu = text.match(/CPU:\s*([^\n]+)/)?.[1];
  const metadata = [
    access && `Memory access: ${access[1]} ${access[2]} bytes at ${access[3]}${access[4] ? ` by ${access[4]}` : ""}`,
    slab && `Slab: ${slab[2]} at ${slab[1]} (${slab[3] ?? "unknown"} bytes)`,
    region && `Region: ${region[2] ?? "unknown"}, ${region[3]} bytes, offset ${region[1]}, [${region[4]}, ${region[5]})`,
    cpu && `CPU: ${cpu}`,
    ...["Hardware name", "Workqueue", "HEAD commit", "git tree", "Code"].map((label) => {
      const value = text.match(new RegExp(`${label}:\\s*([^\\n]+)`, "i"))?.[1];
      return value && `${label}: ${value}`;
    }),
    ...[...text.matchAll(/\b(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|R08|R09|R10|R11|R12|R13|R14|R15|CR2|CR3|CR4):\s*([\da-fx]+)/gi)]
      .map((match) => `${match[1]}: ${match[2]}`),
  ].filter(Boolean) as string[];
  return { title, category: classify(title, text), fault, crash, alloc, free, metadata,
    allocTask: text.match(/Allocated by task (\d+)/)?.[1], freeTask: text.match(/Freed by task (\d+)/)?.[1], raw };
}
