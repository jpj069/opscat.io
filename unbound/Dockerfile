# A recursive resolver for blocklist lookups, and nothing else.
#
# Why this exists: DNSBLs refuse queries that arrive through a large shared
# resolver. Measured on the production host, every Spamhaus zone answered
# 127.255.255.254 ("query refused, use your own resolver") because the container
# resolves through systemd-resolved → the hoster's upstream. Queried DIRECTLY
# against Spamhaus' authoritative servers from the same machine, the canary
# answers correctly — so the address is fine and only the middleman was the
# problem. A resolver of our own recurses from the roots, which is exactly what
# the lists ask for.
#
# Built from Alpine's own package rather than a third-party unbound image: one
# less unpinned dependency to trust, and Alpine is already this project's base.
FROM alpine:3.20

RUN apk add --no-cache unbound drill \
  && mkdir -p /var/log/unbound \
  && chown -R unbound:unbound /var/log/unbound

COPY unbound.conf /etc/unbound/unbound.conf

# The root trust anchor for DNSSEC validation. Written at build time so the
# container needs no writable state; unbound refreshes it in memory (RFC 5011).
RUN unbound-anchor -a /etc/unbound/root.key || true \
  && chown -R unbound:unbound /etc/unbound

EXPOSE 53/udp 53/tcp

# Foreground, log to stderr, so `docker compose logs unbound` works.
CMD ["unbound", "-d", "-p"]
