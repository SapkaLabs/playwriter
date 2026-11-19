// Playwriter-owned map validation shared by its native and WASM entry points.
// Transport, keys and WireGuard remain in the unchanged pinned Tailcat module.
package policy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"tailscale.com/tailcfg"
	"time"
	"unicode/utf8"
)

type Input struct {
	DERPMapURL    string `json:"derpMapURL"`
	DERPMapSHA256 string `json:"derpMapSha256"`
	RegionID      int    `json:"regionId"`
	MapJSON       string `json:"mapJSON"`
}

var invalid = errors.New("MAP_INVALID: invalid configured map")
var hostname = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func validHost(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if !hostname.MatchString(label) {
			return false
		}
	}
	return true
}
func ValidURL(s string) bool {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(s, "\\?# \t\r\n") {
		return false
	}
	if p := u.Port(); p != "" {
		n, e := strconv.Atoi(p)
		if e != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}

// Go's struct JSON decoder is case-insensitive. Project exact JSON property
// names before decoding the upstream schema so unknown metadata cannot become
// a routing override (for example, hostname beside HostName).
func projectMap(body string) ([]byte, error) {
	var root map[string]any
	if json.Unmarshal([]byte(body), &root) != nil {
		return nil, invalid
	}
	regions, ok := root["Regions"].(map[string]any)
	if !ok || len(regions) == 0 || len(regions) > 64 {
		return nil, invalid
	}
	projected := map[string]any{}
	for id, value := range regions {
		n, err := strconv.Atoi(id)
		if err != nil || n <= 0 || n > 2147483647 || strconv.Itoa(n) != id {
			return nil, invalid
		}
		r, ok := value.(map[string]any)
		if !ok {
			return nil, invalid
		}
		nodes, ok := r["Nodes"].([]any)
		if !ok || len(nodes) == 0 {
			return nil, invalid
		}
		outNodes := []any{}
		for _, value := range nodes {
			node, ok := value.(map[string]any)
			if !ok {
				return nil, invalid
			}
			out := map[string]any{}
			for _, field := range []string{"Name", "RegionID", "HostName", "DERPPort", "IPv4", "IPv6", "InsecureForTests", "CertName", "STUNTestIP", "STUNOnly"} {
				v, present := node[field]
				if !present {
					continue
				}
				if v == nil && field != "DERPPort" {
					return nil, invalid
				}
				out[field] = v
			}
			outNodes = append(outNodes, out)
		}
		projected[id] = map[string]any{"RegionID": r["RegionID"], "Nodes": outNodes}
	}
	return json.Marshal(map[string]any{"Regions": projected})
}
func (in Input) Validate() (*tailcfg.DERPMap, error) {
	if !ValidURL(in.DERPMapURL) || len(in.MapJSON) == 0 || len(in.MapJSON) > 1<<20 || !utf8.ValidString(in.MapJSON) {
		return nil, invalid
	}
	sum := sha256.Sum256([]byte(in.MapJSON))
	if hex.EncodeToString(sum[:]) != in.DERPMapSHA256 {
		return nil, errors.New("MAP_CHANGED: map bytes differ")
	}
	var raw tailcfg.DERPMap
	projection, err := projectMap(in.MapJSON)
	if err != nil || json.Unmarshal(projection, &raw) != nil || len(raw.Regions) == 0 || len(raw.Regions) > 64 {
		return nil, invalid
	}
	out := &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{}}
	names := map[string]bool{}
	count := 0
	for id, r := range raw.Regions {
		if r == nil || id <= 0 || id > 2147483647 || r.RegionID != id || len(r.Nodes) == 0 {
			return nil, invalid
		}
		region := &tailcfg.DERPRegion{RegionID: id, RegionCode: strconv.Itoa(int(id)), RegionName: strconv.Itoa(int(id))}
		for _, n := range r.Nodes {
			count++
			if count > 256 || n == nil || n.RegionID != id || n.Name == "" || len(n.Name) > 128 || names[n.Name] || !validHost(n.HostName) || n.InsecureForTests || n.CertName != "" || n.STUNTestIP != "" || n.DERPPort < 0 || n.DERPPort > 65535 {
				return nil, invalid
			}
			names[n.Name] = true
			for family, ip := range []string{n.IPv4, n.IPv6} {
				if ip != "" && ip != "none" {
					p, e := netip.ParseAddr(ip)
					if e != nil || p.Zone() != "" || p.Is4() != (family == 0) {
						return nil, invalid
					}
				}
			}
			if n.STUNOnly {
				continue
			}
			port := n.DERPPort
			if port == 0 {
				port = 443
			}
			region.Nodes = append(region.Nodes, &tailcfg.DERPNode{Name: n.Name, RegionID: id, HostName: strings.ToLower(n.HostName), DERPPort: port, IPv4: n.IPv4, IPv6: n.IPv6, STUNPort: -1})
		}
		if len(region.Nodes) > 0 {
			out.Regions[id] = region
		}
	}
	if in.RegionID <= 0 || out.Regions[tailcfg.DERPRegionID(in.RegionID)] == nil {
		return nil, errors.New("REGION_MISMATCH: selected region absent")
	}
	return out, nil
}

// Always fresh, exact-key, read-only, per-connection cache. Tailcat cannot fall
// through to its network fetch path for the validated URL, even after an hour.
type Cache struct {
	URL   string
	Bytes []byte
}

func (c Cache) Get(u string) ([]byte, string, time.Time, bool) {
	if u != c.URL {
		return nil, "", time.Time{}, false
	}
	return c.Bytes, "", time.Now(), true
}
func (c Cache) Put(string, []byte, string) error { return errors.New("immutable map") }
