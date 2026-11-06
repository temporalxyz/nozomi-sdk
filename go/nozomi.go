// Package nozomi sends signed Solana transactions to Nozomi, implementing the
// nozomi-sdk SPEC.md.
//
// A Client keeps Conns persistent HTTP/1.1 connections open, pinging idle ones
// so they stay open, and redialing any that drop. Every send goes
// through POST /api/sendBatch: transactions queued while all connections are
// busy are coalesced into one request of up to MaxBatchTxs, so batching adds
// no latency when idle and saves round trips under load. In steady state a
// send allocates nothing.
package nozomi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// Version is reported in the User-Agent of every request.
const Version = "0.1.0"

const userAgent = "nozomi-sdk-go/" + Version

const (
	MaxBatchTxs = 16   // router limit per sendBatch request
	MaxTxSize   = 4096 // protocol maximum per transaction
	maxBody     = 4096 // router bodies are a short status line; anything bigger is not the router
	readerSize  = 16 << 10
	maxConns    = 64
)

var (
	ErrClosed = errors.New("nozomi: client closed")
	errProto  = errors.New("nozomi: malformed HTTP response")
	errTooBig = errors.New("nozomi: HTTP response body over 4096 bytes")
)

type Config struct {
	// Endpoint is the router base URL, http:// or https://. Empty: New uses
	// the fastest endpoint Discover finds.
	Endpoint string
	APIKey   string
	// TLS makes discovery keep every endpoint on https (see Discover). With
	// an explicit Endpoint it only checks that the URL is https.
	TLS bool
	// Conns is the number of persistent connections. Default 4.
	Conns int
	// PingInterval is how long a connection may sit idle before a GET /ping
	// keeps it open. Default 10s.
	PingInterval time.Duration
	// Timeout bounds each dial and each request/response round trip. Default 5s.
	Timeout time.Duration
}

// HTTPError is a non-200 response from the router.
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("nozomi: HTTP %d: %s", e.StatusCode, e.Body)
}

type Client struct {
	cfg       Config
	t         target
	batchHead string
	pingReq   []byte
	queue     chan *job
	closed    chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

// job is up to MaxBatchTxs txs from one call, already framed for the body.
// It owns its bytes, so a caller that returns early (cancelled) may reuse its
// buffers while the worker still holds the job. Jobs are pooled; one goes
// back to the pool only after its caller has read done, so a worker never
// touches a recycled job.
type job struct {
	ctx  context.Context
	n    int    // transactions
	buf  []byte // length-prefixed entries
	done chan error
}

var jobPool = sync.Pool{New: func() any { return &job{done: make(chan error, 1)} }}

func (j *job) release() {
	j.ctx, j.buf = nil, j.buf[:0]
	jobPool.Put(j)
}

// New dials all connections before returning, so the first send is warm. It
// fails only if every dial fails; the rest are retried in the background.
// With no Config.Endpoint it first runs Discover, bounded by Config.Timeout.
func New(cfg Config) (*Client, error) {
	if cfg.APIKey == "" {
		return nil, errors.New("nozomi: APIKey is required")
	}
	// The key goes in the request line verbatim: the router compares it
	// byte for byte and does not percent-decode.
	for i := 0; i < len(cfg.APIKey); i++ {
		if c := cfg.APIKey[i]; c <= ' ' || c >= 0x7f || c == '&' || c == '#' {
			return nil, errors.New("nozomi: APIKey has a character that cannot go in a URL query")
		}
	}
	if cfg.Conns <= 0 {
		cfg.Conns = 4
	}
	if cfg.Conns > maxConns {
		return nil, fmt.Errorf("nozomi: Conns %d over the limit of %d", cfg.Conns, maxConns)
	}
	if cfg.PingInterval <= 0 {
		cfg.PingInterval = 10 * time.Second
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}

	var opts []Option
	if cfg.TLS {
		opts = append(opts, TLS)
	}
	if cfg.Endpoint == "" {
		ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
		eps, err := Discover(ctx, opts...)
		cancel()
		if err != nil {
			return nil, err
		}
		cfg.Endpoint = eps[0].URL
	}
	t, err := parseEndpoint(cfg.Endpoint, cfg.Conns)
	if err != nil {
		return nil, err
	}
	if cfg.TLS && t.tls == nil {
		return nil, fmt.Errorf("nozomi: TLS set but Endpoint %q is not https", cfg.Endpoint)
	}

	c := &Client{
		cfg:    cfg,
		t:      t,
		queue:  make(chan *job),
		closed: make(chan struct{}),
	}
	c.batchHead = "POST /api/sendBatch?c=" + cfg.APIKey + " HTTP/1.1\r\nHost: " + t.host +
		"\r\nUser-Agent: " + userAgent + "\r\nContent-Type: application/octet-stream\r\nContent-Length: "
	c.pingReq = t.pingReq()

	conns := make([]net.Conn, cfg.Conns)
	errs := make([]error, cfg.Conns)
	var wg sync.WaitGroup
	for i := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conns[i], errs[i] = c.dial()
		}()
	}
	wg.Wait()
	up := false
	for _, cn := range conns {
		up = up || cn != nil
	}
	if !up {
		return nil, fmt.Errorf("nozomi: dial %s: %w", t.addr, errs[0])
	}
	for _, cn := range conns {
		w := &worker{c: c, cn: cn, r: bufio.NewReaderSize(cn, readerSize)}
		c.wg.Add(1)
		go w.run()
	}
	return c, nil
}

