# Public DERP PoC implementation checkpoint

Current handoff: [final same-machine acceptance](public-derp-acceptance.md).
The chronological checkpoints below retain earlier failures and pending states;
the final handoff supersedes their current-status conclusions.

Contract: [SapkaLabs/playwriter#1](https://github.com/SapkaLabs/playwriter/issues/1).
Implementation branch: `feat/public-derp-poc`.
Fixed review baseline: `597c0f5bddeb9580a9745787bf4f8636e5e155be`.
Tailcat source pin: `e00cdde6ff787f801361ff85ed085775c775d4c5` (unchanged upstream).

The owner authorized implementation on 2026-11-16. Historical planning-only
banners do not constrain this implementation. The unrelated stealth benchmark
and research-only branch remain outside this work.

## Approved test seams

Recorded before writing tests; the owner preapproved all six:

1. Actual extension Start/Copy/Stop controls and observable sharing state:
   proves UI accessibility/lifecycle; helper calls alone cannot prove UI operation.
2. Public framed byte stream: proves framing/validation/limits/backpressure;
   isolated vectors cannot prove real DERP routing.
3. Local connect/disconnect and existing CLI bound to an explicit remote session:
   proves ownership/readiness/binding/cleanup; mock peers cannot prove browser compatibility.
4. Harmless fixtures over the complete real transport: proves bounded browser
   actions/revocation/no replay; command success alone cannot exclude local fallback.
5. Real DERP data sockets with test-only faults and healthy loopback:
   proves route dependency/recovery; map-fetch failure is insufficient.
6. Reproducible build/bundle entry points: proves packaging/provisioning;
   compilation alone cannot prove MV3 viability.

## Checkpoint

- Starting working tree clean; no existing unfinished goal.
- Built-in delivery goal created without a token budget.
- Read full approved contract, implementation issues #6/#3/#4/#5 and comments.
- Read repository guidance, source-of-truth MCP skill, active plan and decisions.
- PASS: pinned dependency build/verification entry point, native/WASM/runtime assets and notices.
- PASS: packaged Edge Start/Copy/Stop with ordinary local upgrades rejected;
  real native stream preface, hello/targets and ping/pong.
- PASS: isolated controller creates an explicit remote session; existing CLI reads
  the fixture title through that session (2026-11-16, test duration 14.70 s).
- PASS: portable Playwriter package build and extension TypeScript/Vite build.
- PASS: public foreground connect/disconnect, bounded operation fixtures, selected
  JSON success/oversized/evicted body cases (no request reissue), real DERP socket
  close/denied replacements, healthy loopback, terminal failed generation and
  manual reconnect. Combined integration gate took 119.91 s on 2026-11-16.
- PASS: nine framing checks including malformed data and the inclusive 16 MiB limit.
- PASS: first controller dependency deployment and packaged CLI entry points.
  Stable output cleanup/hash verification still needs final validation.
- Native UI acceptance: **blocked/unrun**. Computer Use ended the initial turn
  because it could not establish the disposable Edge window's URL confidently.
  This is not replaced by helper-only evidence or automated DOM tests.
- Remaining: full Stop/restart/no-replay/authentication matrix, regression checks,
  measurements, final reproducibility/hashes, two-axis review and final delivery.
- Next: source review, lifecycle/race coverage and complete bundle validation;
  retry native UI only through the supported computer tool.

### Lifecycle/review checkpoint, 2026-11-16

- Independent Standards/Spec reviews completed through `6738af1`; findings and
  resolutions are in [the review report](public-derp-reviews.md).
- PASS in real Edge: cancelled anchor startup cannot detach a fresh share;
  stale tab creation and dispatch cannot act after Stop; pre-write click has zero
  effects; held click response reports unknown outcome with exactly one effect;
  partial screenshot and JSON fail without replacement operations; whole-script
  timeout closes its generation; Stop cancels both listener startup barriers.
- PASS in real Edge: transport-worker loss revokes locally; a fresh bound CLI
  read fails; old descriptor fails before and after a working fresh descriptor,
  with its positive-control controller released. Test duration 61.50 s.
- PASS in real Edge: missing/zero PSKs are rejected; wrong PSK and substituted
  server key fail over public DERP; original descriptor positive control works
  afterward (31.00 s).
- PASS: 77 targeted protocol/local-control/relay/CLI checks, pinned-asset hash and
  runtime verification, Playwriter and extension builds.
- FAIL: silent established native preface exceeds 10 s. The smallest proposed
  dependency adjustment awaits the owner; see
  [the reproduction](public-derp-preface-blocker.md).
- Initial complete repository run: 391 passed, five failed, 13 skipped. Four
  failures came from Windows path/screenshot assumptions; affected checks now
  pass. Full rerun: 394 passed, two failed, 13 skipped (55.08 s). Native AV1
  recording on tab close still produces an invalid file in Edge; ordinary capture
  code is unchanged. A separate 100 ms hidden-click test timed out before its
  descriptive reason; hidden/covered error tests now allow 1000 ms.
- UNRUN: native UI matrix, browser/background/extension restart,
  ten-minute idle/memory measurements, final bundle acceptance and
  final re-review. No issue is ready to close.

### Further validation and review fixes

- PASS: actual background worker, extension and browser restart each revokes
  the old descriptor before/after a released fresh positive control (three
  cases, 188.72 s total).
- PASS: ten-minute idle with the sharing page closed, then a fresh CLI read
  (619.51 s test). Edge 157.0.4341.46, Windows 11 Pro 10.0.26300, Node 24.12.0.
  Cold share/connect 4.81 s; warm connect 3.51 s; cold/warm title reads 2.44/2.54 s;
  post-idle read 1.60 s. Browser private memory: 303.91 MiB before sharing,
  394.75 MiB after ten minutes (+90.84 MiB). Native+relay private memory at ten
  minutes: 215.12 MiB; adapter RSS: 111.27 MiB. These are whole-process samples,
  not queue sizes. The idle run used checkpoint runtime `3641b25` / extension
  0.0.177 and must be repeated for final delivery. Its initial reopened-control
  text was sampled before refresh; CLI success and the enabled Stop action,
  rather than that transient text, establish the post-idle behavior.
- PASS: relocatable checkpoint developer ZIP `3641b25`, 14,381 file hashes,
  CLI/native help outside the checkout. Spec re-review then found the standalone
  extension notice omission; 0.0.178 fixes that, so new final hashes are required.
- Re-review: no new hard Standards breach. Spec found schema, private logging
  and standalone notices gaps in addition to the known deadline. Affected red/
  green evidence and resolutions are in [the report](public-derp-reviews.md).
- Native UI retry: state capture worked, but activation and input returned
  `GetCursorPos failed: Access is denied. (0x80070005)` after recovery. Asked the
  owner to make the interactive desktop available. No native UI action passed.
- Pending: exact native deadline decision, native UI matrix, final artifact
  revalidation and required regression success. All implementation issues remain
  open; the built-in goal remains active.
- PASS on the 0.0.178 candidate: complete operations/route gate (75.38 s),
  displayed 195,682-byte viewport screenshot, B/R upgrade probes both 403, R
  inventory contains only the remote identity, four distinct B/R/A/F ports,
  native-process TCP/443 observations and 42 correlated controller/browser command
  frames. Worker socket 1 closed during the cut; all replacements were denied;
  restored-route socket 2 opened only after failed-generation disposal. Detailed
  sanitized metadata is saved in `tmp/evidence/edge-acceptance.json`. Repeat after
  the remaining dependency decision changes the final runtime.
- PASS: production bundle copied outside the checkout; its compiled controller
  and ordinary CLI connect to the packaged extension through DERP, read the
  fixture, click exactly once, disconnect, then Stop through the control page
  (28.84 s). This is DOM interaction; native UI remains unrun.
- PASS: complete ordinary repository run, 410 passed / 20 gated tests skipped
  (60.99 s). The recording fixture now waits for observable MP4 initialization
  and a media fragment before closing, instead of assuming a three-second wait
  delivered data. Existing decode/duration assertions remain. No production
  recording change was retained from the failed fallback-read experiment.
- Checkpoint bundle `c968dd3` / 0.0.178 verifies 14,441 files, including standalone
  notices, relocation and every ZIP file hash. Current hashes and superseding
  source revisions are published in issue #6. Optional removal of legacy build
  experiments was blocked by automatic review; ZIP construction names only the
  four delivery paths, excluding those directories.

### Approved launcher checkpoint

The owner approved the small Playwriter-owned Go launcher described in
[the deadline decision](public-derp-preface-blocker.md). The real silent-peer
regression now passes (15.25 s) with the unchanged 10 s deadline beginning at the
local post-Dial notification. The original CLI, Tailcat library, WASM and wire
protocol remain unchanged. Provisioning and typecheck pass; a fresh independent
Standards/Spec review found no new material code defect.

The most recent ordinary full run before the disposable browser scaling fix
reported 408 passed, three failed, 21 skipped and six errors. Two geometry
assertions now pass with the test browser pinned to device scale 1; the original
assertions remain. The static recording test passes alone (1.07 s). A complete
rerun is required; prior green runs do not supersede this later failed attempt.
The owner also confirmed the interactive desktop is ready for a native UI retry.
All implementation issues stay open pending the refreshed acceptance evidence.

The refreshed ordinary suite passes: **411 passed, 21 gated tests skipped**,
35 files passed and eight skipped (391.28 s serially), with no unhandled errors.
Native Windows Start/Copy/Stop now passes the full startup/connected/offline/
controller-loss/hung-peer/absent-toolbar matrix. Copy exactly matched the private
descriptor; the old descriptor failed before and after a released fresh positive
control. [Sanitized native UI evidence](evidence/public-derp-native-ui.json)
records the actual input method, source, profile identity, asset hashes and real
DERP close/denied-retry observations. No Start/Stop helper was used.

The launcher-bearing operation/route test passes (125.44 s), including distinct
B/R/A/F endpoints, rejected ordinary upgrades, public native sockets, correlated
frames, established-socket cut with healthy loopback and manual recovery without
replay. [Sanitized route evidence](evidence/public-derp-route.json) and the
[188,034-byte displayed fixture screenshot](evidence/public-derp-fixture.png)
are tied to code checkpoint `938e19f` / extension 0.0.179. Final developer bundle
acceptance and refreshed ten-minute measurements remain pending.

Never record descriptors, PSKs, private-key JSON, capability URLs or browser
payloads in this file or exported diagnostics. Record pass/fail/unrun separately
from source observations. Keep each issue open until its acceptance is proven.
