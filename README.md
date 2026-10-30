# opencode-kernel

Kernel development tools for OpenCode 2.1.2.

This package ports the Lore, Patchwork, and Syzkaller integrations from
[pi-smarter](https://github.com/cervesato/pi-smarter), revision
`8ce17a69d113d2e2e3b2c487d1f9d9da88df7490`.
The original MIT license and copyright apply.

The package excludes Pi themes, workflow rules, status displays, and
companion packages. It does not migrate credentials.

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

## Compatibility

This package uses `@opencode/plugin` 2.1.2 and its Promise API.
OpenCode 1 plugins use a different API and are not supported here.
The package does not upgrade OpenCode.
Configured local plugins must name the package directory, not `server.js`.
OpenCode loads `server.js`, which imports the compiled plugin in `dist/`.
