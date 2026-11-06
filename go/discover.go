package nozomi

import (
	"bufio"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

// ManifestURL is the published endpoint list (endpoints.json at the repo root).
const ManifestURL = "https://raw.githubusercontent.com/temporalxyz/nozomi-sdk/main/endpoints.json"

const (
	probePings   = 5
	probeTimeout = 5 * time.Second
)

// Endpoint is a Nozomi endpoint. RTT, set by Discover, is its fastest
// GET /ping round trip over a warm connection.
type Endpoint struct {
	URL    string        `json:"url"`
	Region string        `json:"region"`
	RTT    time.Duration `json:"-"`
}

// builtinEndpoints is endpoints.json as of this release, used when ManifestURL
// can't be read. A test keeps it equal to ../endpoints.json.
var builtinEndpoints = []Endpoint{
	{URL: "https://edge.nozomi.temporal.xyz", Region: "edge"},
	{URL: "https://nozomi.temporal.xyz", Region: "auto"},
	{URL: "https://pit1.nozomi.temporal.xyz", Region: "pittsburgh"},
	{URL: "https://tyo1.nozomi.temporal.xyz", Region: "tokyo"},
	{URL: "https://sgp1.nozomi.temporal.xyz", Region: "singapore"},
	{URL: "https://ewr1.nozomi.temporal.xyz", Region: "newark"},
	{URL: "https://ams1.nozomi.temporal.xyz", Region: "amsterdam"},
	{URL: "https://fra2.nozomi.temporal.xyz", Region: "frankfurt"},
	{URL: "https://ash1.nozomi.temporal.xyz", Region: "ashburn"},
	{URL: "https://lax1.nozomi.temporal.xyz", Region: "los-angeles"},
	{URL: "https://lon1.nozomi.temporal.xyz", Region: "london"},
	{URL: "https://pit.nozomi.temporal.xyz", Region: "pittsburgh"},
	{URL: "https://tyo.nozomi.temporal.xyz", Region: "tokyo"},
	{URL: "https://sgp.nozomi.temporal.xyz", Region: "singapore"},
	{URL: "https://ewr.nozomi.temporal.xyz", Region: "newark"},
	{URL: "https://ams.nozomi.temporal.xyz", Region: "amsterdam"},
	{URL: "https://fra.nozomi.temporal.xyz", Region: "frankfurt"},
	{URL: "https://ash.nozomi.temporal.xyz", Region: "ashburn"},
	{URL: "https://lax.nozomi.temporal.xyz", Region: "los-angeles"},
	{URL: "https://lon.nozomi.temporal.xyz", Region: "london"},
}

// Discover pings every published endpoint in parallel and returns the
// reachable ones, fastest first. The list comes from ManifestURL, or a
// built-in copy if that can't be read.
func Discover(ctx context.Context) ([]Endpoint, error) {
	return probeAll(ctx, knownEndpoints(ctx))
}

func knownEndpoints(ctx context.Context) []Endpoint {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ManifestURL, nil)
	if err != nil {
		return slices.Clone(builtinEndpoints)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return slices.Clone(builtinEndpoints)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		if eps := parseManifest(io.LimitReader(resp.Body, 1<<20)); len(eps) > 0 {
			return eps
		}
	}
	return slices.Clone(builtinEndpoints)
}

// parseManifest reads endpoints.json, keeping only trusted endpoints.
func parseManifest(r io.Reader) []Endpoint {
	var m struct {
		Endpoints []Endpoint `json:"endpoints"`
	}
	if json.NewDecoder(r).Decode(&m) != nil {
		return nil
	}
	eps := slices.DeleteFunc(m.Endpoints, func(e Endpoint) bool { return !trusted(e.URL) })
	return eps[:min(len(eps), maxConns)] // bounds the probe fan-out
}

// trusted reports whether raw is an https URL on nozomi.temporal.xyz. The
// client sends its API key and transactions to whatever the manifest lists,
// so a tampered manifest must not be able to point anywhere else.
func trusted(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	h := u.Hostname()
	return h == "nozomi.temporal.xyz" || strings.HasSuffix(h, ".nozomi.temporal.xyz")
}

func probeAll(ctx context.Context, eps []Endpoint) ([]Endpoint, error) {
	errs := make([]error, len(eps))
	var wg sync.WaitGroup
	for i := range eps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eps[i].RTT, errs[i] = probe(ctx, eps[i].URL)
		}()
	}
	wg.Wait()
	up := eps[:0]
	for i, e := range eps {
		if errs[i] == nil {
			up = append(up, e)
		}
	}
	if len(up) == 0 {
		return nil, fmt.Errorf("nozomi: no endpoint reachable: %w", errors.Join(errs...))
	}
	slices.SortStableFunc(up, func(a, b Endpoint) int { return cmp.Compare(a.RTT, b.RTT) })
	return up, nil
}

// probe returns the fastest of probePings GET /ping round trips on one new
// connection, so the handshake never counts.
func probe(ctx context.Context, endpoint string) (time.Duration, error) {
	t, err := parseEndpoint(endpoint, 1)
	if err != nil {
		return 0, err
	}
	deadline := time.Now().Add(probeTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	cn, err := t.dial(ctx, time.Until(deadline))
	if err != nil {
		return 0, err
	}
	defer cn.Close()
	cn.SetDeadline(deadline)
	defer context.AfterFunc(ctx, func() { cn.SetDeadline(time.Now()) })()

	r, req, body := bufio.NewReaderSize(cn, readerSize), t.pingReq("nozomi-sdk-go/"+Version), make([]byte, maxBody)
	best := time.Duration(math.MaxInt64)
	for range probePings {
		start := time.Now()
		if _, err := cn.Write(req); err != nil {
			return 0, err
		}
		status, _, reuse, err := readResponse(r, body)
		if err != nil {
			return 0, err
		}
		if status != 200 {
			return 0, &HTTPError{StatusCode: status}
		}
		best = min(best, time.Since(start))
		if !reuse {
			break
		}
	}
	return best, nil
}
