'use strict';
/**
 * The configuration a customer pastes, generated on the server.
 *
 * ── Why the server generates it and the customer does not write it ──────────
 *
 * Three details decide whether a first attempt works, and all three are things
 * nobody gets right from prose:
 *
 *   1. **The hostname is lost by default.** rsyslog's default forwarding
 *      template puts the RELAY in the HOSTNAME field, so two hundred devices
 *      arrive as one. `RSYSLOG_SyslogProtocol23Format` is the built-in that
 *      preserves the original sender, and it has to be named explicitly.
 *   2. **Without a queue, an outage is a hole.** Plain `omfwd` buffers in
 *      memory and discards. The four `queue.*` settings plus an infinite retry
 *      are the difference between "delivered late" and "gone".
 *   3. **The first step must be filtered.** A relay pointed at a new target with
 *      `*.*` can put fifty million lines a day onto a Free allowance before
 *      anyone looks. The snippets therefore ship a commented `local7` variant
 *      right next to the full one.
 *
 * Same principle as Scout's classifier preview: what the customer is shown is
 * produced by the code that owns the answer, not re-typed into documentation
 * that then drifts from it.
 *
 * ── The key is only in here once ────────────────────────────────────────────
 *
 * A collector key is retrievable exactly at creation and rotation, like every
 * other credential this product mints. Afterwards `key` is null and the blocks
 * render a placeholder — the customer copies the config at the moment they get
 * the secret, and the screen stays useful afterwards without becoming a place
 * where secrets can be re-read.
 */

/*
 * ── Two modes, and why the managed one needs a template of its own ──────────
 *
 * `mode: 'collector'` renders the customer-run collector: install it, point the
 * relay at it over plain TCP inside their own network.
 *
 * `mode: 'managed'` renders a relay pointing straight at our gateway, which
 * means two things change at once. The transport becomes TLS — non-negotiable,
 * because the tenant's key now travels IN each message — and the message has to
 * carry that key, which no built-in template does. So the managed snippets ship
 * a hand-written template that reproduces `RSYSLOG_SyslogProtocol23Format`
 * field for field and substitutes our structured-data element for
 * `%STRUCTURED-DATA%`.
 *
 * Substituting rather than appending is deliberate. rsyslog renders `-` for a
 * message with no structured data, and `-[opscat@0 token="…"]` is not valid
 * RFC 5424 — the parser stops at the `-` and the token is never seen. Nothing
 * is lost by dropping the device's own SD: `toIngestEntry` does not store it.
 */

/** What a block looks like to the UI: a label, the text, and how to render it. */
/** @typedef {{label:string, text:string, lang:string}} Snippet */

const KEY_PLACEHOLDER = '<your collector key>';

/* Where the image actually lives.
 *
 * It said `opscat/collector:latest` until this constant existed, which resolves
 * to nothing: Docker Hub has no such repository and nothing ever pushed one. A
 * snippet the product PRINTS has to name something that can be pulled, or the
 * first thing a customer does with us is watch a command fail.
 *
 * GHCR rather than Docker Hub for one customer-facing reason above all: Docker
 * Hub rate-limits anonymous pulls, and a relay in a customer's network pulls
 * anonymously. `.github/workflows/release.yml` pushes it on a version tag. */
const COLLECTOR_IMAGE = 'ghcr.io/jpj069/opscat-collector';

/* The relay-side queue, identical in every flavour, so an outage is a delay and
 * not a hole. Plain `omfwd` buffers in memory and discards. */
const RSYSLOG_QUEUE = `         queue.type="LinkedList" queue.filename="opscat_fwd"\n`
  + `         queue.maxdiskspace="1g" queue.saveOnShutdown="on"\n`
  + `         action.resumeRetryCount="-1"`;

const SYSLOGNG_BUFFER = `         disk-buffer(mem-buf-size(2000000) disk-buf-size(1000000000) reliable(yes)\n`
  + `                     dir("/var/lib/syslog-ng")));`;

