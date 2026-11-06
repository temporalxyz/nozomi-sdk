# Nozomi SDK specification

Every language SDK in this repo implements this document. To change behavior,
change this spec first, then every SDK. MUST/SHOULD are as in RFC 2119.

## 1. Router API

### Endpoints

| Method | Path | Auth | Use |
|---|---|---|---|
| `POST` | `/api/sendBatch?c=<api key>` | API key | every send |
| `GET` | `/ping` | none | keep-alive; `200` with body `pong\n` |

`User-Agent` identifies the SDK and its version in Nozomi's logs. `<lang>` is
the directory name (`go`, `ts`, ...). Send the same header on `GET /ping`.

The API key is the query parameter `c`, sent verbatim: the router compares
it byte for byte and does not percent-decode. `new` rejects a key with a
character outside printable ASCII, or a space, `&` or `#`.

### sendBatch request

```
POST /api/sendBatch?c=<api key> HTTP/1.1\r\n
Host: <host[:port] exactly as in the endpoint URL>\r\n
User-Agent: nozomi-sdk-<lang>/<version>\r\n
Content-Type: application/octet-stream\r\n
Content-Length: <body length>\r\n
\r\n
<body>
```

The body is 1 to 16 entries and nothing else. Each entry is the transaction's
length as a big-endian u16 (1 to 4096), then the signed transaction in Solana
wire format (raw bytes, not base64).

Example: transactions `61 62 63` and `ff` give the 8-byte body
`00 03 61 62 63 00 01 ff`.

### Responses

`200` with an empty body: every transaction was accepted for forwarding.
Anything else has a short `text/plain` body:

| Status | Meaning | Applies to |
|---|---|---|
| 400 | bad framing, unparsable or oversized tx, `Insufficient tip`, ... | one tx |
| 403 | tx not allowed for this key | one tx |
| 409 | tx already confirmed | one tx |
| 401 | missing or unknown API key | the request |
| 429 | rate limited | the request, or one tx after the first |
| 5xx | router error | one tx |

The router processes entries in order and stops at the first rejected one,
whatever the status: entries before it were accepted, entries after it were
not, and the response does not say which entry failed.

### Connections

- HTTP/1.1 with keep-alive. A response may carry `Connection: close`.
- Idle connections are closed, so ping them (§3).
- `new` rejects `Conns` over 64.
- Endpoints behind a proxy (Cloudflare) may answer with
  `Transfer-Encoding: chunked`, or with a `1xx` before the final response.

### Endpoint list

[`endpoints.json`](endpoints.json) at the repo root is the published endpoint
list. Clients read it from
`https://raw.githubusercontent.com/temporalxyz/nozomi-sdk/main/endpoints.json`,
so it never moves.

```json
{ "version": 1, "updated": "YYYY-MM-DD",
  "endpoints": [ { "url": "https://ams1.nozomi.temporal.xyz", "region": "amsterdam", "type": "direct" } ] }
```

`type` is `direct` (a router), `cloudflare` (a router behind Cloudflare) or
`auto` (geo-routed). Each SDK carries a built-in copy as its fallback.

## 2. Public API

Names follow the language's conventions (`send_batch`, `sendBatch`, ...);
behavior does not change.

| Item | Contract |
|---|---|
| `MaxBatchTxs = 16`, `MaxTxSize = 4096` | exported constants |
| `Config` | `Endpoint` (`http://` or `https://`; empty means discover), `APIKey` (required), `Conns` = 4 (at most 64), `PingInterval` = 10 s, `Timeout` = 5 s |
| `new(config)` | with no `Endpoint`, runs `discover` within `Timeout` and uses the fastest result; then opens all `Conns` connections before returning; fails only if every one fails |
| `discover()` | the reachable endpoints as `{url, region, rtt}`, fastest first; an error if none is reachable |
| `client.endpoint()` | the URL the client sends to |
| `send(tx)` | one signed tx; returns when the router has answered for it |
| `send_batch(txs)` | any number of txs, sent in runs of 16; each run goes out in order in one request; runs may go out in parallel |
| `close()` | closes every connection; calls in progress fail with `Closed` |

