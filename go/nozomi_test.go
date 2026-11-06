package nozomi

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRouter mimics /api/sendBatch: it accepts entries in order and stops at
// the first rejected one (any tx starting with 'X').
type fakeRouter struct {
	mu      sync.Mutex
	txs     map[string]int
	batches int
	pings   int
	conns   int
	delay   time.Duration
	ua      map[string]int // User-Agent of every request
}

func (f *fakeRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ua[r.UserAgent()]++
	switch r.URL.Path {
	case "/ping":
		f.pings++
		io.WriteString(w, "pong\n")
	case "/api/sendBatch":
		if r.URL.Query().Get("c") != "key" || r.Header.Get("Content-Type") != "application/octet-stream" {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		time.Sleep(f.delay)
		body, _ := io.ReadAll(r.Body)
		f.batches++
		for len(body) > 0 {
			n := int(binary.BigEndian.Uint16(body))
			tx := string(body[2 : 2+n])
			body = body[2+n:]
			if tx[0] == 'X' {
				http.Error(w, "Insufficient tip", http.StatusBadRequest)
				return
			}
			f.txs[tx]++
		}
	}
}

func start(t *testing.T, tlsServer bool) (*fakeRouter, *httptest.Server) {
	f := &fakeRouter{txs: map[string]int{}, ua: map[string]int{}}
	srv := httptest.NewUnstartedServer(f)
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			f.mu.Lock()
			f.conns++
			f.mu.Unlock()
		}
	}
	if tlsServer {
		srv.StartTLS()
	} else {
		srv.Start()
	}
	t.Cleanup(srv.Close)
	return f, srv
}