/**
 * The structured-data element carrying the tenant's key, escaped for the
 * template language it is being embedded in.
 *
 * RFC 5424 §6.3.3 escapes `"`, `\` and `]` inside a PARAM-VALUE; a collector
 * key is hex after a four-character prefix, so none of them can occur and the
 * value needs no escaping of its own. The backslashes below belong to rsyslog
 * and syslog-ng, which both need the quotes escaped inside their own strings.
 */
const sdElement = (pen, key, esc) => `[opscat@${pen} token=${esc}"${key}${esc}"]`;

/**
 * @param {{key?:string|null, baseUrl:string, collectorHost?:string, name?:string,
 *          mode?:string, syslogHost?:string, syslogPort?:number, pen?:string}} o
 * @returns {Record<string, Snippet[]>} flavour → blocks, in the order to show them
 */
function snippets(o) {
  const key = o.key || KEY_PLACEHOLDER;
  const base = String(o.baseUrl || '').replace(/\/+$/, '');
  if (o.mode === 'managed') return managed(o, key);
  if (o.mode === 'tunnel') return tunnel(o);
  return collector(o, key, base);
}

/**
 * The tunnel: WireGuard, and then plain syslog inside it.
 *
 * Note what is NOT in these blocks — a key of ours, anywhere. Inside the tunnel
 * the tenant is the inner source address, which the kernel will not let a peer
 * forge, so there is nothing to leak and nothing to rotate on the relay. That is
 * the whole difference from the managed endpoint, and it is why this is the only
 * mode that can accept UDP.
 *
 * The customer's PRIVATE key is a placeholder and stays one. We could generate
 * the pair and show it once — it would be one step shorter and it is what a lot
 * of products do — but then we have held a credential that identifies their
 * relay, and the product's own rule is that a secret a human relays is a design
 * smell. `wg genkey` is one command and it keeps the private half on their box.
 */
function tunnel(o) {
  const net = o.tunnelNet;
  const ip = o.tunnelIp;
  const server = o.tunnelServerIp;
  // Same second-half guard as `managed`: the caller decides whether to offer
  // the mode, and this makes it impossible to render `undefined` as an address.
  if (!net || !ip || !server || !o.tunnelEndpoint || !o.tunnelPubkey) return {};

  return {
    wireguard: [{
      label: '1 · Generate a key pair on the relay',
      lang: 'sh',
      text: `wg genkey | sudo tee /etc/wireguard/opscat.key | wg pubkey\n`
        + `sudo chmod 600 /etc/wireguard/opscat.key\n`
        + `#\n`
        + `# The PUBLIC key it prints is what you paste into OpsCat. The private\n`
        + `# key never leaves this machine — we neither need it nor want it.`,
    }, {
      label: '2 · The tunnel itself',
      lang: 'conf',
      text: `# /etc/wireguard/opscat.conf — then: sudo systemctl enable --now wg-quick@opscat\n`
        + `[Interface]\n`
        + `PrivateKey = <the key from step 1, not the public one>\n`
        + `Address = ${ip}/32\n`
        + `\n`
        + `[Peer]\n`
        + `PublicKey = ${o.tunnelPubkey}\n`
        + `Endpoint = ${o.tunnelEndpoint}\n`
        + `# ONLY our inner address is routed into the tunnel. A wider AllowedIPs\n`
        + `# (0.0.0.0/0) would send this machine's entire traffic through us,\n`
        + `# which is not what you asked for and not what we offer.\n`
        + `AllowedIPs = ${server}/32\n`
        + `# The relay is almost certainly behind NAT; without this the mapping\n`
        + `# expires and we can no longer reach it between messages.\n`
        + `PersistentKeepalive = 25`,
    }],
    rsyslog: [{
      label: 'Point your existing rsyslog relay into the tunnel',
      lang: 'conf',
      text: `# /etc/rsyslog.d/60-opscat.conf — then: systemctl restart rsyslog\n`
        + `#\n`
        + `# UDP, deliberately: inside the tunnel it is as attributable as TCP,\n`
        + `# because the kernel will not carry a packet from an address this\n`
        + `# peer's key does not own. It is also what the appliances behind this\n`
        + `# relay already speak.\n`
        + `if $syslogfacility-text == 'local7' then {\n`
        + `  action(type="omfwd" target="${server}" port="514" protocol="udp"\n`
        + `         # Built-in RFC 5424 template. WITHOUT it rsyslog rewrites\n`
        + `         # HOSTNAME to this relay and every device arrives as one.\n`
        + `         template="RSYSLOG_SyslogProtocol23Format")\n`
        + `}\n`
        + `#\n`
        + `# Prefer TCP where the sender can do it — a queue can only be kept for a\n`
        + `# transport that reports failure, so this is the variant that survives an\n`
        + `# outage rather than dropping through it:\n`
        + `#   action(type="omfwd" target="${server}" port="514" protocol="tcp"\n`
        + `#          template="RSYSLOG_SyslogProtocol23Format"\n`
        + RSYSLOG_QUEUE.split('\n').map((l) => `#  ${l.trim()}`).join('\n') + `)`,
    }],
    verify: [{
      label: 'Check the tunnel before you touch the relay',
      lang: 'sh',
      text: `sudo wg show opscat            # a recent handshake, and bytes both ways\n`
        + `ping -c3 ${server}\n`
        + `#\n`
        + `# One line, straight into the tunnel. It should appear under Logs within\n`
        + `# a few seconds as device "syslog-test".\n`
        + `logger -n ${server} -P 514 -d -t syslog-test "hello from the tunnel"`,
    }],
  };
}

