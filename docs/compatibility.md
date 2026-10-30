# Compatibility and limits

## Supported runtime

The package targets OpenCode 2.1.2 on Linux with Node.js 22 or later.
It uses `@opencode/plugin` 2.1.2, not the older `@opencode-ai/plugin` API.
The installer refuses other OpenCode versions on a new installation.

The server plugin registers tools and commands through native transforms.
Each registration has cleanup support. There is no custom terminal UI,
provider, model selection, safety-mode toggle, or session-wide prompt rule.

The installer uses native discovery through a directory symlink in
`plugins/`. A manually configured local plugin must name the repository
directory, not an individual JavaScript file.

## Public tools

The names remain unchanged:

- `lore_list_patches`
- `lore_read_patch`
- `patchwork_list_patches`
- `patchwork_read_patch`
- `patchwork_fetch_series`
- `syzkaller_list_bugs`
- `syzkaller_read_report`

Patchwork's two read names call the same implementation.
Its `url` argument remains an alias for `target`.
The `subsystem` argument takes precedence over `project`.
For Lore and Patchwork, `all: true` takes precedence over a numeric limit.

Commands use OpenCode's current session, agent, and model.
They submit a prompt with the selected tool name and JSON arguments.
Help also uses a model turn, unlike Pi's local usage notification.
There are no Pi-specific tool renderers or footer messages.

`/syz` and `/syzkaller` use identical parsing. Explicit `read <target>`
supports a directory name or file path that could otherwise look like a
subsystem. All four command names are available through native discovery.

## Retrieval limits

Each request uses HTTPS and allows at most five redirects.
Every redirect destination requires native web-fetch authorization.
The request timeout is 20 seconds, including permission wait time.
A pending permission still requires a reply or cancellation. An expired
request cannot start a fetch after approval.

Responses, local files, and decompressed Lore threads stop at 8 MiB.
Tool output stops at 100000 characters and includes a truncation notice.
The tools do not write full-response files to disk.

Lore and Patchwork lists stop at 1000 items. Their default UTC date range
is today and yesterday. Empty recent results fall back to up to 20 items.
Syzkaller uses a rolling 48-hour range and a fallback of up to 10 bugs.

Lore diffs default to 150 lines per patch, configurable from 20 to 1000.
Patchwork diffs stop at 150 lines per patch. Patchwork rejects series with
more than 100 patches and stops comments after 10 pages.
Reproducer displays stop at 180 lines. Every omission is explicit.

HTTP failures are errors, not empty successful lists. Missing Lore thread
endpoints permit fallback to another thread or raw-message endpoint.
An absent Lore list endpoint is treated as an empty list.
Unavailable Patchwork comments and syzbot attachments produce warnings.
Permission rejections and cancellation are never converted to warnings.

## Local source and permissions

The plugin uses native permissions for its internal operations:

- `webfetch` for each HTTP destination
- `read` for local report and source paths
- `external_directory` for user-selected paths outside the checkout
- `shell` for Git history inspection

Source paths from reports must stay inside the current working directory.
Absolute paths, parent traversal, non-source extensions, and escaping
symlinks do not produce source snippets. Explicit local report targets can
be outside that directory after native approval.

Source snippets describe the current checkout. They do not prove that the
checkout matches the crashing kernel. The report includes the recorded
kernel revision when available. Missing files, lines, and Git history are
reported without a fabricated match.

The tools never run reproducers, apply patches, or modify kernel files.
Model-generated analysis remains separate from fetched evidence.
These controls are not an operating-system sandbox and do not replace your
OpenCode permission policy.

## Installer behavior

The installer does not rewrite JSON or JSONC configuration.
Explicit conflicting plugin entries or command definitions require manual
resolution. File-based conflicts can be backed up with explicit approval.
Conflict detection covers known names and tool IDs in direct plugin files,
not arbitrary dependency graphs or project-local configuration.

Installation points to the checkout's build and dependencies. It is not a
self-contained copy. Keep the checkout in place and rebuild after changes.
Uninstall refuses changed managed links and occupied restore paths.
Backups and incomplete journals remain available for manual recovery.
