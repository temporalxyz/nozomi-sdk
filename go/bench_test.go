package nozomi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

const benchConns = 4

// BenchmarkSend compares the SDK with plain net/http (one tx per sendBatch
// request, same connection budget) against a local router stand-in that
// answers each request after rtt.
func BenchmarkSend(b *testing.B) {
	tx := make([]byte, 1232) // max legacy tx size
	impls := []struct {
		name string
		mk   func(*testing.B, string) func(context.Context, []byte) error
	}{{"sdk", sdkSender}, {"nethttp", netHTTPSender}}

	for _, rtt := range []time.Duration{0, time.Millisecond} {
		for _, mode := range []string{"serial", "parallel"} {
			for _, impl := range impls {
				b.Run(fmt.Sprintf("rtt=%v/%s/%s", rtt, mode, impl.name), func(b *testing.B) {
					url, reqs := benchRouter(b, rtt)
					send := impl.mk(b, url)
					ctx := context.Background()
					lat := make([]int64, b.N)
					var idx atomic.Int64
					op := func() {
						t0 := time.Now()
						if err := send(ctx, tx); err != nil {
							b.Error(err)
						}
						lat[idx.Add(1)-1] = int64(time.Since(t0))
					}
					reqs.Store(0)
					b.ResetTimer()
					if mode == "serial" {
						for range b.N {
							op()
						}
					} else {
						b.SetParallelism(4) // 4 senders per CPU
						b.RunParallel(func(pb *testing.PB) {
							for pb.Next() {
								op()
							}
						})
					}
					b.StopTimer()
					slices.Sort(lat)
					b.ReportMetric(float64(b.N)/b.Elapsed().Seconds(), "tx/s")
					b.ReportMetric(float64(b.N)/float64(reqs.Load()), "tx/req")
					b.ReportMetric(float64(lat[len(lat)/2])/1e3, "p50-µs")
					b.ReportMetric(float64(lat[len(lat)*99/100])/1e3, "p99-µs")
				})
			}
		}
	}
}

func sdkSender(b *testing.B, url string) func(context.Context, []byte) error {
	c, err := New(Config{Endpoint: url, APIKey: "key", Conns: benchConns})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { c.Close() })
	return c.Send
}

func netHTTPSender(b *testing.B, url string) func(context.Context, []byte) error {
	cl := &http.Client{Transport: &http.Transport{MaxConnsPerHost: benchConns, MaxIdleConnsPerHost: benchConns}}
	b.Cleanup(cl.CloseIdleConnections)
	target := url + "/api/sendBatch?c=key"
	return func(ctx context.Context, tx []byte) error {
		body := binary.BigEndian.AppendUint16(make([]byte, 0, 2+len(tx)), uint16(len(tx)))
		req, _ := http.NewRequestWithContext(ctx, "POST", target, bytes.NewReader(append(body, tx...)))
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := cl.Do(req)
		if err != nil {
			return err
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		return nil
	}
}

var okResp = []byte("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")

// benchRouter is a bare, allocation-free HTTP/1.1 server that answers every
// request with an empty 200 after rtt, so client cost dominates.
func benchRouter(tb testing.TB, rtt time.Duration) (string, *atomic.Int64) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { ln.Close() })
	reqs := new(atomic.Int64)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				r := bufio.NewReader(c)
				for {
					n := 0
					for {
						line, err := r.ReadSlice('\n')
						if err != nil {
							return
						}
						if len(line) <= 2 {
							break
						}
						if v, ok := bytes.CutPrefix(line, []byte("Content-Length: ")); ok {
							n, _ = parseNum(bytes.TrimSpace(v), 10)
						}
					}
					if _, err := r.Discard(n); err != nil {
						return
					}
					reqs.Add(1)
					if rtt > 0 {
						time.Sleep(rtt)
					}
					if _, err := c.Write(okResp); err != nil {
						return
					}
				}
			}()
		}
	}()
	return "http://" + ln.Addr().String(), reqs
}
