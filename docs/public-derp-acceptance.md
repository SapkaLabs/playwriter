# Windows Edge developer PoC acceptance

Artifact source: `e8bcc731fc66d102f9e20bab9076fbfe45523f47`.
Branch: `feat/public-derp-poc`; [PR #11](https://github.com/SapkaLabs/playwriter/pull/11).
Review baseline: `597c0f5bddeb9580a9745787bf4f8636e5e155be`.
This handoff changes documentation/evidence only after that artifact build.

**GO for the same-machine developer PoC.** Every required case has a passing
run. This is not a store, npm, GitHub release or production-service rollout.
An earlier production scroll attempt failed; its unknown outcome and unproven
cause remain recorded below. No deadline or operation was weakened to pass.

## Passing evidence

| Requirement | Result |
| --- | --- |
| Reproducible dependency/build/delivery | Unchanged Tailcat `e00cdde6ff787f801361ff85ed085775c775d4c5`, Go 1.27.2, Bun 1.3.11, Node 24.12.0; 14,448 delivered file hashes, notices, relocated entry points and every inventoried ZIP entry verified. `sourceDirty:false`, `testing:false`. |
| Production operations | Fresh relocated compiled CLI and packaged extension pass all 12 scripts in 73.25 s total: exact fixture selection, bounded snapshot, displayed 188,199-byte screenshot, one click, Unicode/history, scroll, bounded console, selected JSON/oversized/unavailable/evicted bodies without reissue, navigation and disconnect. Scripts took 0.23–6.81 s, each retaining its 30 s limit. |
| Native controls | Full instrumented native Windows Start/Copy/Stop matrix passes: before/after descriptor startup, connected/short-lived CLI exit, offline, absent fixture toolbar, owned relay/adapter/native-child failure and hung peer. Exact production bundle also passes native Start, compiled bound read, private clipboard equality, native Stop and rejected revoked-session read. |
| Public route | Source operation/route gate passes in 125.44 s. B/R upgrades both 403; distinct B/R/A/F; two native public TCP/443 socket observations; 39 correlated command frames; actual DERP close/denied retries; healthy loopback; fresh bound read fails during cut; failed generation disposed before manual recovery; no replay. |
| Revocation and no replay | All 12 lifecycle cases pass again, including exact silent-peer preface failure, stale anchor/tab/dispatch continuations, before-write zero effects, held-response one effect/unknown outcome, partial screenshot/body transfer, worker loss and old-descriptor negatives bracketing a released fresh positive control. |
| Actual restarts | Background-worker, extension and browser restarts all revoke old descriptors before/after released fresh positive controls: 66.03/69.91/70.94 s. |
| Authentication/privacy/framing | Real wrong-PSK/substituted-key negatives and original positive control pass (80.93 s); missing/zero PSKs rejected. Privacy regression passes (5.45 s). All 26 framing cases pass in the ordinary suite. A 1 MiB response followed by a 16-byte response passes; the final small response took 0.82 s. |
| Ordinary compatibility/checks | Complete ordinary suite: 411 passed, 21 gated tests skipped; 35 files passed/eight skipped; no unhandled errors (391.28 s serially). Typecheck, pinned provisioning and builds pass. |
| Review/cleanup | Three independent Standards/Spec review rounds; material findings resolved, including the owner-approved native establishment launcher. Actual Windows Ctrl+C event cleans the packaged adapter/native/relay and registry; browser sharing remains active until native Stop, which then revokes locally. Owned UI profiles/controllers are closed; B/UI harness listeners released. Personal profiles and the ordinary 19988 relay were not modified. |

The final serial integration batch reported **19 passed / one failed**. The
failed production-delivery case was then run with bounded timing/stage
diagnostics in a fresh profile and fixture and passed. Do not describe the
earlier combined command as a wholly green run.

For the Ctrl+C check, unified exec could not allocate a PTY (OS access-denied
error 5). A real Windows `CTRL_C_EVENT` was instead delivered to an owned hidden
console after verifying every console member belonged to the disposable test.
The actual packaged supervisor and its children exited and removed the registry;
native browser Stop remained usable afterward. No terminal UI was automated.

## Timing and memory

Edge **157.0.4341.46**, Windows 11 Pro **10.0.26300**, x64.
These measurements use a disposable instrumented profile and include CLI startup.

| Measurement | Observed |
| --- | --- |
| Cold share/connect; warm connect | 5.21 s; 3.89 s |
| Cold/warm title read | 2.43 s; 2.97 s |
| Sharing page closed idle | 603.12 s; live at every sample |
| Read after idle | 1.60 s; status connected |
| Browser private memory before/after idle | 333.55 / 403.07 MiB; increment 69.52 MiB |
| Native + relay private memory after idle | 215.88 MiB |
| Adapter RSS after idle | 113.57 MiB |

Memory values cover whole processes, not application queue sizes. A developer
bundle was rebuilt during the early idle interval; it did not operate the fixture
or share and completed well before the post-idle read. The earlier illustrative
15-second/300-MiB figures were not used as release gates.

## Retained failed attempt and limitation

Artifact `3495f02` failed during a scroll after screenshot capture (118.11 s
total, `fetch failed`). Its dispatched scroll outcome is unknown; no action was
replayed against that fixture. The failed candidate is retained locally as
`dist/public-derp-dev-win32-x64-3495f02.zip` with SHA-256
`f7ae4d2fe246c8fb1a88e1192ae3b13b2c225f9a8da8ef71398a38476483688f`.

The fresh diagnostic candidate keeps identical controller, CLI, native-supervisor
and Playwright runtime bytes; only test diagnostics changed. Its unchanged
operations and deadlines pass. This demonstrates a passing fresh run; it does
**not** establish or fix the earlier cause. Public-route operations can fail;
dispose the generation and manually reconnect/re-observe before deciding whether
to repeat an action. The successful diagnostic run also retains a conservative
disconnect warning for background dispatched commands; completed fixture history
contains exactly one counter click and the expected Unicode input.

## Artifacts and reproduction

- [Setup/run/Stop/cleanup guide](public-derp-runbook.md).
- [Delivery hashes](evidence/public-derp-delivery-hashes.json).
- [Production operation/native UI evidence](evidence/public-derp-production.json)
  and [displayed production viewport](evidence/public-derp-production.png).
- [Full native failure matrix](evidence/public-derp-native-ui.json).
- [Route/socket/frame evidence](evidence/public-derp-route.json).
- [Ten-minute measurements](evidence/public-derp-performance.json).
- [Review reports](public-derp-reviews.md) and [pinned key/PSK/WireGuard trace](public-derp-key-trace.md).

Final local delivery locations:

```text
dist/public-derp/extension
dist/public-derp/controller
dist/public-derp/delivery.json
dist/public-derp-dev-win32-x64.zip
```

The current ZIP is 116,703,965 bytes, SHA-256
`a3981e1b7295545fa4c8f0feea6f0128c5f09737334220902bf00ef1ad50ddca`.
Inventory SHA-256:
`63f651d9ef8e49c5da3aab4e85c4fdb794457fb574f0032bd9d1c562dca86426`.
Node >=20 is required; no sibling Tailcat checkout or runtime executable download
is needed. Neither byte-identical ZIP output across builds nor public-relay
plaintext visibility is claimed.
