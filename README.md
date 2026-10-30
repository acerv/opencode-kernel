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

## Compatibility

This package uses `@opencode/plugin` 2.1.2 and its Promise API.
OpenCode 1 plugins use a different API and are not supported here.
The package does not upgrade OpenCode.
