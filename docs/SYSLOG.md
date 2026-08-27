# Syslog ingestion

**Status: complete** — the customer-run collector, the managed TLS endpoint, the
WireGuard tunnel, their shared endpoints, the ingest path, and the screens an
operator uses to see whether any of it is working.

Syslog closes the gap the other four ingest paths cannot: **devices you cannot
install anything on.** The SDK, OTLP, Sentry and the host agent all assume you
own the process. A switch, a firewall, a load balancer, a UPS and a storage
array assume you own a syslog server. That is why a customer runs a central
relay, and it is the relay this feature attaches to.

## The shape

Two, and which one a customer gets is decided by one question: **can their relay
speak TLS to the internet?**

```
                                         ┌─ no ───▶ opscat-collector ──HTTPS──▶ OpsCat
switches / firewalls ──UDP/514──▶ relay ─┼─ yes ──▶ syslog.opscat.io:6514 ────▶ OpsCat
      (unchanged)                        │           (RFC 5424 over TLS)
                                         └─ can't ▶ WireGuard ──UDP/514──────▶ OpsCat
                                                     (the address is the tenant)
```

The third branch is for the relay that can reach the internet but cannot speak
TLS — an appliance, an old rsyslog, a device with no certificate store. It gets
a tunnel, and inside the tunnel plain UDP is attributable again.

Two things about this diagram do the work.

**There are two UDP legs and only the second one is new.** The devices keep
sending UDP to the relay; nothing about that changes. What is added is one more
*destination* on the relay — and a relay's input and output transports are
independent, so a relay that receives UDP forwards over TCP without being
reconfigured otherwise. "Do I have to upgrade my relay?" is the first question
every time, and the answer is no.

**Something has to be the box that talks outward.** It terminates TLS, buffers
across an outage and speaks HTTPS to OpsCat, which is what lets a 2015
installation reach a SaaS without being touched. When that box is the customer's,
it is the collector — what Splunk ships as SC4S, and what Elastic, Datadog, Cribl
and Vector all ship a version of. When the relay can already do the outward half
itself, the box is **ours**, and the customer installs nothing.

Neither is the "real" one. A modern rsyslog with internet egress should use the
managed endpoint; an appliance-era relay behind a firewall cannot, and no amount
of product design changes that.

## The credential

A collector authenticates with an ordinary **`api_keys` row carrying the
`collector` scope**, minted only by `POST /api/syslog/endpoints`. It was
tempting to give it a credential kind of its own; `api_keys` already provides
the hash lookup, the per-key rate limit, `last_used_at`, revocation and the org
stamp, and `pipeline.ingestLogs` already writes the key NAME into `logs.source`
— so "which site is sending too much" is answerable with no new column
anywhere. A second credential kind would have re-implemented five things to
gain none.

Three consequences are load-bearing and each has a check in `e2e-collector.js`:

* **Blast radius.** An `ingest` key may also post events and webhooks. A key
  living in an env file on a customer's relay may not, so the scope is
  `collector` and the endpoints are its own (`/v1/collector/*`).
* **A budget of its own.** `apiKeys` is 2 on Free and 10 on Pro. Collector keys
  are excluded from that count (`plans.js`) and have their own
  `syslogEndpoints` limit, or a customer with eight sites would have two keys
  left for everything else.
* **Never an orphan.** The key and the `syslog_endpoints` row are written in one
  transaction, so a plan refusal rolls the key back. A key without an endpoint
  is a live credential belonging to nothing and invisible in every screen —
  the same shape as the orphaned `agents` row `e2e-sensors` exists to catch.
  `routes/admin.js` therefore refuses the `collector` scope: it cannot write the
  second row.

The prefix is **`ocl_`**, not the more obvious `occ_`. Both are legal under the
`oc` + one letter + `_` rule and `occ_` was free — but `occ_` and `ock_` differ
by one letter and appear in the same places: an env file, a screenshot, a
support ticket, a value read aloud on a call. Anchored patterns tell them apart
and people do not.

## What the collector does

`collector/opscat-collector.js`, dependency-free, one file plus the parser.

* Listens on **UDP/514**, **TCP/514** and **TLS/6514** (TLS only with a cert).
* Parses **RFC 5424** and **RFC 3164**, and both TCP framings — LF-delimited and
  RFC 6587 octet counting. A line it cannot parse is **kept** at the default
  severity, because the appliance that writes its own format is exactly why the
  customer has a relay.
