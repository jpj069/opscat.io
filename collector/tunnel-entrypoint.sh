#!/bin/sh
# Brings up the WireGuard interface, then hands over to the collector in tunnel
# mode. Only this image role runs it; a customer's collector never does.
#
# `ip` + `wg` directly rather than `wg-quick`, for two reasons: wg-quick is a
# bash script (Alpine's shell is not bash) and it does a great deal more than we
# want — DNS, routing tables, firewall rules — none of which applies to an
# interface that carries nothing but syslog.
set -e

IF="${OPSCAT_TUNNEL_IF:-opscat}"
PORT="${OPSCAT_TUNNEL_LISTEN_PORT:-51820}"

[ -n "$OPSCAT_TUNNEL_PRIVKEY" ] || {
  echo "OPSCAT_TUNNEL_PRIVKEY is required — generate one with `wg genkey`" >&2; exit 2; }
[ -n "$OPSCAT_BIND" ] || {
  echo "OPSCAT_BIND is required: the tunnel address this process listens on" >&2; exit 2; }

# Written to a file with a umask rather than passed as an argument: an argument
# is visible in /proc/<pid>/cmdline to anything that can read the process list.
mkdir -p /etc/wireguard
( umask 077; printf '%s' "$OPSCAT_TUNNEL_PRIVKEY" > /etc/wireguard/"$IF".key )

if ! ip link show "$IF" >/dev/null 2>&1; then
  ip link add dev "$IF" type wireguard
fi
wg set "$IF" listen-port "$PORT" private-key /etc/wireguard/"$IF".key
# The gateway's own inner address. /32 on purpose — peers are routed
# individually by `wg set peer ... allowed-ips`, which the collector reconciles
# against the server, so nothing here should claim the whole pool.
ip addr replace "${OPSCAT_BIND}/32" dev "$IF"
ip link set up dev "$IF"
# The pool has to be reachable THROUGH the interface, or replies to a peer would
# be looked up in the host's routing table and go nowhere.
[ -z "$OPSCAT_TUNNEL_NET" ] || ip route replace "$OPSCAT_TUNNEL_NET" dev "$IF"

echo "wireguard: $IF up on :$PORT as $OPSCAT_BIND"
exec node /app/opscat-collector.js
