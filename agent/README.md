# opscat-agent

A single-file, dependency-free Node.js host agent for [OpsCat](https://opscat.io).
It runs on Linux servers and reports host health to your OpsCat instance:

- **Heartbeat + metrics** every interval (CPU, load, memory, disk, network).
- **journald logs** (`--logs`) — tails the system journal and ships lines.
- **Synthetic probes** (`--probe`) — runs http / icmp / dns / tcp / traceroute
  checks assigned to this probe location and reports the results.

Requires **Node.js ≥ 18** (uses the built-in `fetch` and `AbortController`).
No npm dependencies.

## Install (one-liner)

From a checkout of this directory, as root:

```sh
sudo OPSCAT_URL=https://opscat.io \
     OPSCAT_AGENT_TOKEN=agt_xxxxxxxx \
     OPSCAT_PROBE_KEY=prb_xxxxxxxx \
     OPSCAT_AGENT_FLAGS="--logs --probe" \
     sh install.sh
```

This will:

1. Copy `opscat-agent.js` to `/opt/opscat-agent/`.
2. Write `/etc/opscat-agent.env` (`chmod 600`) from the `OPSCAT_*` variables.
3. Install + enable the `opscat-agent` systemd unit and start it.

`install.sh` is **idempotent**. To upgrade the agent later, re-run it without the
`OPSCAT_*` variables — it overwrites the script, keeps your existing env file,
runs `systemctl daemon-reload`, and restarts the service:

```sh
sudo sh install.sh
```

Follow the logs:

```sh
journalctl -u opscat-agent -f
```

## Configuration

Config comes from environment variables or CLI flags — **flags win**.

| Env var | Flag | Default | Purpose |
|---------|------|---------|---------|
| `OPSCAT_URL` | `--url <url>` | — | OpsCat base URL (required). |
| `OPSCAT_AGENT_TOKEN` | `--token <token>` | — | Agent token, Bearer auth (required). |
| `OPSCAT_PROBE_KEY` | `--probe-key <key>` | — | Probe key for `--probe`. |
| — | `--logs` | off | Ship journald logs. |
| — | `--probe` | off | Run synthetic checks. |
| — | `--interval <sec>` | `60` | Heartbeat/metrics interval. |
| — | `--disk-path <path>` | `/` | Filesystem to report disk usage for. |
| — | `--dry-run` | — | Collect metrics once, print JSON, exit 0. |
| — | `--help` | — | Show usage. |

When installed via systemd, extra flags go in `OPSCAT_AGENT_FLAGS` in
`/etc/opscat-agent.env` (e.g. `OPSCAT_AGENT_FLAGS="--logs --probe --disk-path /data"`).

### Run manually

```sh
OPSCAT_URL=https://opscat.io OPSCAT_AGENT_TOKEN=agt_xxx \
  node opscat-agent.js --interval 30 --logs

# preview the metrics payload without sending anything:
node opscat-agent.js --dry-run
```

## What gets collected

Every `--interval` seconds the agent POSTs a heartbeat (`hostname`, `platform`,
`version`) and the following metrics (`POST /v1/agents/metrics`):

| Field | Source |
|-------|--------|
| `cpuPct` | Two `/proc/stat` samples 1s apart: `100 * (1 - idle_delta/total_delta)`, where idle counts `idle + iowait`. |
| `load1` | `os.loadavg()[0]` |
| `memUsed` / `memTotal` | `/proc/meminfo`: `MemTotal - MemAvailable`, and `MemTotal` (bytes). |
| `diskUsed` / `diskTotal` | `df -kP <disk-path>` (blocks × 1024, bytes). |
| `netRx` / `netTx` | Sum of `rx_bytes` / `tx_bytes` across non-`lo` interfaces from `/proc/net/dev` (cumulative counters). |

## Log shipping (`--logs`)

Spawns `journalctl -f -o json -n 0` and ships lines to `POST /v1/agents/logs`
in batches (up to 100 lines, flushed every 5s). Field mapping:

- `line` ← `MESSAGE` (empty messages skipped; byte-array messages decoded to UTF-8)
- `device` ← `_HOSTNAME` (falls back to `os.hostname()`)
- `sev` ← `PRIORITY` (default 6)
- `ts` ← `__REALTIME_TIMESTAMP` (µs → ms)

Lines containing `opscat` are skipped to avoid feedback loops. If `journalctl`
exits, it is restarted after 10s. The in-memory log queue is capped at 2000
lines (drop-oldest). Running with `--logs` requires access to the journal,
which is why the systemd unit runs as `root`.

## Probe mode (`--probe`)

Requires `OPSCAT_PROBE_KEY`. Every 30s the agent pulls its work list from
`GET /v1/synthetics/checks` and runs each check whose `intervalS` has elapsed
since its last local run, then POSTs results to `POST /v1/synthetics/report`
(batched, up to 200 per request).

| Type | How | `ok` | `latencyMs` | `meta` |
|------|-----|------|-------------|--------|
| `http` | `fetch(target)` | status < 400 | request duration | `{ status }` |
| `icmp` | `ping -n -q -c 5 -i 0.2 -W <t> <host>` | packet loss < 100% | avg RTT | `{ loss, jitter }` |
| `dns` | `Resolver.resolve4` (supports `name @ server`) | ≥ 1 address | resolve duration | `{ addresses }` |
| `tcp` | `net.connect(host:port)` | connected | connect time | `{ error? }` |
| `traceroute` | `traceroute -n -q 1 -w 1 -m 20 <host>` | ≥ 1 hop replied | — | `{ hops:[{hop,ip,ms}] }` |

`icmp` jitter is `mdev` from iputils (`null` if unavailable / busybox). If the
`traceroute` binary is missing, that check is skipped silently.

## Robustness

- Every HTTP call has a 10s timeout and a catch-all — network errors never crash
  the agent; each failure prints one structured line to stderr:
  `[opscat-agent] <iso-ts> <context> failed: <reason>`.
- `SIGTERM` / `SIGINT` trigger a graceful shutdown with a final log flush.
- Tokens and probe keys are never written to logs (redacted defensively).
- Memory stays small: bounded log queue, no unbounded buffers.

## Uninstall

```sh
sudo systemctl disable --now opscat-agent
sudo rm -f /etc/systemd/system/opscat-agent.service
sudo systemctl daemon-reload
sudo rm -rf /opt/opscat-agent
sudo rm -f /etc/opscat-agent.env
```