- `send` and `send_batch` are safe to call concurrently and take the
  language's native cancellation (Go `context`, JS `AbortSignal`, Python task
  cancellation, ...). They copy the transactions before returning, including
  when they return early on cancellation, so the caller may reuse its buffers
  at once.
- Errors:
  - `HTTPError{status, body}`: any non-200; `body` has surrounding whitespace trimmed.
  - `Closed`.
  - The native cancellation error.
  - A validation error, raised before anything is sent, for an empty batch or a
    tx size outside 1..4096. `new` raises one for a bad API key or `Conns`.

  A batch with several failed runs returns them combined.

## 3. Client behavior

### Connections

- Keep `Conns` connections, with one request in flight per connection: no
  pipelining and no HTTP/2.
- TLS: SNI is the endpoint host, ALPN offers only `http/1.1`, and session
  resumption is enabled. TCP_NODELAY is on, with TCP keepalive at 15 s.
- A connection idle for `PingInterval` sends `GET /ping`. Ignore its status;
  if it fails, reconnect.
- A dropped connection is redialed with backoff: 50 ms, doubling, capped at
  5 s, reset on success. While down it takes no sends, so healthy connections
  get them.
- After `Connection: close`, or HTTP/1.0 without keep-alive, close the
  connection once the response has been read.
- On an I/O error, protocol error or timeout: close the connection, redial
  immediately and resend once. If that also fails, return the error. Never
  resend a request that got an HTTP status. The router may have processed the
  first copy: a `409` on the resend means it was confirmed.
- `Timeout` bounds each dial and each write-plus-response.
- Skip `1xx` responses. Accept header lines up to 16 KiB. A response body
  over 4096 bytes, a status line that isn't three digits, or two differing
  `Content-Length` headers is a protocol error.

### Discovery

- Fetch the endpoint list with a 2 s timeout. If the fetch fails, or nothing
  in it is usable, use the built-in copy. Use at most the first 64 usable
  entries. A test keeps the built-in copy equal to `endpoints.json`.
- Keep only `https` URLs, without userinfo, whose host is `nozomi.temporal.xyz`
  or ends in `.nozomi.temporal.xyz`. The client sends its API key and
  transactions to the endpoint it picks, so a tampered list must not be able
  to point anywhere else.
- Probe every endpoint in parallel. Each probe opens one new connection and
  sends 5 `GET /ping` round trips on it, timing only the round trips, never the
  handshake. The endpoint's RTT is the fastest of the 5.
- Each probe gets 5 s or the caller's deadline, whichever is sooner.
- Drop endpoints that fail or answer anything but `200`. Sort the rest by RTT;
  on a tie, keep list order.

### Coalescing

- A job is one `send` call, or one run of up to 16 txs from `send_batch`.
- Jobs wait in one shared FIFO. A connection that becomes free takes the next
  job, then every job already waiting, as long as the total stays at 16 txs or
  fewer.
- It never waits for more jobs to arrive: an idle client sends at once, and a
  busy one batches.
- A job that doesn't fit goes in that connection's next request. If that
  connection is down, it is offered to an idle connection first.
- Before sending, drop jobs whose caller has cancelled and complete them with
  the cancellation error.
- The body is each job's entries, in the order the jobs were taken.

### Results

- `200`: every job in the request succeeds.
- `400`, `403` or `409` from a request merging more than one job: resend each
  job on its own, and each job gets its own result. Jobs ahead of the bad tx
  go out twice, which is harmless because validators drop duplicate signatures.
  A job whose caller cancelled meanwhile gets the cancellation error instead,
  and after `close` the rest get `Closed`.
- Any other failure: every job in the request gets the same error. For a
  `429` or `5xx` the router may have accepted some of the entries; callers
  can't tell which, and resubmitting is harmless.

### Performance

- Build each request in a reused buffer and write it with one write call.
- In steady state a send SHOULD allocate nothing. Pool per-call state, reuse
  buffers, and parse responses directly rather than through an HTTP library
  that allocates.