// Send submits one signed, serialized transaction and returns once the router
// has accepted or rejected it.
func (c *Client) Send(ctx context.Context, tx []byte) error {
	return c.SendBatch(ctx, [][]byte{tx})
}

// SendBatch submits txs. Each run of MaxBatchTxs goes out in order in one
// request; runs may go out in parallel on different connections. As with the
// router's sendBatch, a rejected tx stops the rest of its run. txs is not
// retained after SendBatch returns.
func (c *Client) SendBatch(ctx context.Context, txs [][]byte) error {
	if len(txs) == 0 {
		return errors.New("nozomi: no transactions")
	}
	for _, tx := range txs {
		if len(tx) == 0 || len(tx) > MaxTxSize {
			return fmt.Errorf("nozomi: transaction size %d outside 1..%d", len(tx), MaxTxSize)
		}
	}
	var stack [4]*job
	jobs := stack[:0]
	for len(txs) > 0 {
		j := jobPool.Get().(*job)
		j.ctx = ctx
		j.n = min(len(txs), MaxBatchTxs)
		for _, tx := range txs[:j.n] {
			j.buf = binary.BigEndian.AppendUint16(j.buf, uint16(len(tx)))
			j.buf = append(j.buf, tx...)
		}
		txs = txs[j.n:]
		select {
		case c.queue <- j:
		case <-ctx.Done():
			j.release()
			return ctx.Err()
		case <-c.closed:
			j.release()
			return ErrClosed
		}
		jobs = append(jobs, j)
	}
	var err error
	for _, j := range jobs {
		// Returning early leaves unanswered jobs to the GC, not the pool:
		// their worker may still write to them.
		select {
		case e := <-j.done:
			j.release()
			if e != nil && err == nil {
				err = e
			} else if e != nil {
				err = errors.Join(err, e)
			}
		case <-ctx.Done():
			return ctx.Err()
		case <-c.closed:
			return ErrClosed
		}
	}
	return err
}

// Close stops all connections. Sends in progress return ErrClosed.
func (c *Client) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	c.wg.Wait()
	return nil
}

func (c *Client) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

// Endpoint returns the URL the client sends to.
func (c *Client) Endpoint() string { return c.cfg.Endpoint }

func (c *Client) dial() (net.Conn, error) {
	return c.t.dial(context.Background(), c.cfg.Timeout)
}

// target is where an endpoint URL connects.
type target struct {
	addr string      // host:port to dial
	host string      // Host header
	tls  *tls.Config // nil for http://
}

func parseEndpoint(endpoint string, conns int) (target, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return target{}, fmt.Errorf("nozomi: endpoint: %w", err)
	}
	t := target{host: u.Host}
	port := u.Port()
	switch u.Scheme {
	case "http":
		if port == "" {
			port = "80"
		}
	case "https":
		if port == "" {
			port = "443"
		}
		t.tls = &tls.Config{
			ServerName:         u.Hostname(),
			NextProtos:         []string{"http/1.1"},
			ClientSessionCache: tls.NewLRUClientSessionCache(conns),
		}
	default:
		return target{}, fmt.Errorf("nozomi: endpoint scheme must be http or https, got %q", u.Scheme)
	}
	t.addr = net.JoinHostPort(u.Hostname(), port)
	return t, nil
}

func (t *target) dial(ctx context.Context, timeout time.Duration) (net.Conn, error) {
	d := &net.Dialer{Timeout: timeout, KeepAlive: 15 * time.Second}
	if t.tls != nil {
		return (&tls.Dialer{NetDialer: d, Config: t.tls}).DialContext(ctx, "tcp", t.addr)
	}
	return d.DialContext(ctx, "tcp", t.addr) // Go sets TCP_NODELAY by default
}

func (t *target) pingReq() []byte {
	return []byte("GET /ping HTTP/1.1\r\nHost: " + t.host + "\r\nUser-Agent: " + userAgent + "\r\n\r\n")
}