* Buffers in memory (50 000 lines by default), drops the **oldest** first under
  pressure and **reports every drop as a log line of the customer's own**. A
  collector that discards silently is worse than one that stops.
* Polls `/v1/collector/config`, so the device prefix and the enabled switch are
  decided by the server. A noisy site can be silenced from the UI without an SSH
  session to someone else's relay.

**Published on a version tag, to GHCR.** `.github/workflows/release.yml` pushes
`ghcr.io/jpj069/opscat-collector` on `v*` (`:1.2.3`, `:1`, `:latest`) and
`:edge` from `main` — deliberately no `:latest` from main, because an image
customers pull must not change under a stable name on every merge. It also
attaches an image tarball to the release for a customer whose egress policy
cannot reach ghcr.io, and re-asserts on the PUSHED image that its parser is
byte-identical to `server/src/lib/syslog.js`.

GHCR rather than Docker Hub for one customer-facing reason above all: Docker Hub
rate-limits anonymous pulls, and a relay in a customer's network pulls
anonymously. **One manual step remains once the first tag is pushed:** the GHCR
package inherits the private repository's visibility and has to be set to public
once, or nobody can pull it. Package visibility is per package — the account's
other packages are unaffected.

`ci.yml` keeps building `collector/Dockerfile` on every pull request, and that
stays: it is what moves the discovery of a Dockerfile mistake to the PR instead
of to a customer running the command our own UI printed. The release workflow
publishes; CI proves it builds.

The snippet named `opscat/collector:latest` for two commits, which resolves to
nothing — Docker Hub has no such repository and nothing ever pushed one. Worth
recording, because it is the same defect as `npm i @opscat/sdk` in the
onboarding tab: **a product that prints a command owns whether that command
works.** Both are now named by a constant that points at something a release
actually creates, and `e2e-collector` pins the image name.

Packaged two ways because syslog relays live in two worlds: a container image,
and a systemd installer for the lean VM the network team keeps Docker off. The
unit runs as an unprivileged user with `AmbientCapabilities=CAP_NET_BIND_SERVICE`
— port 514 is below 1024, and a process that parses unauthenticated bytes from
unaudited devices is the last one that should be root.

### Two things a live host taught us that no harness could

**`install.sh` was broken for anyone running it from a checkout.** It checked
whether `opscat-collector.js` sat next to it, found it, and concluded everything
was local — but `syslog.js` is never next to it, because it has exactly one copy
in `server/src/lib`. The copy then failed with `cp: cannot stat …/syslog.js`.
The piped install (the documented path) always worked, which is why nothing
noticed. It now resolves the parser from three places in order: a complete
directory, a checkout (`../server/src/lib/syslog.js`), or the instance.

**A TLS key mounted the obvious way is unreadable.** The container runs as uid
100 and a private key is `0600 root`, so `-v /etc/ssl/private:/certs:ro` yields
`EACCES`. The collector logs it and keeps the UDP and TCP listeners running —
correct behaviour, and also the failure that looks healthiest: lines keep
arriving, only the encrypted ones do not. `collector/README.md` § TLS in a
container carries the fix.

## One parser, and how it stays one

`server/src/lib/syslog.js` is the only copy in the repository. The installer
fetches it from the instance (`/collector/syslog.js`, served straight out of
`src/lib`) and the Dockerfile copies it in at build time from the repository
root. So the parser running inside a customer's network is byte-for-byte the one
`e2e-syslog.js` pins, and there is no second file that could drift.

Its three failure modes are all silent downstream, which is why it got a harness
before a socket existed:

* **facility and severity swapped** (`pri >> 3` vs `pri & 7`) — both are small
  integers, and the entire urgency ladder hangs off the second one;
* **a frame split across TCP segments** — every octet-counting bug ever written
  passes a test that hands it one whole frame;
* **the year RFC 3164 does not carry** — taking the current year is right for 51
  weeks and wrong in the one that matters, and the symptom is not an error but a
  New Year's Eve with no logs.

## Connecting a relay

Generated in the UI rather than copied from here — `lib/syslog-config.js` owns
the text, so what a customer is shown is produced by the code that knows the
answer. Two lines in it are not decoration:

