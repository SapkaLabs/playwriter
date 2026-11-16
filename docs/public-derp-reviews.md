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

Final review must include all changes after `6738af1`, using the same fixed
baseline, after the remaining material findings and acceptance rows are resolved.