func TestCoalesceAndIsolateRejects(t *testing.T) {
	f, srv := start(t, false)
	f.delay = 20 * time.Millisecond
	c, err := New(Config{Endpoint: srv.URL, APIKey: "key", Conns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	ctx := context.Background()
	errs := make([]error, 41)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tx := fmt.Sprintf("tx%02d", i)
			if i == 20 {
				tx = "Xbad"
			}
			errs[i] = c.Send(ctx, []byte(tx))
		}()
	}
	wg.Wait()

	var he *HTTPError
	if !errors.As(errs[20], &he) || he.StatusCode != 400 || he.Body != "Insufficient tip" {
		t.Fatalf("bad tx: got %v", errs[20])
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, err := range errs {
		if i != 20 && (err != nil || f.txs[fmt.Sprintf("tx%02d", i)] == 0) {
			t.Fatalf("tx%02d: err=%v delivered=%d", i, err, f.txs[fmt.Sprintf("tx%02d", i)])
		}
	}
	t.Logf("%d requests for 41 txs", f.batches)
	if f.batches >= 41 {
		t.Fatalf("no coalescing: %d requests for 41 txs", f.batches)
	}
	if f.conns != 1 {
		t.Fatalf("opened %d connections, want 1", f.conns)
	}
}

func TestKeepAliveAndReconnect(t *testing.T) {
	f, srv := start(t, false)
	c, err := New(Config{Endpoint: srv.URL, APIKey: "key", Conns: 3, PingInterval: 30 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	time.Sleep(150 * time.Millisecond)
	f.mu.Lock()
	pings, conns := f.pings, f.conns
	f.mu.Unlock()
	if pings < 6 || conns != 3 {
		t.Fatalf("pings=%d conns=%d, want >=6 pings on 3 conns", pings, conns)
	}

	srv.CloseClientConnections()
	if err := c.SendBatch(context.Background(), [][]byte{[]byte("a"), []byte("b")}); err != nil {
		t.Fatalf("send after server dropped connections: %v", err)
	}
}

func TestUnauthorized(t *testing.T) {
	_, srv := start(t, false)
	c, err := New(Config{Endpoint: srv.URL, APIKey: "wrong"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var he *HTTPError
	if err := c.Send(context.Background(), []byte("a")); !errors.As(err, &he) || he.StatusCode != 401 {
		t.Fatalf("got %v, want 401", err)
	}
}

func TestTLS(t *testing.T) {
	f, srv := start(t, true)
	ca := filepath.Join(t.TempDir(), "ca.pem")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	if err := os.WriteFile(ca, pemBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SSL_CERT_FILE", ca) // read once, on first TLS verify; only this test uses TLS

	c, err := New(Config{Endpoint: srv.URL, APIKey: "key", Conns: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Send(context.Background(), []byte("tls")); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.txs["tls"] != 1 {
		t.Fatalf("tx not delivered over TLS")
	}
}

func TestReadResponse(t *testing.T) {
	for _, tc := range []struct {
		in     string
		status int
		body   string
		reuse  bool
		err    error
	}{
		{in: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nREST", status: 200, reuse: true},
		{in: "HTTP/1.1 204 No Content\r\n\r\nREST", status: 204, reuse: true},
		{in: "HTTP/1.1 400 Bad Request\r\ncontent-length: 17\r\nConnection: close\r\n\r\nInsufficient tip\n", status: 400, body: "Insufficient tip\n"},
		{in: "HTTP/1.1 429 Too Many Requests\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nToo \r\n5;x=1\r\nMany\n\r\n0\r\nX-T: a\r\n\r\nREST", status: 429, body: "Too Many\n", reuse: true},
		{in: "HTTP/1.0 200 OK\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\npong\nREST", status: 200, body: "pong\n", reuse: true},
		{in: "HTTP/1.0 200 OK\r\n\r\npong\n", status: 200, body: "pong\n"},
		{in: "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n", err: errTooBig},
		{in: "HTTP/1.1 103 Early Hints\r\nLink: </a>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nREST", status: 200, reuse: true},
		{in: "HTTP/1.1 100 Continue\r\n\r\n", err: io.EOF},
		{in: "HTTP/1.1 2000 OK\r\nContent-Length: 0\r\n\r\n", err: errProto},
		{in: "HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\nContent-Length: 2\r\n\r\nokREST", status: 200, body: "ok", reuse: true},
		{in: "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok", err: errProto},
		{in: "HTTP/1.1 200 OK\r\nX-Long: " + strings.Repeat("a", 8000) + "\r\nContent-Length: 0\r\n\r\nREST", status: 200, reuse: true},
		{in: "HTTP/1.0 200 OK\r\n\r\n" + strings.Repeat("x", 4096), status: 200, body: strings.Repeat("x", 4096)},
		{in: "SSH-2.0-OpenSSH_9.6\r\n", err: errProto},
		{in: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab", err: io.ErrUnexpectedEOF},
	} {
		r := bufio.NewReaderSize(strings.NewReader(tc.in), readerSize)
		status, body, reuse, err := readResponse(r, make([]byte, maxBody))
		if !errors.Is(err, tc.err) || status != tc.status || string(body) != tc.body || reuse != tc.reuse {
			t.Errorf("%q: got (%d, %q, %v, %v)", tc.in, status, body, reuse, err)
		}
		if rest, _ := io.ReadAll(r); tc.reuse && string(rest) != "REST" {
			t.Errorf("%q: left %q unread, want REST", tc.in, rest)
		}
	}
}

var raceEnabled bool // set by race_test.go

func TestSendDoesNotAllocate(t *testing.T) {
	if raceEnabled {
		t.Skip("sync.Pool drops items under the race detector")
	}
	url, _ := benchRouter(t, 0)
	c, err := New(Config{Endpoint: url, APIKey: "key", Conns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	tx, ctx := make([]byte, 1232), context.Background()
	// Counts every goroutine's allocations: caller, worker and server.
	if n := testing.AllocsPerRun(1000, func() {
		if err := c.Send(ctx, tx); err != nil {
			t.Fatal(err)
		}
	}); n != 0 {
		t.Fatalf("Send allocates %v times per call", n)
	}
}

func TestDiscoverRanksByPing(t *testing.T) {
	pong := func(delay time.Duration) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(delay)
			io.WriteString(w, "pong\n")
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	slow, fast := pong(20*time.Millisecond), pong(0)
	eps, err := probeAll(context.Background(), []Endpoint{
		{URL: slow.URL, Region: "slow"},
		{URL: "http://127.0.0.1:1", Region: "dead"},
		{URL: fast.URL, Region: "fast"},
	})
	if err != nil || len(eps) != 2 || eps[0].Region != "fast" || eps[1].Region != "slow" || eps[1].RTT < 20*time.Millisecond {
		t.Fatalf("got %+v, %v", eps, err)
	}
	if _, err := probeAll(context.Background(), []Endpoint{{URL: "http://127.0.0.1:1"}}); err == nil {
		t.Fatal("no reachable endpoint must be an error")
	}
}

func TestManifest(t *testing.T) {
	f, err := os.Open("../endpoints.json")
	if os.IsNotExist(err) {
		t.Skip("needs the repo checkout, not just the module")
	}
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if got := parseManifest(f); !slices.Equal(got, builtinEndpoints) {
		t.Fatalf("builtinEndpoints differs from ../endpoints.json:\n%v", got)
	}

	if eps := plainHTTP(slices.Clone(builtinEndpoints)); eps[2].URL != "http://pit1.nozomi.temporal.xyz" || eps[0].URL != builtinEndpoints[0].URL || eps[11].URL != builtinEndpoints[11].URL {
		t.Fatalf("direct endpoints must be plain http, others https: %v", eps[:12])
	}

	if _, err := New(Config{Endpoint: "http://127.0.0.1:1", APIKey: "key", TLS: true}); err == nil || strings.Contains(err.Error(), "dial") {
		t.Fatalf("TLS with an http endpoint: got %v, want a validation error", err)
	}

	got := parseManifest(strings.NewReader(`{"endpoints":[
		{"url":"https://evil.example.com","region":"a"},
		{"url":"http://ams1.nozomi.temporal.xyz","region":"b"},
		{"url":"https://nozomi.temporal.xyz.evil.com","region":"c"},
		{"url":"https://u@ams1.nozomi.temporal.xyz","region":"d"},
		{"url":"https://ams9.nozomi.temporal.xyz","region":"ok"}]}`))
	if len(got) != 1 || got[0].Region != "ok" {
		t.Fatalf("untrusted endpoints kept: %v", got)
	}
}

// Probes the real endpoints: NOZOMI_LIVE=1 go test -run Live -v
func TestLiveDiscover(t *testing.T) {
	if os.Getenv("NOZOMI_LIVE") == "" {
		t.Skip("set NOZOMI_LIVE=1 to probe the real endpoints")
	}
	eps, err := Discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range eps {
		t.Logf("%-12s %-36s %v", e.Region, e.URL, e.RTT)
	}
}

// A caller that gives up (cancelled ctx) may reuse its buffers at once, even
// though the worker still holds the job. Run under -race.
func TestCallerBufferNotRetained(t *testing.T) {
	f, srv := start(t, false)
	f.delay = 30 * time.Millisecond
	c, err := New(Config{Endpoint: srv.URL, APIKey: "key", Conns: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	var wg sync.WaitGroup
	send := func(ctx context.Context, tx string) {
		wg.Add(1)
		go func() { defer wg.Done(); c.Send(ctx, []byte(tx)) }()
		time.Sleep(2 * time.Millisecond)
	}
	send(context.Background(), "warm") // occupies the one connection; the next three queue up
	send(context.Background(), "tx0")
	send(context.Background(), "Xbad") // 400 for the merged request, so each job is resent alone
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
	defer cancel()
	victim := []byte("victim")
	err = c.Send(ctx, victim) // expires while tx0 and Xbad are being resent
	copy(victim, "vXXXXX")
	wg.Wait()
	time.Sleep(100 * time.Millisecond) // let the worker finish its resend loop

	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("victim: got %v, want DeadlineExceeded", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.txs["vXXXXX"] != 0 {
		t.Fatal("router received the caller's reused buffer")
	}
	if f.txs["victim"] != 0 {
		t.Fatal("cancelled tx was sent anyway")
	}
	if f.txs["tx0"] == 0 || f.txs["warm"] == 0 {
		t.Fatalf("delivered: %v", f.txs)
	}
}

func TestAPIKey(t *testing.T) {
	for _, bad := range []string{"", "a b", "a&b", "a#b", "a\nb", "ü"} {
		if _, err := New(Config{Endpoint: "http://127.0.0.1:1", APIKey: bad}); err == nil || strings.Contains(err.Error(), "dial") {
			t.Errorf("APIKey %q: got %v, want a validation error", bad, err)
		}
	}
	var mu sync.Mutex
	var query string
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		mu.Lock()
		query = r.URL.RawQuery
		mu.Unlock()
	}))
	defer srv.Close()
	c, err := New(Config{Endpoint: srv.URL, APIKey: "k+y%2F=1"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Send(context.Background(), []byte("a")); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if query != "c=k+y%2F=1" {
		t.Fatalf("key not sent verbatim: query %q", query)
	}
}

func TestUserAgent(t *testing.T) {
	f, srv := start(t, false)
	c, err := New(Config{Endpoint: srv.URL, APIKey: "key", Conns: 1, PingInterval: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Send(context.Background(), []byte("a")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond) // a ping too
	f.mu.Lock()
	defer f.mu.Unlock()
	want := "nozomi-sdk-go/" + Version
	if len(f.ua) != 1 || f.ua[want] < 2 {
		t.Fatalf("user agents seen: %v, want only %q on sends and pings", f.ua, want)
	}
}
