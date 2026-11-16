# Public DERP PoC implementation checkpoint

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

Never record descriptors, PSKs, private-key JSON, capability URLs or browser
payloads in this file or exported diagnostics. Record pass/fail/unrun separately
from source observations. Keep each issue open until its acceptance is proven.
