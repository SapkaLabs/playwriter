# Configurable DERP Stage 1 acceptance

Scope: [specification #12](https://github.com/SapkaLabs/playwriter/issues/12),
[browser #13](https://github.com/SapkaLabs/playwriter/issues/13),
[CLI/native #14](https://github.com/SapkaLabs/playwriter/issues/14),
[switching #16](https://github.com/SapkaLabs/playwriter/issues/16), and
[verification #17](https://github.com/SapkaLabs/playwriter/issues/17).
Owner explicitly invoked Stage 1 implementation after specification approval.
No server was deployed and no package, store release or image was published.

## Environment and provenance

Executed 2026-11-17 on Windows with Edge **157.0.4341.46**, Node **24.12.0**,
Go **1.27.2**, and extension **0.0.181**. Implementation baseline:
`2905b02f008665e4baf3692e3b28ec8abfa4ae00`. Tailcat remains pinned to
`e00cdde6ff787f801361ff85ed085775c775d4c5`; transport and crypto source are unchanged.
The shared map policy and WASM/native entry points are Playwriter-owned.

Tests ran against working-tree artifacts; the delivery inventory honestly records
the baseline commit plus `sourceDirty: true`. The sanitized
[evidence summary](evidence/configurable-derp-stage1.json) records artifact hashes
and the implementation patch hash. Raw capability files, profiles and captures
are not published. Existing user changes in the submodule, generated website
resources and research notes are excluded from this implementation.

## Automated configuration and lifecycle

- **70 unit/CLI tests passed:** configuration CRUD and persistence, revisions,
  authoritative IDs, platform path precedence, real CLI assertions, exact map
  selection, invalid URL/schema/UTF8, redirects, size limits, body timeout,
  cancellation, warm-fetch failure, map hash/region mismatch, forged hello and
  framing. The native build also runs Go supplied-cache tests against the real
  Tailcat expansion API and the same adversarial map corpus as TypeScript.
- **Disjoint synthetic routes passed:** actual browser WASM attempts A→B→A,
  same region ID in distinct maps, nondefault relay ports, same-region node
  retries, no attempts to another region/profile/map, invalid map failure and
  Stop while offline. Public remains saved and is not substituted. These are
  controlled map fixtures with observed socket attempts, not private deployments.
- **Browser ownership and revocation passed:** competing Start requests, a
  blocked map, timeout, Stop before/after descriptor creation, Stop during switch
  confirmation, cancel switch, active edit/delete, failed storage after revocation,
  held dispatch/response/write continuations, partial transfers, worker loss,
  actual background/extension/browser restarts, old-descriptor rejection around
  fresh positive controls, preface timeout and concurrent controllers before and
  after handshake. No automatic command replay or unauthorized takeover.
- **Compatibility passed:** the new controller connected to retained, unmodified
  extension **0.0.180**, using its genuine v1 public descriptor and hello without
  v2 metadata. Ordinary local and hosted sharing regressions retain their WS
  protocol and ownership behavior.

## Real public DERP

The new v2 profile path passed real read/write/screenshot, navigation, bounded
response transfer, explicit disconnect/reconnect and Stop. The route harness
kept browser bootstrap, dedicated relay, adapter and fixture endpoints distinct,
denied ordinary local extension registration, observed browser DERP sockets and
native TCP sockets, cut the DERP data route while loopback remained healthy, and
verified terminal failure/no replay before manual recovery.

The compiled production developer bundle was copied away from the checkout and
tested with its packaged extension/native launcher. Descriptor-only connection
succeeded with both an unrelated saved CLI selection and a poisoned inherited
`TAILCAT_DERPMAP_URL`; neither overrode the descriptor. Copy, fixture operations,
screenshot and explicit disconnect passed. Bundle notices, hashes, physical-file
relocation and entry points passed verification.

The Public-alias test proves profile handling and fresh-session isolation. It is
**not** evidence of switching between independent real servers. Independent
destinations in Stage 1 are synthetic. No private-server result is claimed.

## Regression and review record

The first broad transport run exposed two failures: the UI threw on a retained
failure status instead of rendering it, and a validation fixture exercised a
cached earlier validator. The UI was corrected; fresh validator tests and all
affected browser tests passed with rebuilt artifacts. No failure is waived.

The ordinary regression run exposed a recorder test clicking before the toolbar
rendered Stop, and a Windows CRLF fixture changing HTML truncation snapshots.
The tests now wait for visible state and normalize fixture line endings. No
recorder/HTML production behavior or expected snapshots were changed. A heavily
parallel run also encountered the repository's documented Playwright teardown
assertion race; the final run limits concurrent workers.

Final ordinary regression: **455 passed, 0 failed, 30 integration tests skipped**
with `--maxWorkers=4` and snapshot updates disabled. Separate DERP runs cover
**29 integration cases**; only the optional performance measurement remains
unrun. The 70 configuration/CLI/framing cases are part of the ordinary count,
not an additional 70 tests.

### Standards review

The independent standards review found no documented-standard breach. Its UI
failure finding and validation-parity concern were fixed and tested. Manifest
bump, changeset, unchanged WS compatibility and platform-neutral paths are included.

### Specification review

The independent specification review found three issues: failure-state rendering,
case-insensitive Go JSON decoding allowing unknown metadata to retarget routing,
and CLI loss of structured session errors. All were corrected. Exact-case routing
projection, shared native/browser adversarial fixtures and real forged-session
rejection now cover these boundaries. No scope creep or Stage 1 product decision
remains unresolved. Review fixes were verified by the implementing agent.

## Reproduction

Use the [build instructions](public-derp-runbook.md) and
[configuration guide](configurable-derp.md). Existing initialized workspace setup
was reused; new worktrees must run the repository bootstrap first.

```powershell
pnpm --filter playwriter typecheck
pnpm --filter playwriter exec vitest run --maxWorkers=4
node --test scripts/tailcat-assets.test.mjs
node scripts/verify-tailcat-bundle.mjs

# Build extension/dist-tailcat with TESTING=1, PLAYWRITER_PORT=19987,
# PLAYWRITER_OPEN_WELCOME_PAGE=0 and PLAYWRITER_TAILCAT_ASSETS set.
$env:PLAYWRITER_TAILCAT_TESTS = '1'
pnpm --filter playwriter exec vitest run src/tailcat-tunnel --no-file-parallelism

$env:PLAYWRITER_TAILCAT_DELIVERY = '1'
pnpm --filter playwriter exec vitest run src/tailcat-tunnel/delivery.test.ts
```

For the mixed-version test, set `PLAYWRITER_TAILCAT_LEGACY_EXTENSION` to a retained
v1 extension build. The optional ten-minute performance measurement was not rerun;
Stage 1 introduces no performance acceptance threshold or TTL policy.

## Stage 2 and platform limits

Linux/macOS launcher cross-compilation and Windows/macOS/Linux configuration-path
tests passed. Actual macOS/Linux browser/native runtime qualification was not run.
No private server is available. [Stage 2 #15](https://github.com/SapkaLabs/playwriter/issues/15)
still owns actual private TLS/permissions/network qualification, public↔private
and independent-private switching, private-only operation with public egress
blocked, real DNS/certificate/server faults, separate-machine topology and the
supported browser/platform matrix. Deployment stays in `SapkaLabs/derp-stack`.