// worker owns one connection and serves the queue with it. Its buffers are
// reused across requests and reconnects.
type worker struct {
	c    *Client
	cn   net.Conn // nil while disconnected
	r    *bufio.Reader
	req  []byte
	body [maxBody]byte
}

func (w *worker) run() {
	c := w.c
	defer c.wg.Done()
	defer func() {
		if w.cn != nil {
			w.cn.Close()
		}
	}()
	idle := time.NewTimer(c.cfg.PingInterval)
	defer idle.Stop()
	backoff := 50 * time.Millisecond
	var batch []*job
	var carry *job

	for {
		// Stay connected, but take no jobs while down so healthy workers get them.
		if w.cn == nil {
			if carry != nil { // hand it to an idle worker rather than hold it while down
				select {
				case c.queue <- carry:
					carry = nil
				default:
				}
			}
			if err := w.connect(); err != nil {
				select {
				case <-c.closed:
					return
				case <-time.After(backoff):
				}
				backoff = min(backoff*2, 5*time.Second)
				continue
			}
			backoff = 50 * time.Millisecond
		}

		j := carry
		carry = nil
		if j == nil {
			idle.Reset(c.cfg.PingInterval)
			select {
			case <-c.closed:
				return
			case <-idle.C:
				w.do(c.pingReq)
				continue
			case j = <-c.queue:
			}
		}

		// Coalesce senders already waiting; never wait for more.
		batch = append(batch[:0], j)
		n := j.n
	gather:
		for n < MaxBatchTxs {
			select {
			case j := <-c.queue:
				if n+j.n > MaxBatchTxs {
					carry = j
					break gather
				}
				batch = append(batch, j)
				n += j.n
			default:
				break gather
			}
		}
		w.flush(batch)
	}
}

// flush sends jobs and answers each one. A job must not be touched after its
// done is written.
func (w *worker) flush(jobs []*job) {
	live := jobs[:0]
	for _, j := range jobs {
		if err := j.ctx.Err(); err != nil {
			j.done <- err // caller gave up; don't send behind its back
		} else {
			live = append(live, j)
		}
	}
	if len(live) == 0 {
		return
	}
	err := w.send(live)
	// send returns a bare *HTTPError; errors.As would heap-allocate its target.
	if he, ok := err.(*HTTPError); ok && len(live) > 1 && perTxStatus(he.StatusCode) {
		// The router stops at the first rejected tx, so one bad tx would fail
		// every job merged with it. Resend each job alone for accurate results.
		// Jobs ahead of the bad tx go out twice; validators dedupe by signature.
		for _, j := range live {
			switch {
			case j.ctx.Err() != nil:
				j.done <- j.ctx.Err()
			case w.c.isClosed():
				j.done <- ErrClosed
			default:
				j.done <- w.send([]*job{j})
			}
		}
		return
	}
	for _, j := range live {
		j.done <- err
	}
}

// perTxStatus reports whether status rejects a single tx rather than the
// whole request (auth and rate limits apply to the whole request).
func perTxStatus(status int) bool {
	return status == 400 || status == 403 || status == 409
}

func (w *worker) send(jobs []*job) error {
	size := 0
	for _, j := range jobs {
		size += len(j.buf)
	}
	b := append(w.req[:0], w.c.batchHead...)
	b = strconv.AppendInt(b, int64(size), 10)
	b = append(b, "\r\n\r\n"...)
	for _, j := range jobs {
		b = append(b, j.buf...)
	}
	w.req = b
	status, body, err := w.do(b)
	if err != nil {
		return err
	}
	if status != 200 {
		return &HTTPError{StatusCode: status, Body: string(bytes.TrimSpace(body))}
	}
	return nil
}

func (w *worker) connect() error {
	cn, err := w.c.dial()
	if err != nil {
		return err
	}
	w.cn = cn
	w.r.Reset(cn)
	return nil
}

// do runs one request, dialing if needed. On an I/O error it retries once on a
// fresh connection: the router may have closed the old one as we wrote. body
// is valid until the next call.
func (w *worker) do(req []byte) (status int, body []byte, err error) {
	for attempt := 0; ; attempt++ {
		if w.cn == nil {
			if err = w.connect(); err != nil {
				return 0, nil, err
			}
		}
		reuse := false
		w.cn.SetDeadline(time.Now().Add(w.c.cfg.Timeout))
		if _, err = w.cn.Write(req); err == nil {
			status, body, reuse, err = readResponse(w.r, w.body[:])
		}
		if err != nil || !reuse {
			w.cn.Close()
			w.cn = nil
		}
		if err == nil || attempt == 1 {
			return status, body, err
		}
	}
}

