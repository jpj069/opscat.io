# OpsCat Syslog Collector

Receives syslog inside your network and ships it to OpsCat over HTTPS. One
process, no dependencies, no inbound connection from the internet.

It exists for the relay you cannot modernise: the central syslog server that
speaks plain UDP, belongs to the network team, and is not going to grow TLS this
quarter. The collector stands next to it and becomes the one box that talks
outward.

## What it does

* Listens on **UDP/514**, **TCP/514** and **TLS/6514** (TLS only when you give it
  a certificate).
* Parses **RFC 5424** and **RFC 3164**, both TCP framings (LF-delimited and
  RFC 6587 octet counting). A line it cannot parse is kept, not dropped.
* Buffers in memory and retries with backoff, so an internet outage delays lines
  instead of losing them.
* Reports its own losses as a log line — a drop is visible in OpsCat, not only
  in a counter on a box nobody opens.

## Install

**Docker**

```sh
docker run -d --name opscat-collector --restart always \
  -p 514:5140/udp -p 514:5140/tcp -p 6514:6514 \
  -e OPSCAT_URL=https://opscat.io \
  -e OPSCAT_COLLECTOR_KEY=ocl_… \
  opscat/collector:latest
```

**systemd** (no Docker on the box)

```sh
curl -fsSL https://opscat.io/collector/install.sh | sudo \
  OPSCAT_URL=https://opscat.io \
  OPSCAT_COLLECTOR_KEY=ocl_… \
  sh
```

Create the endpoint and get the key in OpsCat under **Settings › Collectors ›
Syslog Endpoints**. The key is shown once.

## Pointing your relay at it

Your relay keeps every input and destination it has; this is one more output.
Input and output transports are independent — a relay that receives UDP can
forward over TCP without being reconfigured otherwise.

```
# /etc/rsyslog.d/60-opscat.conf
if $syslogfacility-text == 'local7' then {
  action(type="omfwd" target="10.10.0.42" port="514" protocol="tcp"
         template="RSYSLOG_SyslogProtocol23Format"
         queue.type="LinkedList" queue.filename="opscat_fwd"
         queue.maxdiskspace="1g" queue.saveOnShutdown="on"
         action.resumeRetryCount="-1")
}
```

Two details that decide whether this works:

* **`template="RSYSLOG_SyslogProtocol23Format"`.** Without it rsyslog rewrites
  `HOSTNAME` to the relay itself and all your devices arrive as one.
* **The `queue.*` lines.** Plain `omfwd` buffers in memory and discards; these
  make an outage a delay instead of a hole.

Start with one facility as above, confirm the lines arrive, then widen to `*.*`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `OPSCAT_URL` | — | Your OpsCat instance. Required. |
| `OPSCAT_COLLECTOR_KEY` | — | `ocl_…`, from Settings › Collectors. Required. |
| `OPSCAT_BIND` | `0.0.0.0` | Interface to listen on. |
| `OPSCAT_UDP_PORT` / `OPSCAT_TCP_PORT` | `514` | Set to `0`-free values to run unprivileged. |
| `OPSCAT_TLS_PORT` | `6514` | Only listens when cert and key are set. |
| `OPSCAT_TLS_CERT` / `OPSCAT_TLS_KEY` | — | PEM paths for the TLS listener. In the container, both must be readable by uid 100 — see below. |
| `OPSCAT_MAX_QUEUE` | `50000` | Lines held during an outage. Oldest dropped first, and counted. |
| `OPSCAT_MAX_CONNS` | `512` | Concurrent TCP/TLS connections. |
| `OPSCAT_IDLE_MS` | `300000` | Idle connection timeout. |

Device prefix and the enabled switch are **not** configured here — they come
from the server on every poll, so a site can be silenced without an SSH session
to the customer's relay.

### TLS in a container: the key has to be readable

The container runs as an unprivileged user (uid 100), and a private key is
`0600 root` by convention — so the obvious `-v /etc/ssl/private:/certs:ro` gives
the collector a key it cannot open. It says so and keeps the UDP and TCP
listeners running rather than exiting:

```
TLS listener NOT started — could not read cert/key: EACCES: permission denied, open '/certs/key.pem'
```

Either make the key readable by that user (`chown 100 key.pem`) or run the
container as the key's owner (`--user 0`). Under systemd the same applies to the
`opscat-collector` user the installer creates.

This is the one part of the setup that fails silently in the sense that matters:
lines keep arriving over UDP and TCP, so a partly-working collector looks
healthy. Check the log after enabling TLS.


## Gateway mode (this is how OpsCat runs it)

The same binary, `OPSCAT_GATEWAY=1`, is the managed endpoint at
`syslog.opscat.io:6514`. You do not need it to send logs to OpsCat — it is
documented here because it is the same program and the same file, and because a
self-hoster may want one.

```
OPSCAT_GATEWAY=1 \
OPSCAT_URL=http://app:3000 \
OPSCAT_TLS_CERT=/caddy/caddy/certificates \
OPSCAT_TLS_KEY=/caddy/caddy/certificates \
OPSCAT_TLS_DOMAIN=syslog.example.com \
  node opscat-collector.js
```

It is multi-tenant: each message carries its own key in RFC 5424 structured
data, and the gateway groups by that key and forwards each group under it. So:

* **No `OPSCAT_COLLECTOR_KEY`.** The process refuses to start with one set —
  otherwise every message that failed to carry its own token would be silently
  ingested into whichever organisation that key belongs to.
* **TLS only.** No UDP and no plain TCP listener is opened, because the key now
  travels in the message and a cleartext port would publish it.
* **A readable certificate is required.** Unlike collector mode — where a
  missing certificate is a degradation and UDP and TCP keep working — TLS is the
  only listener here, so it exits (code 4) rather than accepting connections
  from nobody while looking healthy.
* **The certificate path may be a DIRECTORY**, searched for
  `<OPSCAT_TLS_DOMAIN>.crt`/`.key`. That is how it reads the one Caddy already
  obtains and renews, whose path contains a segment naming the CA. It re-reads
  on change, so a renewal needs no restart.
* **It has to be able to READ that certificate**, which is the same trap as
  § TLS in a container above and bites harder here, because TLS is the only
  listener: Caddy writes its key `0600 root` and there is no mode setting for
  it, so an unprivileged container finds nothing and exits 4. OpsCat's own
  compose service answers that by running as root **with every capability
  dropped**, `no-new-privileges`, a read-only root filesystem and one read-only
  mount — it binds 6514, above 1024, so it does not even want
  `CAP_NET_BIND_SERVICE`. Making the key readable by the unprivileged user
  instead works just as well when you control how it is written.

| Variable | Default | |
|---|---|---|
| `OPSCAT_MAX_TENANTS` | `1000` | distinct keys tracked; past it, messages are dropped and counted |
| `OPSCAT_BAD_KEY_MS` | `600000` | how long a key the server refused is ignored before it is tried again |
| `OPSCAT_FLUSH_MS` | `2000` | how often the shipper wakes |