```
template="RSYSLOG_SyslogProtocol23Format"   # or all 200 devices arrive as one
queue.type="LinkedList" queue.filename="opscat_fwd"
queue.maxdiskspace="1g" queue.saveOnShutdown="on"
action.resumeRetryCount="-1"                # or an outage is a hole, not a delay
```

rsyslog's default forwarding template puts the *relay* in the `HOSTNAME` field.
And plain `omfwd` buffers in memory and discards. Both are defaults, both are
wrong for this purpose, and both are invisible until someone looks for a device
that is not there.

The snippets start with a single facility (`local7`) rather than `*.*` on
purpose: a relay pointed at a new destination can put fifty million lines a day
onto a Free allowance before anybody looks at the result.

## API

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/syslog/endpoints` | session, lead+ | never returns the key |
| `POST /api/syslog/endpoints` | session, lead+ | mints the key, returns it **once** with the snippets; `mode` is `collector` or `managed` |
| `PATCH /api/syslog/endpoints/:id` | session, lead+ | name, device prefix, enabled, mode — partial, `COALESCE` |
| `POST /api/syslog/endpoints/:id/rotate` | session, lead+ | old key dies immediately |
| `GET /api/syslog/endpoints/:id/config` | session, lead+ | snippets with a placeholder, never the key |
| `DELETE /api/syslog/endpoints/:id` | session, lead+ | revokes the key with it |
| `GET /v1/collector/config` | `ocl_` key | what the collector polls |
| `POST /v1/collector/logs` | `ocl_` key | same body and 500-line cap as `/v1/ingest/logs` |
| `GET /api/syslog/endpoints/:id/throughput` | session, lead+ | lines per UTC day, 1-90 days |
| `GET /v1/tunnel/peers` | gateway key | public keys + inner addresses; nothing secret |
| `POST /v1/tunnel/logs` | gateway key | `{sourceIp, logs}`; the tenant is resolved here |

Ingested lines go through `pipeline.ingestLogs` like every other path, so they
are classified, deduplicated, folded into `event_buckets`, counted against the
same daily allowance and swept by the same retention. There is no second write
path, which is the point.

## The managed endpoint (stage 2)

`syslog.opscat.io:6514`, RFC 5424 over TLS, and the customer installs nothing.

The interesting question is the only one that matters for a multi-tenant socket:
**whose logs are these?** Every other ingest path in this product answers it from
a credential in an HTTP header. Here the connection is anonymous — a relay opens
a TCP socket and starts sending — so the answer has to come out of the message.

It is the RFC 5424 structured-data element, which is what the field already does:

```
<134>1 2026-08-23T09:47:14Z core-sw-01 kernel - - [opscat@0 token="ocl_…"] interface down
```

Better Stack (`[logtail@11993]`), Mezmo (`[logdna@48950]`) and Sumo Logic
(`@41123`) all do exactly this, and for the same reason: it is the one place in
the format designed for a vendor to put a vendor's field.

**The enterprise number is not the identifier.** RFC 5424 makes a custom SD-ID
`name@<PEN>`, and ours is applied for and not yet assigned — so what we print
today is `0`, which IANA lists as Reserved and can therefore never be another
organisation's. The gateway matches the element by NAME and ignores the number,
so the day the assignment lands, every relay configured before it keeps working
untouched. Same rule as the credential prefixes: what we hand out may be
re-spelled, so nothing that has to keep working may depend on the spelling.

### The gateway is the collector

`collector/opscat-collector.js` with `OPSCAT_GATEWAY=1`. One program, because
everything between the socket and the HTTP POST — the framer, the bounded queue,
the backoff, the drop accounting, the shutdown drain — is the same code, and the
second copy is the one that drifts. Single-tenant is the special case: there is
one queue per key either way, and in collector mode there is one key.

The modes differ in exactly three things, and each of the three is a check in
`e2e-gateway.js`:

* **Where the key comes from.** The environment, or each message. A gateway with
  `OPSCAT_COLLECTOR_KEY` set **refuses to start** — a copied unit file would
  otherwise ingest every unattributed message into whichever org that key
  belongs to, silently.
* **Which listeners open.** TLS only. The key is in the message now, so a UDP or
  plain-TCP port would hand a write credential for somebody's logs to everyone on
  the path, with no handshake and no rate limit to lean on.
* **What a refused key means.** In collector mode it is the process's whole
  reason to exist, so it exits loudly. In gateway mode it came off the wire from
  a sender we do not control, so it is remembered as bad for ten minutes and its
  queue is dropped — exiting would let a stranger take down every tenant on the
  box with one message.

Two bounds exist because the input is the internet rather than a customer's LAN:
the number of tenants tracked is capped (one queue per attacker-chosen token is a
memory exhaustion costing one packet each), and a token is shape-filtered before
it can become an HTTPS round trip. Neither is an authentication decision — the
server still owns that, by hashing.

**The token never reaches the log store.** `toIngestEntry` builds the stored line
out of APP-NAME and MSG; structured data is a separate field it does not read. A
credential that travelled in the message would otherwise sit in the org's own
logs, readable by every analyst and exportable — so it is asserted directly
rather than left as a property of the current code.

### Running it

```yaml
docker compose --profile syslog up -d      # cloud stack
```

Three things it needs, and all three fail loudly rather than quietly:

1. **A DNS A record** for `syslog.<domain>`. Caddy's block in the `Caddyfile`
   exists only to obtain and renew the certificate — there is no web content on
   that name — and without the record it cannot complete the challenge.
2. **`OPSCAT_SYSLOG_HOST`** in the app's environment. Empty means "this instance
   has no gateway": the mode is not offered in the UI and the API refuses to
   store it, rather than printing a hostname that resolves to nothing.
3. **The certificate**, read out of Caddy's shared volume. Caddy writes the key
   `0600 root`, so the container runs as root with every capability dropped,
   `no-new-privileges` and a read-only filesystem, rather than as the
   unprivileged user that would simply find nothing — the same trap the
   collector's own TLS listener hit on a live host, where it is survivable
   because UDP and TCP keep working and here it is not. The gateway searches
   for `<domain>.crt`/`.key` below the path it is given rather than taking a
   fixed one, because the middle path segment names the CA and changes if
   issuance ever falls back from Let's Encrypt to ZeroSSL. It hot-reloads on
   renewal — nothing restarts it when Caddy rewrites the files, so a listener
   that read the certificate once would serve an expired one from the day it
   expires.

### What is deliberately not offered

**Public UDP without a tunnel.** The token would travel in clear text and grant
write access to a tenant's logs to anyone who saw it, with no handshake and no
rate limit. That is what stage 3 is for: a WireGuard tunnel, where the inner
source address is bound to a peer key by the kernel and UDP becomes usable again.

## The tunnel (stage 3)

The managed endpoint refuses UDP because the token would travel in clear. The
tunnel removes the token instead of protecting it.

Inside WireGuard a packet's source address is not a claim, it is a consequence:
the kernel drops anything whose source is not in the sending peer's
`AllowedIPs`, and only the holder of that peer's private key can send at all. So
"whose logs are these?" is answered by the address — and an appliance that can
only speak plain UDP/514, and therefore cannot carry a credential at all,
becomes reachable.

Three consequences run through the whole design:

* **We never see a private key.** The customer runs `wg genkey` and pastes the
  public half. We could generate the pair and show the private key once — it is
  one step shorter and plenty of products do it — but then we have held a
  credential that identifies their relay, and this product's rule is that a
  secret a human relays is a design smell. The rendered config keeps
  `PrivateKey` as a placeholder.
* **An inner address belongs to exactly one endpoint, across every
  organisation.** That is the entire tenant boundary of this path, so it is a
  unique index (migration 031) and not a check in JavaScript. The allocator
  reads what is taken and proposes the lowest free address; the database
  decides, and a loser's transaction rolls back.
* **`AllowedIPs` is our single inner address, never `0.0.0.0/0`.** The wide form
  would send the relay's entire traffic through us — not what was asked for, not
  what we offer, and a thing nobody notices until their egress address moves.

### The gateway holds no tenant credential

Something must terminate the tunnel and whatever does is trusted; that is
inherent. What was chosen is how much a stolen gateway credential is worth.

The obvious shape hands the gateway a map of address → the endpoint's collector
key. One theft would then yield every tenant's write key, in plaintext, reusable
from anywhere. So instead the gateway **asserts the source address and the
server resolves the tenant**: `/v1/tunnel/peers` returns public keys and
addresses (nothing secret), and `/v1/tunnel/logs` takes `{sourceIp, logs}`. A
stolen key can still write into any tenant — unavoidable — but only through that
endpoint, and only in a way attributable to the gateway rather than
indistinguishable from the customer's own relay.

The device prefix is applied server-side here, unlike every other syslog path,
for the same reason: the gateway does not know which endpoint an address belongs
to, and telling it would mean shipping it the mapping this design keeps.

### The one line between correct and open relay

Attribution by source address is sound **only** because WireGuard verified the
address. Bound to `0.0.0.0` the identical code would apply that trust to packets
from the internet, and anyone could pick an inner address and write into that
tenant's logs by spoofing a UDP source.

There is no safe default, so there is no default: `OPSCAT_BIND` must name the
tunnel address and the process exits 2 otherwise. `e2e-tunnel.js` checks that
refusal before it checks anything else.

### Running it

```yaml
docker compose --profile syslog-tunnel up -d
```

The same binary again, `OPSCAT_TUNNEL=1`, in the one role that needs anything
from the OS (`--build-arg WITH_WIREGUARD=1`, ~2 MB). It holds `NET_ADMIN` and
its own interface, which is unavoidable — so the compensations are the ones that
still apply: no tenant credential (it refuses to start with one), a bind that
cannot be widened, and the address→tenant mapping kept on the server. The host
needs the `wireguard` kernel module; Ubuntu 24.04 ships it.

`docs/OPERATIONS.md` has the variables and the order to set them in.

### What is NOT verified by anything we run

`e2e-tunnel.js` drives the real binary over real sockets with real distinct
source addresses — the pool is `127.0.0.0/8` for the run, so the loopback range
supplies them. What it cannot assert is the WireGuard data plane itself: that
the kernel really does drop a packet whose source is not in the sending peer's
`AllowedIPs`. That property belongs to WireGuard, the whole mode rests on it,
and no harness of ours can test it. What we do test is that we never trust an
address we were not supposed to.

## Stage 4: where an operator actually looks

Three things, and one of them turned out to be a defect rather than a feature.

**An endpoint is in Assets.** It is a record — unlike the derived `log-source`
rows beside it, which are device names inferred from lines and carry no id — so
it gets a row that opens the flyout that already exists, rather than a second,
thinner one. Its status is `waiting` until something has actually arrived:
"configured, never connected" is the commonest support case in this whole
feature, and reading like a working endpoint is how it stays unnoticed.

**A device says which endpoint it came through.** `logs.source` has always held
the key's name; `lastSeenByDevice` now returns it (ClickHouse `argMax`, Postgres
an ordered aggregate), so the Assets detail reads `logs · via RZ Frankfurt`
instead of `no agent`. "Which site is that box behind?" is the first question
anyone asks about a device name they do not recognise.

**Throughput per endpoint**, fourteen days, in the flyout. The original write-up
claimed "which site is sending too much is answerable with no new column
anywhere" — and it was answerable in principle and nowhere on screen, which is
the same distance as not answerable. Days with no lines are filled with zero
rather than skipped, so a relay that stopped for two days is a flat gap and not
a closed-up healthy-looking line.

### The Scout finding

Scout needed nothing built for syslog: every path goes through
`pipeline.ingestLogs`, which emits `log`, which Scout subscribes to. That was
true and it did not work, for a reason that only showed up when a harness asked.

`classify()` falls back to the **syslog floor** — any line at severity 4
(warning) or worse gets a match, so that a critical line becomes an event even
when no rule names it. Right for the event path. But the same return value set
`matched: true`, and `matched` is what tells Scout "a classifier knows this
line". It does not: the match is a generated name (`syslog_sev4`) with a null
pattern, saying only how loud the sender thought it was.

So Scout was blind to every syslog line above severity 5 — which is precisely
the population it exists to find rules for. A customer's entire firewall feed
produced no suggestions at all, and nothing anywhere said so.

The fix is four characters of condition (`cls.source !== 'syslog'`) and the
lesson is bigger than the fix: **a fallback that produces a value is not the
same as something having recognised it**, and the two are indistinguishable at
the call site unless one of them says which it is.
