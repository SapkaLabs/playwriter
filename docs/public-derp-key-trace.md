# Pinned key and WireGuard source trace

This is source evidence, inspected at unchanged Tailcat commit
`e00cdde6ff787f801361ff85ed085775c775d4c5`. It is separate from the real
authentication negatives in `playwriter/src/tailcat-auth.test.ts`.

| Boundary                 | Source evidence                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh browser capability | [`web/main_js.go`](https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/web/main_js.go#L55) creates a new private key when none is supplied, then starts the server with its private key and PSK. Playwriter supplies no persisted key.                     |
| Key generation           | [`NewPrivateKey`](https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L319) generates a node key, derives public/discovery keys and creates a random PSK. The address serializes public information and that PSK, so it is a bearer capability. |
| Browser export           | `extension/src/tailcat-worker.ts` returns only the address from the upstream listener result. The upstream private-key JSON remains in the dedicated worker. Stop/owner loss terminates that worker; no Tailcat restoration record is written.                                            |
| Native identity          | `playwriter/src/tailcat-native.ts` invokes the pinned CLI with `--key=new`. [`Client.initLocked`](https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L1990) loads the server public key and PSK from the address into its backend.             |
| Engine configuration     | [`peerConfig`](https://github.com/tailscale/tailcat/blob/e00cdde6ff787f801361ff85ed085775c775d4c5/tailcat.go#L1455) supplies the PSK to WireGuard peers. The engine receives the private key and live peer configuration before networking starts.                                        |

The pin's `go.mod` selects `github.com/tailscale/wireguard-go` at
`e61b6b78110b`. In its
[`device/noise-protocol.go`](https://github.com/tailscale/wireguard-go/blob/e61b6b78110b/device/noise-protocol.go#L500),
the handshake mixes the PSK through KDF3 and authenticates the transcript;
the receive path rejects a mismatched authenticator. Its data-plane
[`send.go`](https://github.com/tailscale/wireguard-go/blob/e61b6b78110b/device/send.go#L617)
and
[`receive.go`](https://github.com/tailscale/wireguard-go/blob/e61b6b78110b/device/receive.go#L251)
apply authenticated encryption/decryption with the negotiated keypair.

The real public DERP test rejects a wrong PSK and a substituted server public key,
and then connects successfully with the original descriptor. Missing/zero PSKs
are rejected before starting a native connection. Test mutations and parsed
addresses stay private; reports contain pass/fail and timing only.

These observations support the pinned end-to-end encryption/authentication
design. We do not observe plaintext at a public relay, and an opaque socket
capture alone would not prove encryption. Local adapter traffic is loopback
plaintext protected by its per-connection capability and admission checks.
