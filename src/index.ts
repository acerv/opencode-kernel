import { Plugin } from "@opencode/plugin";
import { listLore, readLore, loreListSchema, loreReadSchema } from "./lore.js";
import { command, patchCommand, tool } from "./platform.js";
import { listPatchwork, readPatchwork, patchworkListSchema, patchworkReadSchema } from "./patchwork.js";
import { listSyz, readSyz, syzCommand, syzListSchema, syzReadSchema } from "./syzkaller.js";

export default Plugin.define({
  id: "opencode-kernel",
  async setup(context) {
    const tools = await context.tool.transform((editor) => {
      editor.add(tool(context, "lore_list_patches",
        "List Lore submissions. Default: today and yesterday; explicit count/all removes the date filter.",
        loreListSchema, listLore));
      editor.add(tool(context, "lore_read_patch",
        "Read a Lore patch or thread with cover letter, diffs, and reviewer comments.",
        loreReadSchema, readLore));
      editor.add(tool(context, "patchwork_list_patches",
        "List Patchwork submissions by project, query, and state. Default: today and yesterday.",
        patchworkListSchema, listPatchwork));
      editor.add(tool(context, "syzkaller_list_bugs",
        "List open syzbot bugs by subsystem, title, reproducer availability, and age. Default: active within 48 hours.",
        syzListSchema, listSyz));
      editor.add(tool(context, "syzkaller_read_report",
        "Read a syzbot report or reproducer and correlate crash, allocation, and free sites with local source. Never executes reproducers.",
        syzReadSchema, (input, io) => readSyz(input, context.location.directory, io)));
      for (const name of ["patchwork_read_patch", "patchwork_fetch_series"]) {
        editor.add(tool(context, name,
          "Resolve a Patchwork patch, cover, series URL, ID, or Message-ID to the full series and reviews.",
          patchworkReadSchema, readPatchwork));
      }
    });
    try {
      const commands = await context.command.transform((editor) => {
        editor.add(command(context, "lore", "Browse Lore patches and review discussions",
          (args) => patchCommand("lore", args),
          "/lore list [list] [count|all] [query]; /lore read <url|msgid>; /lore <url|msgid|list>"));
        editor.add(command(context, "patchwork", "Browse Patchwork patches, series, and reviews",
          (args) => patchCommand("patchwork", args),
          "/patchwork list [project] [count|all] [query]; /patchwork read <url|id|msgid>"));
        for (const name of ["syz", "syzkaller"]) {
          editor.add(command(context, name, "List syzbot bugs or inspect a crash report", syzCommand,
            "/syz [subsystem] [all|count]; /syz read <url|hex-id|file|directory>"));
        }
      });
      return async () => { await commands.dispose(); await tools.dispose(); };
    } catch (error) {
      await tools.dispose();
      throw error;
    }
  },
});