// readResponse reads one HTTP/1.x response into buf without allocating. reuse
// reports whether the connection can carry another request.
func readResponse(r *bufio.Reader, buf []byte) (status int, body []byte, reuse bool, err error) {
	var length int
	var chunked bool
	for status < 200 { // skip 1xx (a proxy may send 103 Early Hints)
		if status, reuse, length, chunked, err = readHead(r); err != nil {
			return 0, nil, false, err
		}
	}

	switch {
	case status == 204 || status == 304:
		return status, nil, reuse, nil
	case chunked:
		body, err = readChunked(r, buf)
	case length > len(buf):
		return 0, nil, false, errTooBig
	case length >= 0:
		body = buf[:length]
		_, err = io.ReadFull(r, body)
	default: // body runs to EOF
		n, err := io.ReadFull(r, buf)
		if err == nil { // buf full: fine only if EOF is next
			if _, err = r.ReadByte(); err == nil {
				return 0, nil, false, errTooBig
			}
		} else if err != io.EOF && err != io.ErrUnexpectedEOF {
			return 0, nil, false, err
		}
		return status, buf[:n], false, nil
	}
	if err != nil {
		return 0, nil, false, err
	}
	return status, body, reuse, nil
}

// readHead reads a status line and headers. length is -1 without Content-Length.
func readHead(r *bufio.Reader) (status int, reuse bool, length int, chunked bool, err error) {
	line, err := r.ReadSlice('\n')
	if err != nil {
		return 0, false, 0, false, err
	}
	// "HTTP/1.1 200 OK"
	if len(line) < 13 || string(line[:7]) != "HTTP/1." || line[8] != ' ' ||
		(line[12] != ' ' && line[12] != '\r' && line[12] != '\n') {
		return 0, false, 0, false, errProto
	}
	status, ok := parseNum(line[9:12], 10)
	if !ok {
		return 0, false, 0, false, errProto
	}
	reuse = line[7] == '1'
	length = -1
	for {
		if line, err = r.ReadSlice('\n'); err != nil {
			return 0, false, 0, false, err
		}
		line = bytes.TrimRight(line, "\r\n")
		if len(line) == 0 {
			return status, reuse, length, chunked, nil
		}
		k, v, ok := bytes.Cut(line, []byte(":"))
		if !ok {
			return 0, false, 0, false, errProto
		}
		v = bytes.TrimSpace(v)
		switch {
		case bytes.EqualFold(k, []byte("Content-Length")):
			n, ok := parseNum(v, 10)
			if !ok || (length >= 0 && n != length) {
				return 0, false, 0, false, errProto
			}
			length = n
		case bytes.EqualFold(k, []byte("Transfer-Encoding")):
			chunked = hasToken(v, "chunked")
		case bytes.EqualFold(k, []byte("Connection")):
			if hasToken(v, "close") {
				reuse = false
			} else if hasToken(v, "keep-alive") {
				reuse = true
			}
		}
	}
}

func readChunked(r *bufio.Reader, buf []byte) ([]byte, error) {
	n := 0
	for {
		line, err := r.ReadSlice('\n')
		if err != nil {
			return nil, err
		}
		line, _, _ = bytes.Cut(bytes.TrimRight(line, "\r\n"), []byte(";")) // drop chunk extensions
		size, ok := parseNum(bytes.TrimSpace(line), 16)
		if !ok {
			return nil, errProto
		}
		if size == 0 {
			break
		}
		if n+size > len(buf) {
			return nil, errTooBig
		}
		if _, err := io.ReadFull(r, buf[n:n+size]); err != nil {
			return nil, err
		}
		n += size
		if line, err = r.ReadSlice('\n'); err != nil {
			return nil, err
		}
		if len(bytes.TrimRight(line, "\r\n")) != 0 {
			return nil, errProto
		}
	}
	for { // trailers
		line, err := r.ReadSlice('\n')
		if err != nil {
			return nil, err
		}
		if len(bytes.TrimRight(line, "\r\n")) == 0 {
			return buf[:n], nil
		}
	}
}

// parseNum parses 1 to 8 digits in base 10 or 16.
func parseNum(b []byte, base int) (int, bool) {
	if len(b) == 0 || len(b) > 8 {
		return 0, false
	}
	n := 0
	for _, c := range b {
		var d int
		switch lc := c | 0x20; {
		case '0' <= c && c <= '9':
			d = int(c - '0')
		case base == 16 && 'a' <= lc && lc <= 'f':
			d = int(lc-'a') + 10
		default:
			return 0, false
		}
		n = n*base + d
	}
	return n, true
}

func hasToken(v []byte, tok string) bool {
	for len(v) > 0 {
		var t []byte
		t, v, _ = bytes.Cut(v, []byte(","))
		if bytes.EqualFold(bytes.TrimSpace(t), []byte(tok)) {
			return true
		}
	}
	return false
}