/** The customer runs the collector; the relay talks to it over the LAN. */
function collector(o, key, base) {
  // What the customer types into their relay. Until they have installed the
  // collector they do not know its address, so the placeholder is explicit
  // rather than a plausible-looking example somebody might paste unchanged.
  const host = o.collectorHost || '<collector-ip>';

  return {
    docker: [{
      label: 'Run the collector next to your syslog relay',
      lang: 'sh',
      text: `docker run -d --name opscat-collector --restart always \\\n`
        + `  -p 514:514/udp -p 514:514/tcp -p 6514:6514 \\\n`
        + `  -e OPSCAT_URL=${base} \\\n`
        + `  -e OPSCAT_COLLECTOR_KEY=${key} \\\n`
        + `  ${COLLECTOR_IMAGE}:latest`,
    }],
    systemd: [{
      label: 'Install as a systemd service (no Docker required)',
      lang: 'sh',
      text: `curl -fsSL ${base}/collector/install.sh | sudo \\\n`
        + `  OPSCAT_URL=${base} \\\n`
        + `  OPSCAT_COLLECTOR_KEY=${key} \\\n`
        + `  sh`,
    }],
    rsyslog: [{
      label: 'Point your existing rsyslog relay at the collector',
      lang: 'conf',
      text: `# /etc/rsyslog.d/60-opscat.conf — then: systemctl restart rsyslog\n`
        + `#\n`
        + `# Start with ONE facility, confirm the lines arrive in OpsCat, then widen\n`
        + `# to *.* by removing the "if" below. A relay switched straight to *.*\n`
        + `# can exhaust a daily allowance before anyone has looked at the result.\n`
        + `if $syslogfacility-text == 'local7' then {\n`
        + `  action(type="omfwd" target="${host}" port="514" protocol="tcp"\n`
        + `         # Built-in RFC 5424 template. WITHOUT it rsyslog rewrites\n`
        + `         # HOSTNAME to this relay and every device arrives as one.\n`
        + `         template="RSYSLOG_SyslogProtocol23Format"\n`
        + RSYSLOG_QUEUE + `)\n`
        + `}`,
    }],
    'syslog-ng': [{
      label: 'Point your existing syslog-ng relay at the collector',
      lang: 'conf',
      text: `# /etc/syslog-ng/conf.d/opscat.conf — then: syslog-ng-ctl reload\n`
        + `destination d_opscat {\n`
        + `  syslog("${host}" transport("tcp") port(514)\n`
        + `         # Preserves the original sender, same reason as rsyslog above.\n`
        + `         flags(syslog-protocol)\n`
        + SYSLOGNG_BUFFER + `\n`
        + `};\n`
        + `# Start narrow: filter { facility(local7); } — widen once lines arrive.\n`
        + `log { source(s_src); filter { facility(local7); }; destination(d_opscat); };`,
    }],
  };
}

