// Playwriter's owned pipe entry point; transport and cryptography remain in the
// unchanged pinned Tailcat library. Stdout is exclusively the binary stream.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/tailscale/tailcat"
	"playwriter.local/tailcat-runtime/policy"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

type configuration struct {
	policy.Input
	Addr string `json:"addr"`
}

func configuredClient(input configuration) (*tailcat.Client, error) {
	dm, err := input.Validate()
	if err != nil {
		return nil, err
	}
	address, err := tailcat.ParseAddr(tailcat.Addr(input.Addr))
	if err != nil {
		return nil, err
	}
	if address.PresharedKey.IsZero() || address.ServerPublic.IsZero() || len(address.Region) != 0 || address.RegionID != tailcfg.DERPRegionID(input.RegionID) {
		return nil, fmt.Errorf("invalid address")
	}
	// Project to precisely the one permitted region. Other profiles/default
	// topology cannot enter the native runtime through URL, env or cache.
	dm.Regions = map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{address.RegionID: dm.Regions[address.RegionID]}
	mapBytes, err := json.Marshal(dm)
	if err != nil {
		return nil, err
	}
	return &tailcat.Client{
		Server: tailcat.Addr(input.Addr), Key: key.NewNode(), Logf: logger.Discard,
		DERPMapURL:   input.DERPMapURL,
		DERPMapCache: policy.Cache{URL: input.DERPMapURL, Bytes: mapBytes},
	}, nil
}
func run() error {
	if len(os.Args) != 3 || os.Args[1] != "--config" {
		return fmt.Errorf("private configuration file required")
	}
	file, err := os.Open(os.Args[2])
	if err != nil {
		return err
	}
	defer file.Close()
	var input configuration
	if err := json.NewDecoder(io.LimitReader(file, 8<<20)).Decode(&input); err != nil {
		return err
	}
	client, err := configuredClient(input)
	if err != nil {
		return err
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := client.Ping(ctx); err != nil {
		return err
	}
	conn, err := client.DialTCPPort(ctx, 1)
	if err != nil {
		return err
	}
	defer conn.Close()
	// The supervisor accepts only this fixed, bounded local notification.
	if _, err := io.WriteString(os.Stderr, "{\"stage\":\"stream-established\"}\n"); err != nil {
		return err
	}
	go func() {
		if _, err := io.Copy(conn, os.Stdin); err != nil {
			conn.Close()
			return
		}
		if half, ok := conn.(interface{ CloseWrite() error }); ok {
			if err := half.CloseWrite(); err != nil {
				conn.Close()
			}
		}
	}()
	if _, err := io.Copy(os.Stdout, conn); err != nil {
		return err
	}
	drain, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	client.DrainTCP(drain)
	return nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--help" {
		fmt.Println("Playwriter Tailcat launcher --config <private-file>; configured DERP, port 1")
		return
	}
	if run() != nil {
		// Never emit the library error: it can contain the secret address.
		fmt.Fprintln(os.Stderr, "Native transport failed")
		os.Exit(1)
	}
}