- Use the standard library where it has TCP and TLS. Otherwise use the
  smallest widely used dependency, and say why in the SDK's README.

## 4. Required tests

Fake router for tests:
- HTTP/1.1 with keep-alive.
- `GET /ping` answers `200 pong`.
- `POST /api/sendBatch` answers `401` unless `c=key` and the content type is
  `application/octet-stream`.
- It reads entries in order. A tx whose first byte is `X` gets
  `400 Insufficient tip`, and processing stops there.
- Optional delay before answering.
- It counts connections, requests, pings and delivered txs.

1. **Coalescing and reject isolation.** `Conns` 1, server delay 20 ms, 41
   concurrent sends `tx00`..`tx40`, where number 20 is `Xbad`. Number 20 gets
   `HTTPError(400, "Insufficient tip")`. The other 40 succeed and are
   delivered, in fewer than 41 requests, over exactly 1 connection.
2. **Keep-alive and reconnect.** `Conns` 3, `PingInterval` 30 ms. After 150 ms
   there are at least 6 pings, all on 3 connections. The server then drops
   every connection, and a 2-tx `send_batch` still succeeds.
3. **Unauthorized.** A wrong key gives `HTTPError(401)`.
4. **TLS.** An `https://` endpoint with a test CA delivers.
5. **Response parser.**
   - Cases: Content-Length, 204, `Connection: close`, chunked with an
     extension and a trailer, HTTP/1.0 keep-alive, HTTP/1.0 body-to-EOF of
     exactly 4096 bytes, an oversized body, a `103` then a `200`, a four-digit
     status, `Transfer-Encoding: identity` with Content-Length, two differing
     Content-Lengths, an 8000-byte header line, a non-HTTP reply and a
     truncated body.
   - A reusable response leaves the next bytes unread.
6. **Allocations.** Where the language can measure it, a steady-state `send`
   allocates 0 times, counting client and server.
7. **Discovery ranking.** Probe a slow endpoint (20 ms per ping), a refused
   port and a fast one. The result is fast then slow, with the refused port
   dropped. A refused port on its own gives an error.
8. **Endpoint list.**
   - The built-in copy equals `../endpoints.json`.
   - A list with plain `http`, a foreign host, `nozomi.temporal.xyz.evil.com`
     and a URL with userinfo keeps none of them.
9. **Live discovery.** Opt-in only (`NOZOMI_LIVE=1`): probe the real endpoints
   and log the ranking.
10. **Caller buffers.** `Conns` 1, server delay 30 ms. Queue `tx0`, `Xbad` and
    a `victim` whose deadline expires while the first two are resent alone,
    then overwrite `victim`'s buffer as soon as its call returns. Under the
    race detector where available: no race, the overwritten bytes never reach
    the server, and `victim` itself is not sent.
11. **API key.** `new` rejects `""`, `"a b"`, `"a&b"`, `"a#b"`, a newline and a
    non-ASCII key. The key `k+y%2F=1` reaches the server as `c=k+y%2F=1`.
12. **User-Agent.** Every send and ping carries exactly
    `nozomi-sdk-<lang>/<version>`.

## 5. Benchmark

Use the same setup in every language so the numbers compare:

- **Transactions:** 1232 zero bytes each. `Conns` 4.
- **Server:** a minimal HTTP/1.1 server that answers each request with
  `200 Content-Length: 0` after an RTT of 0 or 1 ms.
- **Load:** serial (one sender), and parallel (4 senders per CPU).
- **Baseline:** the language's standard HTTP client, sending one tx per
  sendBatch request, also capped at 4 connections.
- **Report:** tx/s, txs per request, p50 and p99 latency per send, allocations
  per send, and the CPU model.

## 6. Adding a language

1. Make a top-level `<lang>/` directory with its own package and build. A
   release is tagged `<lang>/vX.Y.Z`.
2. Implement §2 and §3.
3. Port the tests (§4) and the benchmark (§5).
4. Write `<lang>/README.md`: install, usage, and the benchmark table.
5. Add the language to the table in the root README.
