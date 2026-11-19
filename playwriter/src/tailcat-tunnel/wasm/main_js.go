// Copyright (c) Tailscale Inc & contributors; SPDX-License-Identifier: BSD-3-Clause
// Playwriter-owned supplied-map entry point. Connection/promise glue adapted
// from pinned Tailcat web/main_js.go; upstream transport is unchanged.
package main

import (
	"encoding/json"
	"errors"
	"github.com/tailscale/tailcat"
	"io"
	"net"
	"playwriter.local/tailcat-runtime/policy"
	"syscall/js"
	"tailscale.com/tailcfg"
	"tailscale.com/types/logger"
)

func main() {
	js.Global().Set("tailcatListen", js.FuncOf(listen))
	if f := js.Global().Get("onTailcatReady"); f.Type() == js.TypeFunction {
		f.Invoke()
	}
	select {}
}
func listen(this js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeObject {
		return rejectedPromise(errors.New("MAP_INVALID"))
	}
	opts := args[0]
	return makePromise(func() (any, error) {
		var in policy.Input
		if opts.Get("configuration").Type() != js.TypeString || json.Unmarshal([]byte(opts.Get("configuration").String()), &in) != nil {
			return nil, errors.New("MAP_INVALID")
		}
		dm, err := in.Validate()
		if err != nil {
			return nil, err
		}
		onConnection := opts.Get("onConnection")
		if onConnection.Type() != js.TypeFunction {
			return nil, errors.New("Invalid callback")
		}
		pk := tailcat.NewPrivateKey()
		pk.Public.RegionID = tailcfg.DERPRegionID(in.RegionID)
		srv := &tailcat.Server{Key: pk.Private, PresharedKey: pk.Public.PresharedKey, Region: dm.Regions[tailcfg.DERPRegionID(in.RegionID)], Logf: logger.Discard}
		srv.OnTCP = func(port uint16) func(net.Conn) {
			if port != 1 {
				return nil
			}
			return func(c net.Conn) { onConnection.Invoke(makeJSConn(c, port, nil)) }
		}
		if err := srv.Start(); err != nil {
			srv.Close()
			return nil, errors.New("Transport startup failed")
		}
		return map[string]any{"addr": string(pk.Public.Addr()), "close": js.FuncOf(func(this js.Value, args []js.Value) any { srv.Close(); return nil })}, nil
	})
}
func makeJSConn(c net.Conn, port uint16, onClose func()) js.Value {
	buf := make([]byte, 64<<10)
	return js.ValueOf(map[string]any{
		"port": int(port),
		"read": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				n, err := c.Read(buf)
				if n > 0 {
					u8 := js.Global().Get("Uint8Array").New(n)
					js.CopyBytesToJS(u8, buf[:n])
					return u8, nil
				}
				if err == nil || errors.Is(err, io.EOF) {
					return js.Null(), nil
				}
				return nil, err
			})
		}),
		"write": js.FuncOf(func(this js.Value, args []js.Value) any {
			if len(args) != 1 {
				return rejectedPromise(errors.New("write requires a Uint8Array"))
			}
			b := make([]byte, args[0].Get("length").Int())
			js.CopyBytesToGo(b, args[0])
			return makePromise(func() (any, error) {
				if _, err := c.Write(b); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"closeWrite": js.FuncOf(func(this js.Value, args []js.Value) any {
			return makePromise(func() (any, error) {
				cw, ok := c.(interface{ CloseWrite() error })
				if !ok {
					return nil, errors.New("connection does not support half-close")
				}
				if err := cw.CloseWrite(); err != nil {
					return nil, err
				}
				return js.Undefined(), nil
			})
		}),
		"close": js.FuncOf(func(this js.Value, args []js.Value) any {
			c.Close()
			if onClose != nil {
				onClose()
			}
			return nil
		}),
	})
}

func makePromise(f func() (any, error)) js.Value {
	handler := js.FuncOf(func(this js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			if res, err := f(); err == nil {
				resolve.Invoke(res)
			} else {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			}
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func rejectedPromise(err error) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(err.Error()))
}
