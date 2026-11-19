package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/tailscale/tailcat"
	"os"
	"playwriter.local/tailcat-runtime/policy"
	"testing"
)

func TestConfiguredClientIsolatedMaps(t *testing.T) {
	for _, host := range []string{"relay-a.example", "relay-b.example"} {
		raw := fmt.Sprintf(`{"Regions":{"900":{"RegionID":900,"Nodes":[{"Name":"node","RegionID":900,"HostName":%q,"DERPPort":8443}]}}}`, host)
		hash := sha256.Sum256([]byte(raw))
		key := tailcat.NewPrivateKey()
		key.Public.RegionID = 900
		in := configuration{Input: policy.Input{DERPMapURL: "https://map.example/map", DERPMapSHA256: hex.EncodeToString(hash[:]), RegionID: 900, MapJSON: raw}, Addr: string(key.Public.Addr())}
		client, err := configuredClient(in)
		if err != nil {
			t.Fatal(err)
		}
		info, err := tailcat.ParseAddr(client.Server)
		if err != nil {
			t.Fatal(err)
		}
		// Exercise the actual Tailcat address expansion using the launcher-created
		// cache. This must never fetch the URL or merge default/public regions.
		if err := info.Expand(context.Background(), tailcat.DERPMapURL(client.DERPMapURL), client.DERPMapCache); err != nil {
			t.Fatal(err)
		}
		if len(info.Region) != 1 || len(info.Region[0].Nodes) != 1 || info.Region[0].Nodes[0].HostName != host || info.Region[0].Nodes[0].DERPPort != 8443 {
			t.Fatal("configuration did not reach Tailcat")
		}
		in.DERPMapSHA256 = string(make([]byte, 64))
		if _, err := configuredClient(in); err == nil {
			t.Fatal("accepted changed map")
		}
	}
}

func TestSharedMapCases(t *testing.T) {
	bytes, err := os.ReadFile("map-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name  string
		Body  json.RawMessage
		Valid bool
	}
	if err := json.Unmarshal(bytes, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			hash := sha256.Sum256(c.Body)
			in := policy.Input{DERPMapURL: "https://map.example/map", DERPMapSHA256: hex.EncodeToString(hash[:]), RegionID: 900, MapJSON: string(c.Body)}
			m, err := in.Validate()
			if (err == nil) != c.Valid {
				t.Fatalf("validation parity: valid=%v, err=%v", c.Valid, err)
			}
			if c.Valid && (m.Regions[900].Nodes[0].HostName != "relay-a.example" || m.Regions[900].Nodes[0].DERPPort != 8443) {
				t.Fatal("metadata changed routing")
			}
		})
	}
}
