# Native stream-establishment deadline blocker

Status: owner approved the Playwriter-owned launcher on 2026-11-16. The retained
real public-DERP silent-peer test now passes (15.25 s total), with the 10-second
preface timer starting on the launcher's post-Dial notification. No Tailcat
source, cryptography or remote wire protocol has been changed.

## Reproduction and requirement

Contract #1 requires native startup bounded to 60 seconds, followed by a
10-second preface deadline measured from stream establishment. The dedicated
test-build barrier holds the browser's preface after Tailcat has accepted a real
TCP connection. With the public DERP route healthy, the controller remains live
more than 12 seconds after that acceptance instead of failing the preface stage.

From PowerShell, after building `extension/dist-tailcat` with `TESTING=1` and the
pinned assets:

```powershell
$env:PLAYWRITER_TAILCAT_TESTS = '1'
pnpm --filter playwriter exec vitest run src/tailcat-lifecycle.test.ts -t 'silent established'
```

Observed 2026-11-16: FAIL, `expected false to be true`; test duration 17.665 s.
The test aborts and cleans its owned connection after proving the missing deadline.

## Pinned source evidence

At Tailcat `e00cdde6ff787f801361ff85ed085775c775d4c5`,
`cmd/tailcat/tailcat.go` `clientMode` performs Ping, then `DialTCPPort`, then
copies stdin/stdout. It emits no post-Dial control notification. Verbose Ping
output precedes TCP establishment and cannot provide the required timestamp.
Node's pipe write callback confirms buffering, not a read by the native child.
First peer output is not a reliable establishment signal for a silent peer.

Starting the timer at process spawn or Ping would change the approved staging;
waiting for peer output leaves this reproduced hole.

## Smallest proposed adjustment

Add a **Playwriter-owned native launcher**, compiled in this repository against
the unchanged pinned upstream Tailcat Go module. Keep packaging the unchanged
upstream CLI for address parsing and dependency evidence. The launcher replaces
only its transport-copy entry point and adds one local stderr control record:

```text
fresh native client key + pinned public map
  -> Ping / DialTCPPort(1), within the 60 s startup context
  -> stderr: {"stage":"stream-established"}
  -> stdin/stdout: unchanged PWTC1 framed binary stream
```

The Node pipe supervisor validates that fixed control record, suppresses other
native diagnostics, and starts the 10-second timer on that signal. It continues
to own/terminate the native child on IPC loss. Both native assets and WASM use
the same approved Tailcat pin and Go toolchain. No protocol bytes, remote
extension feature, relay destination, key format, PSK or encryption changes.

The owner approved replacing the upstream-CLI-only data invocation with this
local launcher using the same library. The launcher and unchanged CLI are both
packaged; the CLI remains the descriptor parser. Complete acceptance must still
be rerun against the resulting developer bundles.
