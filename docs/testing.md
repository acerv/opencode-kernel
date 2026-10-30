# Test guide

## Offline suite

```sh
npm ci --ignore-scripts
npm run check
node --check scripts/install.mjs
npm audit
```

The default suite uses saved or synthetic responses. It covers mail
encoding, thread grouping, list filters, pagination, crash parsing,
reproducers, source paths, cancellation, and permission rejection.
Installer tests use temporary directories and injected failures.
They do not change personal OpenCode configuration.

## Native OpenCode smoke test

```sh
npm run build
OPENCODE_SMOKE=1 npm test
```

The smoke test starts a private OpenCode 2.1.2 server on loopback.
It uses a temporary home, isolated configuration, and a test-only password.
It stops that server and removes its temporary files after the test.

The test makes sure that:

- The production installer creates a discoverable plugin link
- OpenCode reports the plugin as active
- All seven tool names and four command names are registered
- A registered report tool reads a local fixture through the native API
- Native web-fetch denial blocks all seven tools before a network request
- A pending read approval does not permit the read
- Rejection ends the pending tool operation

A test-only RPC plugin exposes the registered tool callbacks to the test.
RPC is a request interface between the test and the private server.
The production plugin does not expose this test interface.
No model request, real credential, or terminal interaction is needed.
The smoke test does not test interactive terminal rendering.

## Optional live tests

```sh
OPENCODE_LIVE=1 npm test
```

These tests query Lore, Patchwork, and syzbot. Each test lists one item
and reads its thread, series, or report. They do not read local kernel
source or run a reproducer. The tests need network access and can fail
when an upstream service is unavailable or changes its response format.

The live tests and native smoke test are opt-in. They remain separate
from the default offline suite.
