# OpsCat Syslog Collector.
#
# Built from the REPOSITORY ROOT, not from this directory:
#   docker build -f collector/Dockerfile -t opscat/collector .
#
# The reason is the parser. `server/src/lib/syslog.js` is the single copy in the
# repo — the one `e2e-syslog.js` pins — and it is copied in here at build time
# rather than duplicated under collector/. A second checked-in copy would drift,
# and the copy that drifts would be the one running inside a customer's network.
FROM node:22-alpine

RUN addgroup -S opscat && adduser -S -G opscat opscat
WORKDIR /app

COPY collector/opscat-collector.js ./opscat-collector.js
COPY server/src/lib/syslog.js ./syslog.js
COPY collector/tunnel-entrypoint.sh /usr/local/bin/opscat-tunnel

# One image, three roles — collector, managed gateway, tunnel gateway — because
# it is one program (see the file header). The tunnel role is the only one that
# needs anything from the OS, and a customer's collector should not be carrying
# it: `--build-arg WITH_WIREGUARD=1` adds ~2 MB and is set only by the compose
# service that terminates tunnels.
ARG WITH_WIREGUARD=0
RUN if [ "$WITH_WIREGUARD" = "1" ]; then apk add --no-cache wireguard-tools iproute2; fi

# 514 is below 1024, which a non-root process may not bind — but in a container
# the daemon publishes the host port and the process can listen high, so the
# capability dance the systemd unit needs is unnecessary here. Defaults are set
# so `-p 514:5140/udp` is not required to get a working container.
ENV OPSCAT_UDP_PORT=5140 OPSCAT_TCP_PORT=5140 OPSCAT_TLS_PORT=6514
EXPOSE 5140/udp 5140/tcp 6514/tcp

USER opscat
ENTRYPOINT ["node", "/app/opscat-collector.js"]
