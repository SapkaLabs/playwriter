# Configurable DERP — Stage 1

Contract: [specification #12](https://github.com/SapkaLabs/playwriter/issues/12).
Implementation: [browser #13](https://github.com/SapkaLabs/playwriter/issues/13),
[CLI #14](https://github.com/SapkaLabs/playwriter/issues/14),
[switching #16](https://github.com/SapkaLabs/playwriter/issues/16), and
[verification #17](https://github.com/SapkaLabs/playwriter/issues/17).
This is a developer feature; no package or store publication is implied.

## Browser

Open **Share browser** from the extension menu. Select a saved server and a tab,
then **Start sharing**. **Manage servers** adds, renames, edits, removes, or
validates profiles. A URL must explicitly identify an HTTPS DERP map, for
example `https://map.example/map.json`; a relay hostname is not a map URL.
Validation shows usable regions and nodes without starting a share. Saving
syntax-valid profiles works offline. Public is initialized once as an ordinary,
editable profile; deleting it never restores it automatically.

Selecting another server while active asks **Stop and select** or **Cancel**.
Accepting revokes the current share, waits for worker disposal, saves the
selection and leaves sharing stopped. Click **Start sharing** separately.
Editing or removing the active profile similarly requires **Stop and save** or
**Stop and remove**. Inactive profiles can be edited without stopping. A failed
save after revocation retains the old configuration, with sharing stopped.
Concurrent settings edits fail with `CONFIG_CONFLICT`; reload before saving.

**Stop sharing** remains usable while starting, disconnected, failed, offline,
or awaiting confirmation. It destroys the worker and its ephemeral keys.
Restarting the worker, background or browser never resumes a DERP share.
There is one active share and one admitted controller, including a controller
still handshaking. Another controller cannot take over. If a dead controller's
stream has not yet been detected, Stop and Start releases it and creates fresh
connection information.

## CLI

The developer bundle retains the historical `dist/public-derp` output directory
name; its transport now uses configured maps. Build as described in
[the build runbook](public-derp-runbook.md). Commands below use the packaged
`playwriter-tailcat` entrypoint (`playwriter-tailcat.cmd` on Windows).

```text
playwriter-tailcat profile list
playwriter-tailcat profile add Lab --derp-map-url https://map.example/map.json
playwriter-tailcat profile edit Lab --name Office
playwriter-tailcat profile select Office
playwriter-tailcat profile validate
playwriter-tailcat profile select --none
playwriter-tailcat profile remove Office
playwriter-tailcat connect --descriptor <private-json-file>
playwriter-tailcat disconnect --connection <local-connection-id>
```

Descriptor-only connect needs no matching saved profile. Optional `--profile`
or `--derp-map-url` asserts an exact normalized URL match; using both or
conflicting with the descriptor fails before transport startup. Saved selection
never overrides a descriptor. No environment variable chooses the remote server;
inherited `TAILCAT_DERPMAP_URL` is stripped. Profile edits affect future commands,
never an existing connection. CLI disconnect does not revoke browser sharing.

All profile commands accept `--config <file>`, ahead of
`PLAYWRITER_TAILCAT_CONFIG`, ahead of the default. The default is
`LOCALAPPDATA/playwriter-tailcat/profiles.json` on Windows and
`~/.config/playwriter-tailcat/profiles.json` on macOS/Linux (absolute
`XDG_CONFIG_HOME` is honored). Writes are private, locked and atomic. A crash
may leave a `.lock`; confirm no profile command is running before removing that
specific lock. Browser profiles live independently in `chrome.storage.local`.
Neither store contains descriptors or keys. Corrupt stores fail without reset.

## Transport and compatibility

Every Start/connect freshly fetches the exact HTTPS map with no redirects,
cookies or stale-cache rescue: 10 seconds including body, maximum 1 MiB,
64 regions and 256 nodes. Routing fields are validated and allowlisted; custom
certificate names, insecure TLS and custom CA setup are unsupported. The lowest
usable region ID is chosen once for a share. Both runtimes receive the same
validated map bytes and selected region; library defaults cannot add public
nodes. Existing Tailcat encryption, key generation and PWTC1 framing are unchanged.

v2 descriptors bind the short secret address to a fresh share ID, normalized map
URL, SHA-256 of the exact map bytes, and region. The encrypted hello also binds
the controller to the worker's connection generation. Never publish descriptors.
Changed map bytes require Stop/Start and fresh connection information. New CLI
supports genuine v1 public extension descriptors without requiring v2 hello
fields. Old CLI rejects v2: update it. Local/hosted WS clients keep their existing
protocol. Extension rollout must precede requiring new extension capabilities.

Underlying Tailcat transport may retry nodes only within the frozen selected
region. It cannot choose another region, profile or map. There is no application
reconnect, Start or command replay. A broken application stream is terminal;
manually connect again. Dispatched commands may have run even if their response
was lost: observe the page before repeating them. Stop cancels pending work and
prevents old callbacks and responses entering the next share.

Errors identify configuration, map and session failures (`CONFIG_CONFLICT`,
`MAP_URL_INVALID`, `MAP_UNAVAILABLE`, `MAP_TIMEOUT`, `MAP_REDIRECT`, `MAP_INVALID`,
`MAP_TOO_LARGE`, `MAP_CHANGED`, `SERVER_MISMATCH`, `SESSION_MISMATCH`). Network
errors can include TLS or permission failures that the browser cannot distinguish.
Correct the selected configuration and retry explicitly; failure never selects
Public. Startup is bounded to 60 seconds and protocol preface to 10 seconds.

## Verification and Stage 2

See [Stage 1 acceptance](configurable-derp-acceptance.md) for executed checks and
limitations. Tests use synthetic disjoint maps and real public DERP. Two profile
names referencing Public demonstrate alias/lifecycle behavior only.

[Stage 2 #15](https://github.com/SapkaLabs/playwriter/issues/15) remains deferred:
actual private TLS/network/browser-policy qualification, real public↔private and
independent-private switching, private-only egress with public blocked, real DNS/
certificate/server faults, separate-machine topology and the supported platform
matrix. Deployment belongs to `SapkaLabs/derp-stack`. No private server, deployment,
certificate automation, container publication or new cryptographic policy is
included here.
