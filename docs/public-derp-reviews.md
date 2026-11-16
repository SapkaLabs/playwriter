# Public DERP implementation review

Fixed baseline: `597c0f5bddeb9580a9745787bf4f8636e5e155be`.
First review range: `git diff 597c0f5bddeb9580a9745787bf4f8636e5e155be...6738af1f9a199f43f9ea50cf1cbf7cde94ae68b7`.
Two independent agents reviewed repository standards and canonical issue #1.
This records their findings and subsequent validation; it is not final acceptance.

## Standards

- **P2, documented UI rule:** public sharing offered hosted Copy actions in the
  browser menu and toolbar. Both surfaces now copy connection information for
  Tailcat. Hosted copy behavior is preserved. Native UI validation remains unrun.
- **P2, cross-platform rule:** tests hardcoded Windows Edge/native/Go locations.
  Tests now use platform suffixes, the Edge channel, `EDGE_PATH`, `TAILCAT_NATIVE`
  and `TAILCAT_GO`. Windows typecheck and dependency asset test pass; execution
  on another OS is outside this Windows acceptance.
- **Judgment call, repeated switches:** transport selection appears in status,
  persistence and copy handling. Retained for the two-transport PoC; no extra
  adapter hierarchy was introduced.

Standards: two hard findings and one judgment call; the worst hard finding was
misleading public-sharing Copy actions. Source fixes are present; native UI
confirmation is still required.

## Spec

- **P1, revocation:** `createTabInPreferredWindow` awaited window lookup before
  `tabs.create` without checking its epoch. Added guards immediately before both
  creation paths. Real Edge regression failed with an extra page before the fix
  and passed afterward (35.96 s).
- **P1, 32 MiB cap:** adapter and framing queues maintained independent budgets.
  Added a shared endpoint budget and transferred raw WS records directly to
  framing. The 11 framing tests, including shared quota and inclusive 16 MiB
  record cases, pass.
- **P1, failure deadlines:** a whole-script timeout could leave the generation
  usable, and printed commands retained the ordinary 10 s CLI default. The
  dedicated relay now reports execute failure to its supervisor; the generation
  closes and printed commands use 30 s. Real Edge timeout regression passes.
- **P2, preface deadline:** first native output cannot establish when an upstream
  TCP stream connected. A silent established peer exceeds the required 10 s.
  The retained real DERP regression fails. See
  [the reproduction and pending owner decision](public-derp-preface-blocker.md).
- **Acceptance gaps:** native UI Stop, restart/authentication/no-replay matrix,
  final bundle validation and performance evidence were incomplete. These stay
  failed or unrun until demonstrated; source review does not substitute for them.

Spec: four implementation findings plus incomplete acceptance evidence; the worst
severity was P1 revocation/queue/failure behavior. Three source findings have
affected-test coverage; the native establishment deadline remains unresolved.

## Additional regression found during fixes

A cancelled anchor startup could resume after a fresh Share and detach its tab.
The dedicated Edge test failed with `Truncated protocol stream` (13.26 s).
Startup now checks its generation before attaching and stale cleanup preserves
tabs owned by the current share. The same test passes (6.99 s).

## Independent recheck through `3641b25`

The same fixed baseline was used with two fresh independent review agents.
Uncommitted restart/performance helper tests were included. Both reviews were
read-only; neither agent ran browser tests.

### Standards

No new hard documented-standard breach found. Prior Copy behavior, portability,
manifest/tag/changeset bookkeeping and optional relay defaults are resolved in
source. Repeated transport selection remains one judgment call, proportionate
to this two-transport PoC. Native UI confirmation is still required.

Standards recheck: zero hard findings, one judgment call; repeated transport
selection is the only remaining maintainability concern.

### Spec

Four P2 findings:

1. Schema rejection accepted a command without an ID and numeric hello fields.
   Added typed envelope checks for supported messages, preserving valid void
   responses. New malformed-envelope tests first failed in 11 cases; all 24
   framing tests passed in both ingress and egress directions; a further bounded
   diagnostic-name check brings the suite to 25 passing cases.
2. Inherited extension diagnostics could log remote navigation URLs/parameters.
   Real Edge marker-URL test failed before the fix and passed afterward (9.76 s).
   Public shares suppress these diagnostics, with scoped suppression retained
   until pending dispatch/startup work completes after Stop. Queued group/tab
   operations stay inside their dispatch lifetime.
3. The standalone unpacked extension lacked dependency notices; only the
   controller had them. Bundle verification reproduced the missing Tailcat
   license. The Vite copy now includes the notice directory; an actual standalone
   build contains Tailcat and Go licenses. Final bundle verification is pending.
4. Exact native preface deadline remains failed. This still needs the pending
   owner decision; no timeout was waived.

The reviewer confirmed prior revocation, shared-budget and terminal-failure
fixes, and found no material scope creep. Native UI, final artifact-bound
validation, performance evidence and regression success remain obligations.

Spec recheck: four P2 findings; three have source fixes and affected checks,
and the stream-establishment deadline remains unresolved.

## Launcher review after owner approval

The owner approved the narrow local launcher adjustment on 2026-11-16. This
supersedes the pending-decision status above. The retained real public-DERP
silent-peer test passes (15.25 s), resolving the original preface finding.

### Standards

Fresh independent review found no new documented-standard breach or material
heuristic concern. Paths/commands remain portable, the pinned library and CLI
remain unchanged, and the change includes a `playwriter` patch changeset. The
supervisor has a concrete process-ownership responsibility.

### Spec

Fresh independent review found no new material implementation defect or scope
creep. The approved launcher uses a fresh in-memory key, fixed public map and
port 1. Its one post-Dial local notification starts the existing 10 s preface
timer after the 60 s startup stage; stdout remains the binary stream. The
upstream CLI remains the parser. Final artifact-bound tests, native Start/Copy/
Stop matrix and refreshed timing/memory evidence remain acceptance obligations.

Launcher review: zero Standards findings; zero new Spec code findings, three
acceptance-evidence obligations. These reports are separate from runtime results.
