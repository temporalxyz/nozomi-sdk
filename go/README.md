# nozomi-sdk for Go

Standard library only. Implements [SPEC.md](../SPEC.md).

```sh
go get github.com/temporalxyz/nozomi-sdk/go
```

```go
import nozomi "github.com/temporalxyz/nozomi-sdk/go"

c, err := nozomi.New(nozomi.Config{
	APIKey: apiKey,
	Name:   "arb bot 7", // shows in Nozomi's logs as the User-Agent
}) // connects to the fastest endpoint
if err != nil {
	return err
}
defer c.Close()
log.Println("sending via", c.Endpoint())

raw, _ := tx.MarshalBinary() // any signed, serialized transaction
err = c.Send(ctx, raw)       // or c.SendBatch(ctx, [][]byte{a, b, c})

var he *nozomi.HTTPError
if errors.As(err, &he) && he.StatusCode == 429 {
	// rate limited
}
```

Call `Send` from as many goroutines as you like. A send allocates nothing once
the client is warm.

With no `Endpoint`, `New` runs `nozomi.Discover`:
- It reads the published endpoint list, falling back to a built-in copy.
- It keeps only hosts under `nozomi.temporal.xyz`.
- It times 5 `/ping` round trips on a fresh connection to each endpoint, in
  parallel, and connects to the fastest.

To pin a region instead, set `Endpoint`, or call `Discover` yourself:

```go
eps, err := nozomi.Discover(ctx) // reachable endpoints, fastest first
for _, e := range eps {
	fmt.Println(e.Region, e.URL, e.RTT)
}
```

To see the ranking from your machine, run
`NOZOMI_LIVE=1 go test -run Live -v`.

## Benchmark

```sh
go test -run '^$' -bench . -benchmem
```

Setup is per [SPEC.md §5](../SPEC.md#5-benchmark): AMD EPYC 9275F (48 threads),
loopback, 1232-byte txs, 4 connections. The baseline is `net/http` sending one
tx per request.

| Scenario | Client | tx/s | p50 | p99 | tx per request | allocs/send |
|---|---|---|---|---|---|---|
| 1 ms RTT, 192 senders | **SDK** | **46.6k** | **4.1 ms** | **4.3 ms** | 15.9 | **0** |
| | net/http | 3.56k | 53.9 ms | 55.1 ms | 1 | 50 |
| 0 RTT, 192 senders | **SDK** | 240k | 690 µs | 2.4 ms | 15.9 | **0** |
| | net/http | 121k | 1.42 ms | 2.4 ms | 1 | 50 |
| 1 ms RTT, one sender | **SDK** | 940 | 1064 µs | 1070 µs | 1 | **0** |
| | net/http | 933 | 1069 µs | 1108 µs | 1 | 52 |
| 0 RTT, one sender, GOMAXPROCS=8 | **SDK** | 110k | 8.9 µs | 10.8 µs | 1 | **0** |
| | net/http | 71k | 13.4 µs | 25.2 µs | 1 | 52 |

At GOMAXPROCS=48, a lone sender over loopback sometimes runs at about 21 µs
instead of 9 µs, because of the goroutine handoff between caller and
connection. Any real network round trip is much larger than this.
