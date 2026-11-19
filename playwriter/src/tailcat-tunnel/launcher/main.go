// Playwriter's owned pipe entry point; transport and cryptography remain in the
// unchanged pinned Tailcat library. Stdout is exclusively the binary stream.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("one private address is required")
	}
	client := &tailcat.Client{
		Server: tailcat.Addr(os.Args[1]), Key: key.NewNode(), Logf: logger.Discard,
		DERPMapURL: "https://tailcat.dev/derpmap.json",
	}
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
		fmt.Println("Playwriter Tailcat launcher <private-address>; public DERP, port 1")
		return
	}
	if run() != nil {
		// Never emit the library error: it can contain the secret address.
		fmt.Fprintln(os.Stderr, "Native transport failed")
		os.Exit(1)
	}
}