/** No collector anywhere: the relay talks TLS straight to our gateway. */
function managed(o, key) {
  const host = o.syslogHost;
  const port = o.syslogPort || 6514;
  const pen = o.pen || '0';
  // Nothing to render without a gateway to name. The caller decides whether to
  // offer the mode at all; this is the second half of the same guard, so a
  // misconfigured instance cannot print `undefined` as a hostname.
  if (!host) return {};

  return {
    rsyslog: [{
      label: 'Send from rsyslog straight to OpsCat over TLS',
      lang: 'conf',
      text: `# /etc/rsyslog.d/60-opscat.conf — then: systemctl restart rsyslog\n`
        + `#\n`
        + `# Needs the GnuTLS driver: apt install rsyslog-gnutls  (RHEL: rsyslog-gnutls)\n`
        + `# Without it rsyslog starts, logs "could not load module", and forwards\n`
        + `# nothing — the one failure that looks like a working configuration.\n`
        + `global(DefaultNetstreamDriverCAFile="/etc/ssl/certs/ca-certificates.crt")\n`
        + `\n`
        + `# Reproduces the built-in RFC 5424 template and puts your key in the\n`
        + `# structured data, which is how OpsCat knows whose logs these are.\n`
        + `template(name="OpsCat" type="string"\n`
        + `  string="<%PRI%>1 %TIMESTAMP:::date-rfc3339% %HOSTNAME% %APP-NAME% %PROCID% %MSGID% `
        + sdElement(pen, key, '\\') + ` %msg%\\n")\n`
        + `\n`
        + `# Start with ONE facility, confirm the lines arrive in OpsCat, then widen\n`
        + `# to *.* by removing the "if" below.\n`
        + `if $syslogfacility-text == 'local7' then {\n`
        + `  action(type="omfwd" target="${host}" port="${port}" protocol="tcp"\n`
        + `         template="OpsCat"\n`
        + `         # Verify the server certificate AND that it belongs to this\n`
        + `         # name. StreamDriverMode=1 alone encrypts without checking who\n`
        + `         # is on the other end.\n`
        + `         StreamDriver="gtls" StreamDriverMode="1"\n`
        + `         StreamDriverAuthMode="x509/name" StreamDriverPermittedPeers="${host}"\n`
        + RSYSLOG_QUEUE + `)\n`
        + `}`,
    }],
    'syslog-ng': [{
      label: 'Send from syslog-ng straight to OpsCat over TLS',
      lang: 'conf',
      text: `# /etc/syslog-ng/conf.d/opscat.conf — then: syslog-ng-ctl reload\n`
        + `destination d_opscat {\n`
        + `  syslog("${host}" transport("tls") port(${port})\n`
        + `         tls(peer-verify(required-trusted) ca-dir("/etc/ssl/certs"))\n`
        + `         template("<\${PRI}>1 \${ISODATE} \${HOST} \${PROGRAM} \${PID} \${MSGID} `
        + sdElement(pen, key, '\\') + ` \${MSG}\\n")\n`
        + SYSLOGNG_BUFFER + `\n`
        + `};\n`
        + `log { source(s_src); filter { facility(local7); }; destination(d_opscat); };`,
    }],
    test: [{
      label: 'Prove the path end to end before touching your relay',
      lang: 'sh',
      text: `# One line, straight from any machine with openssl. It should appear\n`
        + `# under Logs within a few seconds as device "syslog-test".\n`
        + `printf '<134>1 %s syslog-test opscat - - ${sdElement(pen, key, '')} hello from openssl\\n' \\\n`
        + `  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\\n`
        + `  | openssl s_client -quiet -connect ${host}:${port} -servername ${host}`,
    }],
  };
}

module.exports = { snippets, KEY_PLACEHOLDER, COLLECTOR_IMAGE };
