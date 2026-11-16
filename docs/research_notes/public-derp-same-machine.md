# Same-machine public-DERP route proof and manual Stop validation

Research date: 2026-11-16. Target: [Wayfinder question #8](https://github.com/SapkaLabs/playwriter/issues/8), under [map #7](https://github.com/SapkaLabs/playwriter/issues/7).

**Static conclusion:** a meaningful same-machine proof is possible to design, but it does not exist at these pins. Use separate extension-discovery and CLI-relay ports, an explicitly bound remote session, observations at both plaintext stream boundaries, and a controlled interruption of the actual public DERP data sockets while loopback stays healthy. A successful CLI command, a map fetch, a Tailcat ping, or a “connected” label alone is insufficient.

**Evidence labels:** S = source inspected at the pins below; H = public HTTP document observation; P = proposed implementation/validation, not executed. No packages, builds, browsers, listeners, runtime tests, implementation, local Git changes, PR, or merge were performed. Existing Playwriter and Tailcat checkouts were read only. The only publication is this report on a documentation research branch and its issue-8 comment.

The owner-approved boundaries are same-machine MVP first; VM later when supplied; unpacked extension and a developer bundle; manual reconnect; explicit browser-side Stop even while starting/offline/without CLI. Exact protocol, timing contract and browser coverage remain for owner review. This report does not settle those decisions or lift the implementation hold. [Scope #1](https://github.com/SapkaLabs/playwriter/issues/1), [map #7](https://github.com/SapkaLabs/playwriter/issues/7). The [research archive #2](https://github.com/SapkaLabs/playwriter/issues/2), including its three historical comments, was read; its private-relay, MCP, two-PC and fallback-helper proposals are not current MVP requirements.

## 1. Pins and the important source findings

- Playwriter: `597c0f5bddeb9580a9745787bf4f8636e5e155be`. Existing checkout HEAD matched this commit and status was clean. Read root AGENTS/CONTRIBUTING, README, CLI skill, the referenced plan for context, and session-owned-tabs decision. The unrelated benchmark remains outside scope.
- Tailcat: upstream `e00cdde6ff787f801361ff85ed085775c775d4c5`. Existing checkout HEAD matched this commit and status was clean; upstream origin is tailscale/tailcat. No Tailcat fork was changed or deleted.
- Tailcat pins Go 1.27.2 and tailscale.com `fb79793d99f5ccedabe1ab428f0af852f49d0c62`. Native and WASM artifacts still need to be built, hashed and shown to correspond to the inspected source. [T-mod]
- H: a read-only GET of [the public map](https://tailcat.dev/derpmap.json), around 14:04 UTC on 2026-11-16, returned HTTP 200 and ETag `"6930ba40b549a7f5f3533f105d7022cfc75dd48d98da8f4f818873920724fd9b"`. It listed 301 NYC/tc301a.ipn.dev, 302 SFO/tc302a.ipn.dev, 303 Frankfurt/tc303a.ipn.dev, 304 Tokyo/tc304a.ipn.dev, each with IPv4/IPv6. This is mutable map data, not a successful DERP connection or service-availability test. Re-fetch and record the map, DNS answers and actual selected endpoints during acceptance.

### Connection/configuration seams

| S: location | What the pinned code actually does | P: consequence for this test |
|---|---|---|
| Extension background constants/connect/maintain loop [P-local] [P-maintain] | Hardcodes host 127.0.0.1; port is `Number(process.env.PLAYWRITER_PORT) || 19988`. HEAD-probes that address, then opens `ws://127.0.0.1:port/extension`. The maintain loop still calls ensureConnection while Remote control is active. [P-loop] | Sharing does **not** disable ordinary localhost auto-connect. Use a different compiled extension port from the controller relay. Port 0 is not a disable switch. |
| Extension Vite configuration [P-build] | Replaces PLAYWRITER_PORT at build time; supports PLAYWRITER_EXTENSION_DIST, PLAYWRITER_OPEN_WELCOME_PAGE=0 and TESTING. Non-PRODUCTION builds inject the stable dev extension key. | Changing a shell variable after loading a bundle cannot move its port. Record the actual bundle hash/configuration and extension ID. TESTING adds permission/test behavior; it is not a DERP-only flag. |
| CLI relay client and URL parser [P-cliport] [P-host] | CLI PLAYWRITER_PORT is read at Node module initialization; --host / PLAYWRITER_HOST selects the HTTP relay. Full http://host:port is supported. | Explicitly target the owned relay on every CLI invocation. Distinguish the CLI's host from the adapter URL passed to --remote. |
| Remote URL parsing [P-parser] | `ws://127.0.0.1:A/tunnel/id/extension` is preserved. The ID must match lowercase letters/digits/hyphens, length 1–63. Bare IDs resolve to hosted Playwriter; unrecognized paths become /extension. | Generate a lowercase hex/UUID local capability. Never pass a tc address, bare share ID, arbitrary adapter path or viewer URL to --remote. |
| Relay remote dial/session [P-dial] [P-session] | Dials the parsed URL, hashes it into `remote:sha256(wsUrl)`, waits up to 15 s for that entry's socket and targets, and records that stable key in the session. Explicit-key lookup returns null if absent; it does not fall back to a local entry. | Record the returned session ID and exact remote stable-key binding; do not use an unqualified/default session, stale -s value or first browser found. |
| Relay ingress [P-ingress] | Ordinary inbound /extension requires loopback and an allowed chrome-extension Origin. Remote dial is an outbound Node WebSocket using shared message handlers. | Adapter is its own loopback server, not an impersonated extension client. Do not relax origin checks or put the adapter on /extension of the stock relay. |
| Remote background callback [P-start] | Serializes JSON and invokes dispatchRelayMessage with remoteRuntime; sends hello and current targets. Remote guards and ownership depend on that context. | Tailcat must enter this remote path, not the ordinary local sink. Retain current hello/target/guard semantics. |
| Tailcat browser API [T-listen] [T-stream] | Listen requires an explicit map URL; generates ephemeral key/PSK when no privateKey supplied; resolves a listener object with addr/privateKeyJSON/close. Accepts every logical TCP port at this layer. Stream API has read/write/closeWrite/close, no typed current-route/status accessor. | Filter port 1 and one controller in Playwriter. Listener promise resolution is not end-to-end readiness. Track accepted stream, protocol readiness and actual DERP observations separately. |
| Tailcat native CLI [T-cli-flags] [T-cli-pipe] | `--key=new --derpmap-url=... <tc-address> 1` selects fresh client identity, explicit map and logical port; stdin/stdout carry bytes. --verbose logs diagnostics. | Use an owned child with binary pipes, not a shell text pipeline. A fresh key does not mean a fresh map cache. No shipped Playwriter Tailcat connect command or local-auto-connect-off switch was found in these seams. |

**S: browser data plane is DERP-only at the pin.** Tailcat's WASM build omits udptransport/nattraversal, and its JS endpoint does not advertise UDP endpoints. Native builds retain UDP/STUN/direct-path machinery, but the browser cannot form that direct UDP peer path. [T-tags] [T-no-udp] The pinned DERP client selects WebSockets under GOOS=js; it uses the DERP subprotocol and a /derp endpoint. Native Windows uses the TLS DERP client, whose source sets Upgrade: DERP (fast-start can omit the response round-trip). [D-native] Do not require the native side to look like a browser WSS session. [D-client] [D-ws]

**S: map failure is not established-stream failure.** Tailcat has a process-wide memory cache and the native CLI adds a disk cache. A valid map younger than one hour is used without fetching; stale cached data can be returned on HTTP/network/parse failure. The browser runtime receives the resolved region before starting its server. Native maps live under os.UserCacheDir()/tailcat, not the key directory. [T-cache] [T-cli-cache] Existing DERP connections can remain usable without another map fetch, and the DERP client can reconnect on subsequent IO. [D-reconnect] Therefore blocking tailcat.dev, changing DNS alone, or observing an HTTP map error is not a valid negative control.

## 2. Exact proposed same-machine arrangement

All steps below are P, for later authorized implementation/tests.

### Roles, ports and ownership

Use one disposable browser profile and one controller chain on the same Windows machine. Run one scenario at a time. Keep normal user browser/relay processes untouched.

| Symbol | Concrete arrangement |
|---|---|
| B, extension discovery | Example 19987, compiled into this extension only. Reserve it with an owned test sentinel: answer HEAD/health but reject every /extension WebSocket upgrade and expose no browser command route. Count all attempts and require zero successful upgrades. This is new test infrastructure, not a Tailcat service. |
| R, CLI relay | Example 19989, distinct from B and default 19988. Owned Playwriter relay bound to 127.0.0.1. No ordinary local extension may register here; assert this throughout. |
| A, adapter | Separate OS-selected loopback port, returned after bind. Serves only `/tunnel/<random-local-id>/extension`. Expected Host/path, no browser Origin, one controller, bounded framing. A must differ from B/R/F. |
| F, harmless fixture | Separate loopback HTTP port; unique per-run URL, counter/button/input/scroll/navigation/console/JSON fixtures. Local fixture HTTP is allowed and must stay available during DERP cuts. |
| Browser role | Unpacked packaged extension, offscreen document plus dedicated Go/WASM worker; no browser-side native helper and no TCP debugging listener. |
| Controller role | CLI → owned relay R → adapter A → native Tailcat child → public DERP → extension worker. Native child may have UDP discovery sockets; classify them by owner. |
| Harness | Owns only its profile, port reservations, processes, logs and fault controls. Browser UI automation, if used for setup/Stop, is a separate control channel and must not execute the measured Playwriter operations. Prefer a pipe rather than a browser TCP debug port for an automated harness. |

**Bootstrap gap exposed by this isolation:** before remoteTunnel exists, connectTab awaits the ordinary local relay, while toolbar Start messages require a connected tab. The existing hosted test first toggles tabs onto its local relay and then starts sharing through a service-worker helper. Thus it does not prove the required manual Start flow works with B rejecting every upgrade. The new Tailcat UI must start/attach the chosen fixture tab through a consented extension-owned path without a successful local relay connection; do not temporarily enable localhost control to bootstrap the acceptance run. This is a concrete addition to #3/#5, not proof the upstream UI already supports it. [P-connect-tab] [P-toolbar-message] [P-existing-tests]

The sentinel makes local networking observably alive without providing an alternative browser-control path. Rejecting an ordinary /extension upgrade here does not weaken the real relay's checks. A simpler run can leave B unused and assert no listener, but the sentinel gives stronger evidence and avoids accidental port reuse. The controller listeners on this shared host are expected; “no browser-side listener/helper” means no such component in the browser role, not zero listening sockets on the entire machine.

Build-time settings for the future extension: PLAYWRITER_PORT=B; PLAYWRITER_EXTENSION_DIST=unique per run/build; optionally PLAYWRITER_OPEN_WELCOME_PAGE=0. Preserve a stable dev ID for fixture harness use or record the unpacked path-derived ID. Do not assume the production Store ID applies. [P-build] [P-host]

For the relay, prefer a dedicated harness host of existing `startPlayWriterCDPRelayServer({host:'127.0.0.1', port:R, sessionCounterFile:<run path>, logger, cdpLogger})`, so the counter and logs are isolated without changing HOME. Existing `playwriter serve --host 127.0.0.1` with child-process PLAYWRITER_PORT=R also works as a starting seam, but defaults its counter into the user's .playwriter directory; its --host default is 0.0.0.0, so never omit the explicit loopback bind. Never use --replace or kill an unknown port owner. [P-serve] [P-counter] The future harness should allocate/retry ports, not inherit setupTestContext's unconditional killPortProcess. [P-tests]

Set PLAYWRITER_TELEMETRY=0 **before starting the owned relay**, and assign PLAYWRITER_LOG_FILE_PATH / PLAYWRITER_CDP_LOG_FILE_PATH to the run directory. Export only sanitized logs. [P-logs] [P-telemetry] Clean the child environments of inherited session/direct/cloud/host/token settings that could select a different path; use explicit -s and host. Keep a fresh native map-cache namespace by child-only OS cache configuration or a disposable test account; record the resolved os.UserCacheDir path and cache state. Do not delete the user's Tailcat caches or saved keys.

The proposed adapter first completes native stream and protocol startup, then exposes/accepts its application session. This avoids spending the relay's 15-second hello/targets wait on WASM initialization or native discovery. Native CLI clientMode performs a Ping then a 10-second TCP dial; the browser API's 60-second dial loop is a different code path. Supervise the native process with a whole-operation deadline rather than assuming those paths share a timeout. [T-cli-pipe] [T-ping] [P-dial]

Illustrative **future** commands, using provisioned bundles (not executed; adapter command is proposed):
```text
playwriter-tailcat connect --descriptor <private-file> --listen 127.0.0.1:0
playwriter session new --host http://127.0.0.1:R --remote ws://127.0.0.1:A/tunnel/<local-id>/extension --tab-group derp
playwriter --host http://127.0.0.1:R -s <returned-session-id> -e <one-bounded-fixture-operation>
```
Use the exact returned ID on every operation. Capture R /version (pid, instanceId), /extensions/status, and /cli/session/<id>. Assert the session response's extensionId is the expected remote stable key, exactly one intended remote entry is present, and there are zero local extension entries. /extension/status is a **local-only** summary, so false there is expected; it is not evidence that the remote session is disconnected. [P-status] [P-session-read] [P-select] Recheck identity after daemon restart; the old session must not silently bind to a new session or local profile.

## 3. Evidence that binds an operation to public DERP

Require all four layers; none substitutes for the others.

1. **Configuration and identity.** Record source/artifact hashes, browser/OS versions, profile and extension ID, R PID/instanceId, adapter PID, child PID/binary hash, B/R/A/F ownership, remote stable key and session ID. Keep descriptors, PSKs, privateKeyJSON and local capability URL secret. Use a separate nonsecret run/share/connection label in exported evidence.
2. **Application route trace.** Add bounded Playwriter instrumentation at adapter WS ingress → native-pipe frame write → browser worker frame read → offscreen/background receive → remote dispatch, and the reverse for responses. Record share epoch, connection generation, direction, existing request/response ID, method, byte length and timestamp; use a hash only for known harmless fixture frames when correlation needs it. IDs alone are not globally unique. Include stale-frame rejection and dispatch-admission events. Do not log arbitrary payloads, full addresses, cookies or screenshot contents.
3. **Transport observations.** Capture browser-worker DERP WebSocket URL/subprotocol/open/close and socket identity; correlate with the selected region and native child's public TLS socket, DNS/proxy evidence and byte movement around a distinctive operation. Browser network IO may belong to its Network Service process, so PID-only “chrome.exe traffic” is insufficient: bind it to the isolated profile and initiating worker. Record actual IPv4/IPv6/proxy routes. Native --verbose and browser verbose are supporting diagnostics, not a stable route API; scrub them. Tailcat Ping is the Meow discovery exchange, not proof of authenticated application payload. [T-ping]
4. **Causal interruption and recovery.** Cut the observed DERP data sockets as below, while B/R/A/F remain healthy. The bound command must fail rather than route locally. Restore public reachability and manually reconnect with fresh protocol handlers; fresh observation must succeed, with no replay of the prior operation.

Expected success trace: one nonce-bearing read of the fixture's run marker or one intentional counter action produces a command frame through both Tailcat plaintext boundaries, dispatches under the intended epoch, and returns the matching fixture result. A screenshot or snapshot from some local profile, background public traffic, encrypted-looking packets, or a random public socket does not establish that chain.

Preserve remote guards: e.g. a read-only forbidden profile-wide cookie request must be rejected by the existing guard. The remoteRuntime context and current tab-ownership rules must survive the transport change. Guards are a regression check, not sole route proof. [P-guards] [P-ownership]

### Negative control with loopback preserved

**Deterministic test seam:** before the packaged Go runtime starts, the extension's test worker can install an observation/fault gate around its browser WebSocket construction. It must delegate real sockets normally, track all public DERP sockets, and have a harness-only “cut DERP” operation that (a) closes the **actual currently open DERP WebSockets**, (b) rejects every subsequent public DERP socket construction until released, and (c) leaves the worker, Go runtime, fixture HTTP, map fetch, relay R, adapter A and sentinel B running. This is new Playwriter test instrumentation, not a Tailcat fork, simulated transport, private relay, or whole-worker termination. Verify compatibility of the gate with the pinned coder/websocket runtime during implementation.

Capture closure of every tracked DERP socket and denied retries. Include all selected/map-eligible hosts and any changed endpoint; do not block just one old IP. The client may retry, and the native peer may keep its own DERP socket open, but the browser endpoint must have no surviving/replacement data path. A gate acknowledgement alone is not sufficient: require actual socket-close observations and absence of frame progress.

**Independent OS corroboration:** repeat using an owned-process/endpoint-scoped network fault that drops established flows and denies new non-loopback egress for the dedicated native child or isolated browser network process, including IPv4/IPv6 and any proxy route. Leave loopback and processes alive. Record rule/capture evidence and its removal. A firewall rule that affects only new connects must be combined with verified termination of existing data sockets; if neither is available, mark this corroboration unrun rather than claiming a firewall cut. Do not switch off the whole NIC or kill the adapter as a substitute for this route control.

Recommended test sequence:

| Step | Required observation |
|---|---|
| Healthy baseline | A fresh CLI read succeeds through the complete trace; ordinary extension B upgrades stay rejected; R has only the bound remote entry. |
| Optional map-only contrast | Block only map retrieval after connection; record whether existing commands continue. This tests map independence, never substitutes for the data cut. Warm/stale cache can also let a later start succeed. |
| Data cut after baseline | Close and deny the actual public data sockets; keep loopback health checks successful. Prove B still answers health, R /version returns the same instance, A remains bound with an explicit unavailable state, and F still serves the fixture. |
| Fresh command after verified cut | Issue a new bounded read with a new nonce through the same explicit session. It must not produce a new browser dispatch/result; it must fail or reach the agreed bounded unknown/disconnected outcome. No synthetic adapter hello/targets may make this count as success. |
| Session creation during cut | A fresh remote session cannot reach application-ready/fixture control. Ordinary loopback HTTP can still succeed. Record timeouts without treating a retry as recovery. |
| Recovery | Before lifting the cut, discard/close the failed application connection and its queues. Release the network fault and manually reconnect; enumerate targets, perform a new read. Nothing buffered from the failed generation may execute later. |
| Repeat | Repeat with warm map state and under the owner-selected browser baseline; preserve loopback health throughout. |

Use reads for the pure route-negative command to avoid mistaking late delivery for safe cancellation. Action-interruption testing is separate below. A brief DERP interruption can be masked by the live TCP stream's retransmission; it is not necessarily an application disconnect. Do not restore connectivity with an “unknown” operation still eligible for later execution and then call that no-replay behavior proven.

## 4. Manual Stop, revocation and no-replay validation

**Source facts:** current toolbar Stop routes through a trusted-click handler and runtime message; toolbar sender validation requires a connected tab. [P-toolbar-message] Browser-owned context menus expose playwriter-stop-sharing when remoteTunnel is non-null, but menu updates occur late in startRemoteControl (after awaited attachment), and runMenuAction currently requires tab.id before its switch. [P-menu-action] Current Stop closes hosted transport, clears remote state and detaches remote-owned tabs; it is not a Tailcat key/worker revocation implementation. Service-worker restoration deliberately reuses the hosted tunnel ID. [P-toolbar] [P-menu] [P-start] [P-stop]

**Required design implication:** create the share lifecycle/Stop availability before the first awaited startup phase, keep a browser-owned Stop control reachable even if the fixture toolbar cannot send or no usable page exists, and decouple Stop availability from DERP/CLI/target-connected state. In particular, handle Stop before any tab-dependent menu early return (or supply an equivalent extension-owned control). The in-page toolbar remains useful, but is not enough by itself.

Tailcat Listen exposes no abort handle until its promise resolves. Its close calls Server.Close, which closes the engine/DERP, but closing an accepted TCP connection alone does not revoke the listener capability. Terminating the owned dedicated worker is the bounded way to dispose of a pending WASM startup/runtime without changing Tailcat; late completions still need generation guards at the bridge. [T-listen] [T-close] [T-stream]

### Stop ordering to make observable

P: treat this as an implementation requirement candidate, with exact UI timing/deadlines for owner sign-off:

1. Accept the actual browser UI Stop event locally, mark share stopped/revoked and advance the share epoch **before awaiting anything**. Reject new and queued command admission. Re-check epoch/connection after asynchronous waits and immediately before browser/CDP side effects; a check only at frame ingress is insufficient (current handler can await tab reattachment). [P-guards]
2. Cancel pending startup/reconnect ownership; invalidate old bridge messages and completions. Prevent an earlier asynchronous persistence write from restoring revoked keys/state, and fail closed on restart if a valid current epoch owner cannot be recovered. Close all streams/listener, terminate the owned worker, erase key/descriptor/session restoration state, and clear adapter/extension application queues for that generation. Do not wait for CLI acknowledgement or network success.
3. Detach only the appropriate remote-owned tabs, preserving ordinary behavior outside this run. Report local stopped state; distinguish any cleanup diagnostic from permission to dispatch. A teardown error must not restore authority.
4. A new Share creates fresh key/PSK, descriptor and epoch. A reconnect within a still-active share creates a fresh **connection generation**, preserving share authority only as the reviewed contract allows. Browser restart/reload requires an explicit new Share; do not blindly copy hosted restoration semantics.

Stop cannot undo a browser action already dispatched. Report an unacknowledged action as outcome unknown, not “did not happen” or “rolled back.”

### Exercise the real control in each state

Do not substitute globalThis.stopRemoteControl(), runMenuItemForActiveTab(), a CLI disconnect, session deletion or worker kill for the manual UI acceptance row. Use a real trusted toolbar click where available, and the browser-owned extension control for offline/tab-unavailable cases. Record the visible control/state and Stop time using browser/native UI interaction in the future test; none occurred in this research.

| State | Arrange deterministically | Required result |
|---|---|---|
| Starting, before descriptor exists | Pause startup at worker creation / pending map or Listen using a test barrier; actual Start has already made Stop available. Click Stop, then release the barrier or restore network. | Immediate admission revocation, worker disposal, no late ready/share publication, no target dispatch, no stored key. There is no externally issued old descriptor in this subcase; report that honestly. |
| Starting with a generated descriptor / pending first connection | Hold after key/listener creation or before first hello/preface completion. Keep the old descriptor privately in the harness; click Stop, then allow the old completion to arrive. | Old epoch completion is ignored/closed, no share resurrection; old descriptor cannot authenticate/control after reachability is restored. |
| Connected | Complete a bounded operation first. Click toolbar Stop once; repeat separately through browser-owned control. Race another queued harmless action and response delivery against Stop. | Admission closes locally; at most the already-dispatched effect can occur. Channels/worker/key state disposed; queued/stale work does not run. |
| Offline/disconnected | Perform the verified DERP data cut while B/R/A/F are alive. Keep it cut while clicking browser-owned Stop, including with unusable/missing fixture toolbar. | Stop completes locally without network/CLI reply. After restoring public routing, old descriptor still fails; no background reconnect revives it. |
| CLI command process exited | Let a normal short-lived CLI invocation exit while relay/adapter/child still run; click Stop. | Browser access is revoked despite the still-live transport. CLI process exit alone was not a disconnect. |
| Adapter/native child/relay loss | Terminate each **owned** controller component separately; keep the extension and its actual Stop control. Also test an unresponsive peer. Click Stop before restarting the controller. | No dependency on cooperative cleanup; a restarted controller cannot use the old descriptor. |
| Browser restart / worker failures | Restart the disposable browser, reload extension, and test transport-worker destruction and background restart separately. | Browser restart/reload requires new Share and invalidates old descriptor. Background-only recovery must not reuse a stale dispatch generation; exact safe recovery behavior remains a reviewed implementation contract. |

For every issued descriptor D0: attempt it after Stop **with the public route restored**, both before a new Share and after new D1 is live. Use a fresh adapter/native child/CLI session for each attempt, with valid framing/port and old PSK-bearing descriptor intact. Require no successful application handshake, target access or fixture command via D0, and no dispatch recorded under its old epoch. A failure while the network is blocked proves nothing about revocation. A failed reconnect caused only by an old occupied adapter port/session is also insufficient.

After starting D1, verify D1 succeeds as a positive control. Release its controller before retrying D0 so the one-controller rejection cannot mask old-descriptor validity; then prove D1 still works. Do the same after browser restart. Store only hashes/nonsecret labels in evidence; never post D0/D1/private keys.

### No application replay: deterministic action cases

Use a fixture with a monotonically increasing click counter and append-only input-event/click log, per-run nonce and separately observable state. A final input value alone can hide repeated fill actions. Observe fixture state through a read-only harness path after faults; that path must not perform the measured action.

- **Before send:** hold one action in the new adapter's pre-write queue, fail that connection or click Stop, release the barrier. Expected zero dispatch and zero effect.
- **After effect, before reply:** let exactly one click increment the counter, then hold/drop its matching response at the extension bridge/adapter frame boundary and cut the stream. Expect the original command to fail as unknown, counter delta exactly one, and no second effect after manual reconnect.
- **During screenshot/body transfer:** cut after a known frame/chunk boundary; require an explicit truncated/unknown result, bounded queues, and no automatic replacement screenshot/request. Then manually request a new result with a new ID.
- **Await race:** hold a handler at an asynchronous reattachment/startup boundary, Stop and advance epoch, then resume. Expect no new CDP side effect from the stale continuation.
- **Restore and reconnect:** close the failed generation on both ends, clear queued records, use fresh handlers and target enumeration. Run only a new read to inspect previous effects; do not replay the original script as a recovery shortcut.

The stock remote relay schedules WebSocket redials and wakes them when a session is used; the executor also waits for remote reconnect. [P-dial] [P-wait] Preserve hosted behavior, but make a failed Tailcat adapter generation inert until explicit reconnect. A new adapter URL/session per reconnect is the simplest isolation choice: stale relay redials cannot attach to it. A status/health listener may remain, but must not reopen the revoked application capability. Close/delete the owned old CLI session in controller cleanup; browser Stop must work even if this cleanup never runs.

TCP retransmission within the same surviving stream is not application replay. Conversely a timeout does not recall bytes already sent: an action can occur late and must remain unknown until observed. If the specification requires “nothing queued executes after the operation is declared failed,” the adapter and browser need a coordinated connection-generation discard/dispatch gate; this is not supplied by merely closing the CLI WebSocket. Final deadlines and cancellation guarantees belong in owner review.

## 5. Existing tests: useful parts and missing evidence

S: setupTestContext already creates disposable profiles, per-port bundles, a relay, per-profile session counter and CDP log; it accepts executablePath/PLAYWRITER_TEST_BROWSER and HEADFUL. However it builds the extension and relay with the **same port**, starts a normal local relay, kills the port owner, and can toggle the extension locally. Its build command uses POSIX-style environment assignment, so Windows shell compatibility needs verification/adaptation. Do not run it unchanged and call the result same-machine DERP proof. [P-tests]

S: extension-connection.test.ts has useful remote-session, target enumeration, ownership and guard assertions. Its hosted flow uses playwriter.dev. The “icon menu Stop” test calls runMenuItemForActiveTab via serviceWorker.evaluate; other Stop checks invoke the global function. They exercise handlers, not the actual browser menu or offline/startup visibility. [P-existing-tests]

S: Tailcat web/wasm_test.go uses a locally created DERP/STUN server and headless Chrome, including ignore-certificate-errors. It covers browser/native stream transfer, not public DERP, MV3 offscreen lifecycle, Edge policy, actual extension Stop, or normal certificate validation. It is test design material, not acceptance evidence. [T-tests]

P: narrowly scoped additions for the existing backlog (no issues edited here):

| Existing work issue | Needed addition |
|---|---|
| [#3 extension](https://github.com/SapkaLabs/playwriter/issues/3) | Manual Start without localhost bootstrap; share epoch + connection generation, admission checks across awaits; early/browser-owned Stop in every state; cancellation/worker disposal; Tailcat remoteRuntime wiring; redacted stage events and test-only startup/dispatch/response barriers. |
| [#4 adapter](https://github.com/SapkaLabs/playwriter/issues/4) | Explicit session binding and owned process inventory; pre-write/response barriers; bounded frame trace; terminal failed-generation state despite stock relay redial; explicit reconnect and cleanup. |
| [#5 validation](https://github.com/SapkaLabs/playwriter/issues/5) | Split B/R/A/F harness, rejecting discovery sentinel, local-upgrade assertions, actual DERP-socket fault gate, endpoint/OS observations, trusted/manual UI Stop matrix and old/new descriptor positive controls. Preserve ordinary local/hosted regressions as separate runs. |
| [#6 assets](https://github.com/SapkaLabs/playwriter/issues/6) | Source/binary/runtime/tag manifest, isolated cache inventory, WASM gate compatibility, key/PSK and close semantics, packaged code only. No Tailcat fork or upstream patch. |

Minimal diagnostic additions should live in Playwriter's wrappers/harness. Tailcat's JS interface does not expose its underlying DERP client; if console/native logs plus the worker WebSocket observer cannot provide route evidence, record that narrow observability blocker instead of inventing a status field or silently modifying Tailcat.

## 6. Acceptance record and remaining runtime gaps

Carry the already accepted fixture set from [#5](https://github.com/SapkaLabs/playwriter/issues/5): exact tab selection, bounded snapshot (8 KiB), **displayed** viewport screenshot (4 MiB), navigation, click, non-ASCII type, scroll, bounded console (20 entries/4 KiB), and one selected JSON response (8 KiB output/64 KiB fixture body). Subscribe before the exact request and test explicit unavailable/oversized-body errors without reissuing it. Route trace applies to these operations, not just a synthetic byte echo.

For each later run, publish pass/fail/unrun, versions and hashes, map/DNS/selected endpoint observation time, redacted process/port/session trace, fault timing, actual Stop interaction evidence, bounded fixture result/counter history and cleanup. Route-negative rows must show loopback health and actual data-socket loss. Revocation rows must show restored network and a working new descriptor. No live secrets or raw browser logs should enter issues.

**Not established here:** extension/WASM startup, public stream reachability/performance, artifact reproducibility, worker lifetime, browser/Edge policy compatibility, frame budgets/backpressure, actual guard preservation, cancellation/revocation/no replay, real UI accessibility, or Windows fault-control mechanics. No new browser baseline or final preface/timeout contract is selected. Public relay-side plaintext inspection is unavailable; route evidence does not itself prove encryption. Retain the earlier source-based key/PSK/WireGuard trace and future wrong/missing-PSK/substituted-key negative tests from #2/#5.

The finding for #8 is a concrete source-supported validation design with explicit instrumentation gaps, **not a passing runtime result**. Leave #8 open for parent verification and final decisions in #9. VM validation is a later owner-provided phase, not a prerequisite for this local design.

## Pinned primary-source references

[P-local]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L62-L63
[P-maintain]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L394-L434
[P-build]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/vite.config.mts#L15-L56
[P-cliport]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/relay-client.ts#L20
[P-host]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/utils.ts#L7-L102
[P-parser]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/remote-control.ts#L167-L218
[P-dial]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L2625-L2798
[P-session]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L3243-L3308
[P-select]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L212-L250
[P-ingress]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L1987-L2048
[P-start]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L2480-L2600
[P-stop]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L2602-L2661
[P-toolbar]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/toolbar/toolbar.ts#L1174-L1185
[P-menu]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L2950-L3061
[P-guards]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L1403-L1423
[P-ownership]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/plans/decisions/session-owned-tabs.md
[P-serve]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cli.ts#L1935-L2007
[P-counter]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L46-L49
[P-status]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L1518-L1556
[P-session-read]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/cdp-relay.ts#L3475-L3482
[P-wait]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/executor.ts#L1218-L1235
[P-logs]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/utils.ts#L112-L116
[P-telemetry]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/telemetry.ts#L1-L48
[P-tests]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/test-utils.ts#L17-L138
[P-existing-tests]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/playwriter/src/extension-connection.test.ts#L309-L439
[T-mod]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/go.mod#L1-L27
[T-listen]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/web/main_js.go#L37-L124
[T-stream]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/web/main_js.go#L207-L281
[T-tags]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/internal/buildtags/buildtags.go#L26-L70
[T-no-udp]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L1571-L1585
[T-cache]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L1243-L1339
[T-cli-cache]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/cmd/tailcat/tailcat.go#L820-L843
[T-cli-flags]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/cmd/tailcat/tailcat.go#L83-L107
[T-cli-pipe]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/cmd/tailcat/tailcat.go#L921-L986
[T-ping]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L2190-L2253
[T-close]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L888-L902
[T-tests]: https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/web/wasm_test.go#L145-L281
[D-client]: https://github.com/tailscale/tailscale/blob/fb79793d99f5ccedabe1ab428f0af852f49d0c62/derp/derphttp/derphttp_client.go#L299-L405
[D-ws]: https://github.com/tailscale/tailscale/blob/fb79793d99f5ccedabe1ab428f0af852f49d0c62/derp/derphttp/websocket.go#L16-L32

[P-loop]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L593-L650
[P-toolbar-message]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L3839-L3899
[P-menu-action]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L3640-L3657
[D-native]: https://github.com/tailscale/tailscale/blob/fb79793d99f5ccedabe1ab428f0af852f49d0c62/derp/derphttp/derphttp_client.go#L440-L529
[D-reconnect]: https://github.com/tailscale/tailscale/blob/fb79793d99f5ccedabe1ab428f0af852f49d0c62/derp/derphttp/derphttp_client.go#L48-L54

[P-connect-tab]: https://github.com/SapkaLabs/playwriter/blob/597c0f5bddeb9580a9745787bf4f8636e5e155be/extension/src/background.ts#L2157-L2182

