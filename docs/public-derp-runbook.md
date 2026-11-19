# Windows Edge public DERP developer PoC

For configurable profiles and v2 descriptors, use [the Stage 1 guide](configurable-derp.md).
Build commands below still apply; the historical output directory name remains.

Status: same-machine developer PoC acceptance demonstrated on artifact source
`e8bcc731fc66d102f9e20bab9076fbfe45523f47`, extension 0.0.179. Read
[the final results and retained failure](public-derp-acceptance.md) and
[the approved native launcher decision](public-derp-preface-blocker.md).
This is a developer bundle, not a store or public package release.

## Build

Use this repository on `feat/public-derp-poc`, Node 20 or newer, pnpm, Git for
Windows (including Bash), Bun and Go **1.27.2**. Node 24.12.0 and locally
provisioned Bun 1.3.11 were used here. Builds fetch the unchanged pinned Tailcat
source into an owned cache; users of the resulting bundles need no Tailcat
checkout or executable download.

```powershell
pnpm bootstrap
$env:BUN_EXECUTABLE = 'D:\src\playwriter\tmp\toolchain\node_modules\bun\bin\bun.exe'
pnpm tailcat:build --go D:\src\playwriter\tmp\tailcat-build\go\bin\go.exe
```

Replace the two tool paths with your installed executables. Output:

- `dist/public-derp/extension`: unpacked extension, packaged WASM/runtime/notices.
- `dist/public-derp/controller`: CLI, adapter, dedicated relay, production
  dependencies, matching native Tailcat, notices and Windows command wrappers.
- `dist/public-derp/delivery.json`: SHA-256 file inventory, Node requirement,
  source revision/dirty flag and test-build flag.

Use `--testing` only for fault-validation bundles. Test controls are compiled
out of ordinary developer output. Set `PLAYWRITER_TAILCAT_ASSETS` to an existing
asset directory when building to verify and reuse it. Hash verification of pinned assets:

```powershell
node scripts/build-tailcat.mjs --verify --out dist/tailcat
node --test scripts/tailcat-assets.test.mjs
node scripts/verify-tailcat-bundle.mjs
```

## Share and connect

1. In a disposable Edge profile, enable developer mode at `edge://extensions`
   and load `dist/public-derp/extension` unpacked. Keep personal profiles separate.
2. Open a harmless HTTP fixture. In Playwriter's **Connection** settings, select
   **Tailcat → Public Tailcat**, click **Connect**, and confirm **Share browser**.
   Public Tailcat needs access to its public DERP relay. The developer controller
   provides the CLI relay on the machine that connects to the browser.
3. Click **Copy connection information** and save the JSON to a private file.
   It contains a bearer capability. Share privately; omit it from evidence/logs.
4. Run the foreground controller in one PowerShell window:

```powershell
& .\dist\public-derp\controller\playwriter-tailcat.cmd connect --descriptor C:\private\share.json --listen 127.0.0.1:0
```

5. Use the printed host and session in another window. For example:

```powershell
& .\dist\public-derp\controller\playwriter.cmd --host http://127.0.0.1:<printed-port> -s <printed-session> --timeout 30000 -e 'console.log(await context.pages()[0].title())'
```

Keep both explicit arguments on every operation. The foreground output includes
the local connection ID and owned process IDs. Connected requires a real browser
handshake and target announcement. Startup failure submits no CLI operation.
After an operation failure, the dispatched outcome may be unknown: observe the
fixture through a fresh manual connection before deciding whether to repeat it.

## Stop and cleanup

Click **Disconnect** in Connection settings or **Stop sharing** in the browser menu to revoke
browser authority locally. It remains available when the fixture toolbar or
controller is unavailable. A fresh Start creates a new key/descriptor. Network
recovery never retries browser actions automatically.

Ctrl+C in the controller, or the command below, disposes its owned session and
children; browser sharing remains active until Stop:

```powershell
& .\dist\public-derp\controller\playwriter-tailcat.cmd disconnect --connection <printed-connection-id>
```

Stop sharing, exit the controller and close the disposable Edge profile before
removing its private descriptor/profile. The local control registry defaults to
`%LOCALAPPDATA%\playwriter-tailcat\connections`; per-run state is in the adjacent
`runs` directory. Remove only files belonging to this run after its processes
exit. Avoid global port-kill commands or clearing shared caches.

## Reproduce automated gates

Fault tests use `extension/dist-tailcat`, an extension build with
`PLAYWRITER_TAILCAT_ASSETS`, `PLAYWRITER_PORT=19987`,
`PLAYWRITER_OPEN_WELCOME_PAGE=0`, `PLAYWRITER_EXTENSION_DIST=dist-tailcat` and
`TESTING=1`. Port 19987 must be free; tests reject local extension upgrades there.

```powershell
$env:PLAYWRITER_TAILCAT_TESTS = '1'
pnpm --filter playwriter exec vitest run src/tailcat-tunnel/edge.test.ts
pnpm --filter playwriter exec vitest run src/tailcat-tunnel/lifecycle.test.ts
```

The silent-established-peer case retains the original defect reproduction and
must pass with the owned launcher. Automated DOM clicks are partial evidence: they do
not replace native browser-owned UI Stop acceptance. Tests use owned temporary
profiles and isolated state; disposable diagnostic directories are prefixed
`playwriter-regression-` in the OS temp directory.

After building the ordinary developer bundle, validate its compiled CLI from a
relocated directory against its packaged extension:

```powershell
$env:PLAYWRITER_TAILCAT_TESTS = '1'
$env:PLAYWRITER_TAILCAT_DELIVERY = '1'
pnpm --filter playwriter exec vitest run src/tailcat-tunnel/delivery.test.ts
```

## Transport maintenance

Transport code is grouped in `extension/src/tailcat-tunnel/` and
`playwriter/src/tailcat-tunnel/`, including the shared protocol, CLI subprocesses,
native launcher and transport tests. The extension's `src/tailcat-share.html`
and package `tailcat-bin.js` remain the stable public entrypoints.

The owned `tailcatListen({configuration,onConnection})` bridge consumes frozen,
validated map bytes and returns `addr` and `close()`. Only `addr` crosses the Playwriter worker
boundary. Each accepted connection exposes its logical port, pull-based
`read(): Promise<Uint8Array|null>`, `write(bytes)`, `closeWrite()` and `close()`.
`null` is EOF; reads share an upstream 64 KiB buffer and must be serialized.
The worker serializes writes and rejects other ports or a second controller.
Native pipe writes honor drain callbacks. Framing closes the whole connection;
it does not use upstream's optional half-close, which rejects if unsupported.

Upstream startup promises offer no cancellation signal. Revocation terminates
the dedicated worker, including a pending listener startup and its key material.
The offscreen document itself also serves clipboard/audio functions and stays
separate from that worker's lifetime. Runtime/port loss requires a fresh Start.

The controller packages the unchanged pinned CLI for address parsing and a
Playwriter-owned `tailcat-launcher` built against that same library. The launcher
uses a fresh in-memory node key, the descriptor-bound map, and port 1; it reads no
named keys. Its map cache is a read-only per-connection projection of the validated
region; it cannot refetch, use stale data, or merge a default map.
Only a fixed local stderr notification crosses to the supervisor after TCP Dial;
stdout remains the binary protocol. Startup is bounded to 60 s and the preface
timer begins at that notification with its unchanged 10 s limit. The controller
also isolates Windows `LOCALAPPDATA`/`APPDATA` and XDG directories to the owned
run. Test cleanup removes only that run; personal caches/configuration stay intact.
