# opencode-kernel

Kernel development tools for OpenCode 2.1.2.

This package ports the Lore, Patchwork, and Syzkaller integrations from
[pi-smarter](https://github.com/cervesato/pi-smarter), revision
`8ce17a69d113d2e2e3b2c487d1f9d9da88df7490`.
The original MIT license and copyright apply.

The package excludes Pi themes, workflow rules, status displays, and
companion packages. It does not migrate credentials.

## Install globally

Use Linux, Node.js 22 or later, npm, and OpenCode 2.1.2.

```sh
cd ~/Projects/opencode-kernel
npm ci --ignore-scripts
npm run check
npm run setup
npm run setup -- --apply
```

The first setup command is a dry run. Installation creates a managed
symlink at `~/.config/opencode/plugins/opencode-kernel`.
The link points to this checkout, so keep the checkout in place.
The installer never edits your JSON/JSONC configuration or credentials.
Restart OpenCode after installation.

If setup reports conflicting plugin or command files, inspect them first.
Then approve backup and replacement explicitly:

```sh
npm run setup -- --replace-conflicts
npm run setup -- --replace-conflicts --apply
```

Conflicts in explicit JSON/JSONC plugin or command entries require manual
resolution. The installer reports these entries and stops without edits.
It does not inspect arbitrary plugin dependency graphs for hidden conflicts.

The directory defaults to `OPENCODE_CONFIG_DIR`, if set. Otherwise it uses
`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`.
Use `--config-dir PATH` to select another directory.

After source changes, rebuild with `npm run check` and restart OpenCode.
Repeating installation does not replace an existing managed link.

## Remove or recover

```sh
npm run uninstall
npm run uninstall -- --apply
```

Removal deletes only the owned link and restores displaced files.
It refuses changed links or occupied restore paths. Your unrelated
configuration remains untouched, including changes made after installation.

The installer stores its journal in `.opencode-kernel-install.json` inside
the configuration directory. Displaced files stay in a private directory
named `.opencode-kernel-backup-*`. Empty backup directories remain after
removal or rollback.

Caught installation failures restore displaced files. A process crash can
leave an incomplete journal or lock file. Preserve the journal and backups
for manual recovery. Do not rerun installation over an incomplete state.

## Development

Use Node.js 22 or later and npm.

```sh
npm ci --ignore-scripts
npm run check
OPENCODE_SMOKE=1 npm test
```

The smoke test needs OpenCode 2.1.2 on `PATH`. It uses a temporary home
and configuration directory. It does not call a model or load your
personal configuration.

## Lore

The tools `lore_list_patches` and `lore_read_patch` fetch submissions and
threads. Results include cover letters, diffs, and review comments.

```text
/lore list netdev
/lore list bpf 20 tcp
/lore list mm all
/lore read <message-id-or-url>
```

The default date range is today and yesterday in UTC. An explicit count
or `all` removes that date filter. Lists stop at 1000 items.
Empty recent lists fall back to up to 20 recent submissions.

## Patchwork

The tools `patchwork_list_patches`, `patchwork_read_patch`, and
`patchwork_fetch_series` use the Patchwork 1.3 API.
The two read tools have the same behavior. Both accept `target` or `url`.

```text
/patchwork list ltp
/patchwork list netdev 30 tcp
/patchwork read <patch-id-or-url>
/patchwork read <message-id>
```

Lists use patchwork.kernel.org and the same date defaults as Lore.
Read URLs can select another HTTPS Patchwork instance.
A patch resolves to its full series, including the cover and reviews.
Series over 100 patches fail explicitly. Comment retrieval stops after
10 pages and reports omissions. Each diff includes up to 150 lines.
HTTP failures for comments appear as retrieval warnings.
Permission rejections and cancellation always stop the operation.

## Syzkaller

The tools `syzkaller_list_bugs` and `syzkaller_read_report` retrieve bugs,
crash reports, and reproducers. `/syz` and `/syzkaller` share one parser.

```text
/syz
/syz usb all
/syz usb 20
/syz 8420e667af06b1709c00
/syz read ./crashes/sample
/syzkaller read ./crash.log
```

The default list contains bugs active within 48 hours.
An empty recent list falls back to up to 10 matching open bugs.
A command count selects all dates. A tool call can combine a count with
`timeframe: "recent"`.

Run OpenCode from the kernel checkout for local source correlation.
The report tool reads crash, allocation, and free sites from that working
directory. It reports missing files and Git history without inventing a
match. Source paths from reports cannot escape the checkout.
User-selected external reports require native directory and read approval.

Set `checkLocalSource: false` to disable local source access.
Set `fetchReproducer: false` to skip linked and companion reproducers.
An explicit reproducer target still reads that target.
Reproducers are never executed. Displays stop at 180 lines and mark
omissions. Root-cause analysis and fix suggestions remain model-driven.

## Compatibility

This package uses `@opencode/plugin` 2.1.2 and its Promise API.
OpenCode 1 plugins use a different API and are not supported here.
The package does not upgrade OpenCode.
Configured local plugins must name the package directory, not `server.js`.
OpenCode loads `server.js`, which imports the compiled plugin in `dist/`.

See [compatibility and limits](docs/compatibility.md) for permission
behavior and differences from Pi. See the [test guide](docs/testing.md)
for offline, native-runtime, and optional live tests.
