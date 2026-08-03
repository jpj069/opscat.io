# Sensor Agents — Gesamtkonzept

**Status: Etappen 0–3 implementiert.** Umgesetzt: die Synthetics-Seite
(Etappe 0), Datenmodell v2 mit Migration (`kind=customer/managed`, `region`,
`sensor_nodes`, `cloud_credentials`, `org_location_access`, `check_locations`;
keine Zeilen = "alle Agents inkl. zukünftiger"), Plan-Matrix
(`managedLocations` 5/10/25/unbegrenzt, `minIntervalS` 60/30/15/15,
`premium_locations`-Feature), BYO-Cloud im Core (AWS-SigV4- und
GCP-JWT-Adapter unter `server/src/providers/`, verschlüsselte
Cloud-Credentials, Provision/Teardown, stündlicher Reconcile-Sweeper,
Node-Cap `OPSCAT_MAX_BYO_NODES`), der New-Sensor-Agent-Wizard
(Managed/AWS/GCP/self, Region→City), Agent-Zuweisung im New-Check-Modal und
die Superadmin-Konsole "Managed sensor fleet" (Platform-Credentials,
Provisionierung mit Visible-Toggle/Pre-Provisioning, Tenant-Zählung,
Teardown). Managed Locations liefern per Probe Key die Union aller buchenden
Orgs. **Offen: Browser-Checks (§ 6, bewusst eigene Etappe)** sowie § 10.
Hinweis: Die AWS/GCP-Adapter sind gegen die API-Spezifikation implementiert,
aber noch nicht gegen echte Cloud-Accounts verifiziert — vor dem Launch einmal
je Provider durchprovisionieren. Dieses Dokument ist die abgestimmte
Grundlage für den Ausbau des Synthetic Monitoring: einheitliche Benennung
("Sensor Agents"), Managed- und BYO-Cloud-Sensoren, Datenmodell v2, Provider-Adapter
(Hetzner/Vultr/AWS/GCP), Plan-Matrix und die Vorbereitung auf Browser-Checks.
Betriebsanleitung der heutigen Sensor-Flotte: `docs/SENSORS.md`.

## 1. Benennung

Der bisherige Begriffs-Mix ("remote probes" im Produkt, "sensors" in der Ops-Doku)
wird vereinheitlicht: **Sensor Agent** ist der Begriff in UI, API-Doku, Marketing und
Code-Kommentaren. Ein Sensor Agent ist der `opscat-agent` im `--probe`-Modus, egal wer
ihn betreibt. Bestehende technische Bezeichner (`synthetic_*`-Tabellen, `--probe`-Flag,
`ocp_`-Keys) bleiben stabil — nur die sichtbare Sprache ändert sich.

## 2. Produktmodell: drei Betriebsarten, ein Agent

| Betriebsart | Wer betreibt | Wer zahlt | Verfügbar in |
|---|---|---|---|
| **Customer** (self-deployed) | Kunde, eigene Hardware/VPS | Kunde (frei, unbegrenzt) | Community + Cloud |
| **BYO-Cloud** (auto-provisioned) | Kunde per hinterlegtem AWS/GCP/Hetzner/Vultr-Key, OpsCat provisioniert | Kunde (seine Cloud-Rechnung) | Community + Cloud |
| **Managed** | OpsCat-Flotte (shared, multi-tenant) | Im Plan enthalten (Kontingent) | EE (OpsCat Cloud) |

Alle drei Betriebsarten nutzen **denselben Agent-Code**. Die Weiche liegt nicht im
Agent, sondern serverseitig im `kind` der Location und im Scoping des Probe Keys.
Ein Sensor Agent bearbeitet **beliebig viele Checks (n:m)** — er zieht seine
Check-Liste vom Server; ein Check kann umgekehrt von mehreren Locations laufen.

Eine bewusste Asymmetrie wird zum Feature: Der SSRF-Guard (keine privaten Ziel-IPs)
gilt zwingend für `local` und `managed`; **Customer-Sensoren dürfen private Ziele
prüfen** — Monitoring hinter der eigenen Firewall ist genau ihr Zweck.

## 3. Datenmodell v2

Heute: `synthetic_locations` (org-gebunden, `kind` = `local`|`remote`),
`synthetic_checks` (laufen implizit überall), `synthetic_results`.

```sql
-- Logische Location: was der Kunde sieht, bucht und wohin Ergebnisse zeigen.
-- Location und physischer Node sind getrennt: "Frankfurt" bleibt stabil, auch
-- wenn der VPS dahinter getauscht wird (Historie + Probe Key wandern mit).
synthetic_locations (
  id, city, cc,
  region          TEXT,             -- Cluster für die UI: 'Europe', 'North America',
                                    -- 'South America', 'Asia-Pacific', 'Middle East & Africa'
  kind            TEXT CHECK (kind IN ('local','customer','managed')),
  org_id          INTEGER,          -- NOT NULL bei local/customer; NULL bei managed
  node_id         INTEGER,          -- FK sensor_nodes bei managed/BYO; NULL bei customer
  is_premium      INTEGER DEFAULT 0,-- Premium Location (Enterprise)
  capabilities    TEXT,             -- JSON, z. B. {"browser": true}
  probe_key_hash, active, last_seen_at, created_at
)

-- NEU: physisches Inventar der provisionierten Boxen (managed + BYO-Cloud).
sensor_nodes (
  id, provider TEXT,                -- 'hetzner'|'vultr'|'aws'|'gcp'
  provider_instance_id TEXT,        -- Join-Schlüssel zum Provider-Inventar
  cloud_credential_id INTEGER,      -- NULL = OpsCat-eigener Key (managed)
  region_code TEXT, ip TEXT,
  instance_class TEXT,              -- Standard vs. browser-fähig (mehr RAM)
  capabilities TEXT,                -- JSON, gespiegelt an die Location
  agent_version TEXT,
  status TEXT CHECK (status IN ('provisioning','online','draining','dead')),
  monthly_cost_cents INTEGER, created_at
)

-- NEU: verschlüsselte Cloud-Zugänge für BYO (und intern für die Managed-Flotte).
cloud_credentials (
  id, org_id,                       -- NULL = OpsCat-System-Credential
  provider TEXT,
  label TEXT, key_ciphertext BLOB,  -- AES-256-GCM, Master-Key aus dem Env
  key_hint TEXT,                    -- z. B. letzte 4 Zeichen, für die UI
  created_by, created_at, last_used_at
)

-- NEU: welche Org welche Managed Location nutzt (Plan-Kontingent oder Add-on).
org_location_access (
  org_id, location_id,
  source TEXT CHECK (source IN ('plan','addon')), created_at,
  PRIMARY KEY (org_id, location_id)
)

-- NEU: welcher Check läuft von welcher Location (heute implizit "überall").
check_locations (
  check_id, location_id,
  PRIMARY KEY (check_id, location_id)
)

-- unverändert; meta erhält optional agent_version und (später) artifactRef.
synthetic_results (check_id, location_id, ts, ok, latency_ms, meta)
```

**Migration:** Bestehende `kind='remote'`-Locations werden `kind='customer'`;
für jeden bestehenden Check wird `check_locations` mit allen bisher aktiven
Locations seiner Org befüllt (Verhalten bleibt identisch).

**Key-Scoping:** Der Probe Key bleibt an der Location. Für `managed` Locations
liefert `GET /v1/synthetics/checks` die Checks aller Orgs, die die Location per
`org_location_access` gebucht und per `check_locations` zugewiesen haben — der
Agent merkt davon nichts, die Liste wird nur länger. Ergebnisse bleiben über
`check_id → org_id` sauber getrennt.

**Kein Container pro Org auf Shared-Nodes:** Die Check-Typen sind
OpsCat-eigener, vertrauenswürdiger Code; Kunden liefern nur validierte Daten.
Per-Org-Container brächten keine relevante Isolation (gleiche IP, gleicher
Kernel), aber ~50–80 MB RAM pro Org und n-fachen Update-Aufwand. Noisy-Neighbor
wird serverseitig gelöst (Kapazitätsbudget pro Org und Location im Scheduler).
Die Frage stellt sich neu bei Browser-Checks — dann pro *Ausführung*, nicht pro Org
(siehe § 6).

## 4. Provider-Adapter + BYO-Cloud

Einheitliches Adapter-Interface (Erweiterung von `provisioning.js`):

```
createInstance({ region, instanceClass, userData }) -> { providerInstanceId, ip }
destroyInstance(providerInstanceId)
listInstances(tagFilter) -> [{ providerInstanceId, labels, ... }]
```

**Erste Welle: nur AWS + GCP.** Hetzner/Vultr werden aus der kundensichtbaren
Provider-Auswahl entfernt — mit OpsCat Managed, AWS und GCP ist die Abdeckung
ausreichend; die vorhandenen Hetzner/Vultr-Adapter bleiben als interne Option
für die Managed-Flotte erhalten, tauchen aber im Wizard nicht auf.

| Provider | API-Stil | Auth | Aufwand |
|---|---|---|---|
| **AWS (EC2)** | REST + **SigV4-Signing** | Access-Key-ID + Secret | ~100 Zeilen mit Node-`crypto`, kein SDK |
| **GCP (GCE)** | REST + **OAuth2-JWT** (Service Account) | SA-JSON | ~100 Zeilen mit Node-`crypto`, kein SDK |
| Hetzner / Vultr | REST | Token-Header | vorhanden — nur intern (Managed-Flotte), nicht im Kunden-Wizard |

Dasselbe cloud-init-Template (`deploy/sensors/cloud-init.yaml.tmpl`) wird überall
verwendet (EC2 `UserData`, GCE `user-data`).

**Abdeckung.** `CATALOG` führt die volle kommerzielle Fläche beider Anbieter:
**AWS 33** (34 laut AWS-Tabelle, minus Bahrain — siehe unten) und **GCP 43**,
zusammen 76 Einträge auf 55 verschiedene Städte. Gegen die Anbietertabellen
verifiziert (`aws-regions.md`, GCP `regions-zones`), nicht aus dem Gedächtnis.
16 der AWS-Regionen sind **Opt-in** und müssen pro Konto freigeschaltet werden,
bevor ein Launch dort gelingt; sie tragen `optIn: true` und werden im Wizard
markiert. GCP kennt das nicht — dort genügt hinterlegtes Billing.

**Warum eine Location je Region und nicht je Availability Zone.** AZs innerhalb
einer Region liegen im selben Ballungsraum an derselben Egress-Strecke, meist
unter 100 km auseinander. Für einen Messpunkt heißt das: eine zweite AZ in
`eu-central-1` kostet einen weiteren Node und misst dasselbe. Der Katalog bleibt
deshalb bewusst regionsgranular — der Adapter landet ohnehin in genau einer Zone
(GCP fest `<region>-b`, AWS im Default-Subnetz). AZ-Granularität wäre erst
interessant, wenn wir Ausfälle *einzelner* AZs eines Kunden messen wollten, und
das ist ein anderes Produkt als geografische Nutzerabdeckung.

**Credential-Handling (BYO):**

- Speicherung ausschließlich verschlüsselt (AES-256-GCM, Master-Key aus dem Env);
  API-Responses zeigen nur Label + Hint, niemals das Secret. Kein Logging.
- Doku liefert **Minimal-Policies** mit: AWS-IAM nur
  `ec2:RunInstances/TerminateInstances/DescribeInstances` (tag-beschränkt auf
  `opscat-sensor`), GCP Custom Role nur `compute.instances.create/delete/list`.
- Audit-Log-Eintrag bei jedem Provisioning-/Teardown-Call.

**AWS: Minimal-IAM-Policy (verifiziert gegen `server/src/providers/aws.js`).**
Diese Policy an einen dedizierten IAM-User (z. B. `opscat-sensor-provisioner`)
hängen und dessen Access-Key in OpsCat hinterlegen. Launch *und* Terminate sind
über das Tag `opscat-sensor` eingegrenzt — der Key kann keine fremden Instanzen
anfassen. `ec2:DescribeImages` ist Pflicht, weil der Adapter das aktuelle
Ubuntu-24.04-AMI je Region selbst auflöst; `ec2:CreateTags` ist auf
`ec2:CreateAction = RunInstances` beschränkt, deckt also nur das Taggen beim
Start ab.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Discover", "Effect": "Allow", "Resource": "*",
      "Action": ["ec2:DescribeImages", "ec2:DescribeInstances",
                 "ec2:DescribeInstanceStatus", "ec2:DescribeInstanceTypes",
                 "ec2:DescribeRegions", "ec2:DescribeVpcs",
                 "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups"] },
    { "Sid": "LaunchInfrastructure", "Effect": "Allow", "Action": "ec2:RunInstances",
      "Resource": ["arn:aws:ec2:*::image/ami-*", "arn:aws:ec2:*:*:subnet/*",
                   "arn:aws:ec2:*:*:security-group/*",
                   "arn:aws:ec2:*:*:network-interface/*",
                   "arn:aws:ec2:*:*:volume/*", "arn:aws:ec2:*:*:key-pair/*"] },
    { "Sid": "LaunchTaggedInstanceOnly", "Effect": "Allow",
      "Action": "ec2:RunInstances", "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringEquals": { "aws:RequestTag/opscat-sensor": "1" } } },
    { "Sid": "TagOnLaunch", "Effect": "Allow", "Action": "ec2:CreateTags",
      "Resource": "arn:aws:ec2:*:*:*",
      "Condition": { "StringEquals": { "ec2:CreateAction": "RunInstances" } } },
    { "Sid": "TerminateOwnSensorsOnly", "Effect": "Allow",
      "Action": "ec2:TerminateInstances", "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": { "StringEquals": { "aws:ResourceTag/opscat-sensor": "1" } } }
  ]
}
```

**Opt-in-Regionen.** Fünf Regionen des AWS-Katalogs (`server/src/providers/index.js`)
sind in einem frischen AWS-Account deaktiviert und müssen unter *Account → AWS
Regions* einzeln aktiviert werden: Zürich (`eu-central-2`), Jakarta
(`ap-southeast-3`), UAE (`me-central-1`), Kapstadt (`af-south-1`), Tel Aviv
(`il-central-1`). AWS serialisiert das Aktivieren — solange eine Region im Status
*Enabling* steht, laufen weitere Anfragen in "An error occurred while processing
your request". Der Wizard sollte einen `OptInRequired`-Fehler des Adapters
entsprechend übersetzen.

Beim Aktivieren antwortet die Region übergangsweise mit
`401 – AWS was not able to validate the provided access credentials`, obwohl der
Key gültig ist: der regionale Endpoint kennt ihn erst nach der Propagierung. Diese
Meldung darf im UI nicht als "falscher Key" durchgereicht werden, sonst rotieren
Nutzer grundlos ihre Credentials.

**Aktivierung ≠ Erreichbarkeit.** `DescribeRegions` kann eine Region als
`opted-in` melden, während ihr API-Endpoint vom Control-Plane-Host trotzdem nicht
erreichbar ist. Genau das trat bei Bahrain (`me-south-1`) auf: account-seitig
aktiviert, aber TCP/443 lief von zwei voneinander unabhängigen Netzen auf beide
per DNS gelieferten IPs in einen Timeout. Die Region ist deshalb vorerst aus dem
Katalog genommen. Vor dem Wiederaufnehmen einer Region gehört ein Erreichbarkeits-
Check vom Control-Plane-Host dazu — eine Managed Location anzubieten, deren
Provider-API wir nicht erreichen, erzeugt nur garantiert scheiterndes Provisioning.

**Kostenschutz (Launch-Voraussetzung, nicht Nice-to-have):** Bei BYO läuft ein
geleakter Node auf der *Kundenrechnung*.

- Reconcile-Job: Provider-Inventar (Tag `opscat-sensor` + `opscat-location:<id>`)
  gegen DB; verwaiste Boxen werden zerstört, tote DB-Einträge markiert.
- Harte Caps: max. Nodes pro Org, pro Provider, pro Region (Config).
- Teardown-Reihenfolge wie gehabt: erst Key revoken (Location löschen), dann VM.

## 5. Edition-Schnitt (Open Core)

| Baustein | Edition |
|---|---|
| Provider-Adapter, `cloud_credentials` (BYO), Provision/Teardown-UI, Reconcile-Job | **CE (Core)** |
| Managed-Flotte (OpsCat-Keys, `org_location_access`), Plan-/Billing-Anbindung, Premium Locations | **EE** |

Das Provisioning wandert dafür aus `server/src/ee/provisioning.js` in den Core;
die Exclusion-Liste in `docs/OPEN-CORE.md` ist entsprechend zu aktualisieren.
Community-Nutzer hinterlegen ihren Cloud-Key und provisionieren selbst ("BYO");
die EE (OpsCat Cloud) nutzt exakt denselben Code mit OpsCat-System-Credentials.

## 6. Browser-Checks (vorbereitet, nicht gebaut)

Ab Browser-Checks läuft erstmals **Kunden-Payload** (Playwright-Skripte) auf
Sensor Agents. Jetzt schon im Design verankert:

1. **Capabilities:** `sensor_nodes.capabilities` / `synthetic_locations.capabilities`
   (z. B. `{"browser": true}`). Browser-fähige Nodes brauchen eine größere
   Instanzklasse (Chromium ⇒ 2+ GB RAM, z. B. Hetzner `cpx21`). Die Zuweisung in
   `check_locations` validiert Capability gegen Check-Typ.
2. **Runner-Registry:** `synthetic_checks.type` erhält später `'browser'`; die
   bestehende `RUNNERS`-Map (Server und Agent) wird nur erweitert, nicht umgebaut.
3. **Sandbox-Prinzip:** Kunden-Payload läuft pro *Ausführung* in einem
   Wegwerf-Container — kein `CAP_NET_RAW` darin, Egress-Filter (kein Zugriff auf
   das Sensor-interne Netz), harte CPU-/RAM-/Zeit-Limits. Der Kern-Agent bleibt
   dependency-frei und orchestriert nur. Docker kommt dafür mit ins cloud-init.
4. **Artefakte:** Screenshots/Traces sprengen das 4-KB-`meta`-Cap von
   `synthetic_results` — dafür später ein Artifact-Upload (Objektspeicher),
   im Schema als `meta.artifactRef` vorgesehen.

Browser-Checks sind in **allen Plänen** enthalten (siehe § 7).

## 7. Plan-Matrix

| Limit | Free | Team | Pro | Enterprise |
|---|---|---|---|---|
| Eigene Sensor Agents (customer + BYO) | **unbegrenzt** | unbegrenzt | unbegrenzt | unbegrenzt |
| Managed Locations (wählbar aus allen Standard-Locations) | **5** | **10** | **25** | **unbegrenzt** |
| Premium Locations | – | – | – | **✓** |
| Browser-Checks | ✓ | ✓ | ✓ | ✓ |
| Min. Check-Intervall (`minIntervalS`) | 60 s | 30 s | 15 s | 15 s |

Eigene Sensoren sind bewusst unlimitiert — es ist nicht unsere Workload, und es
ist das stärkste Community-Argument. Monetarisiert werden Komfort (Managed-Flotte)
und Reichweite (Premium Locations, z. B. exotische Regionen mit teureren Nodes).

Durchsetzung an drei Stellen: beim Anlegen/Ändern von Checks (Intervall-Untergrenze
wird plan-abhängig statt fix 15 s in `routes/synthetics.js`), bei der Buchung von
Managed Locations (`org_location_access` gegen Plan-Kontingent) und defensiv im
Scheduler. `plans.js`-Limits: `sensors` entfällt zugunsten `managedLocations`;
neu `minIntervalS`, `premiumLocations` (bool).

### Seitenstruktur `/app/synthetics`

Die bestehende Synthetics-Seite bekommt zwei Tabs; der Menüpunkt bleibt einer:

- **Tab "Checks" (Default):** die heutige Sicht — Checks auf Targets/Assets.
  Tabelle pro Target mit Check-Typ-Badges (je Typ ein Pass/Fail-Dot), "Runs on"
  (zugewiesene Sensor Agents), Intervall, Status. Darunter eine
  **Ergebnis-Matrix Target × Sensor Agent** (Zeilen = Check-Typen, Spalten =
  Agents, Zellen = Latenz/Status) plus Latenz-Chart. CTA rechts oben:
  "+ New check".
- **Tab "Sensor Agents":** Flotten-Sicht der Org (Karten + Tabelle) mit dem
  Deploy-Wizard. CTA rechts oben wechselt zu "+ New Sensor Agent".

Die zwei Flows sind bewusst getrennt: *Agents deployen* (selten, Infrastruktur)
und *Checks anlegen* (häufig, Monitoring-Alltag).

**Informationsdichte der Checks-Tabelle** (statt nur einer Status-Pill):

- **Uptime-Heat-Bar (`HeatBar`)** pro Zeile — **entschieden**: Segmente sind
  flex-Elemente (Leiste füllt immer dieselbe Breite), Bucket-Anzahl ~30 mit
  natürlichen Einheiten pro Range:

  | Range | Bucket | Anzahl |
  |---|---|---|
  | 30min / 1h / 6h / 12h | 1 / 2 / 12 / 24 min | 30 |
  | 24h | 45 min | 32 |
  | 7d | 6 h (= Schichtgrenzen 00/06/12/18) | 28 |
  | 30d | 1 Tag | 30 |

  Anzahl schwankt nur 28–32 (±7 % Segmentbreite — optisch nicht wahrnehmbar).
  Aggregation **worst-status-wins** pro Bucket (nie mitteln — kurze Ausfälle
  dürfen in großen Buckets nicht verschwinden), Grau = keine Daten, Tooltip
  mit Bucket-Zeitfenster + Uptime-%. (Verworfene Iterationen: fixe 48; exakt
  fixe 30.)
- **Agents-Spalte adaptiv:** bis 6 Agents ein Dot-Strip (ein Punkt pro Agent),
  darüber eine **Ratio-Pill** ("31/31" grün, "29/31 · SIN, BOM" rot) — bei
  30+ Agents zählt "wie viele/wo failing", nicht 31 Punkte. Für die
  Detail-Ansicht (Flyout) bei vielen Agents: **`StatusGrid`** (Waffle-Grid,
  1 Quadrat = 1 Agent, GitHub-Contribution-Stil, hover = Name, Klick =
  Filter); Honeycomb/Hexagons als Wallboard-Variante geprüft, aber Waffle ist
  die pragmatische Wahl (einfacher zu bauen und zu beschriften).
- **Uptime-%** (Zeitraum folgt dem 24h/7d/30d-Umschalter) und **p50-Latenz**
  mit Mini-Sparkline (`Spark`-Komponente existiert).
- **`StatusBadge`** (neue Komponente in `web/src/ui.tsx`): Check-Typ-Label mit
  Status-Dot in der Checks-Spalte.
- Status-Pill mit **Dauer** ("failing 12m") und Teilausfall-Hinweis
  ("1 of 2 agents ok"); failing-Zeilen leicht rot hinterlegt.
- **Filter-Cards** über der Liste (statt Text-Summary-Strip): All / Passing /
  Degraded / Failing / Paused als klickbare Karten mit Zähler — Klick filtert
  die Liste. Cert-Warnungen erscheinen nicht als Badge in der Tabelle
  (verworfen), sondern nur als eigenes Event (`tls_cert_expiring`, existiert).

Layout-Entscheidung offen — drei Varianten im UI-Konzept-Canvas: **A** dichte
Tabelle (eine Zeile pro Target), **B** gruppiert nach Target mit einer Zeile
pro Check-Typ (eigene Heat-Bar je Check), **C** Karten-Grid.

**Check-Detail = Flyout (Slide-over), keine eigene Page.** Das
`.slide-over`-Pattern (520–560 px) existiert bereits in `tokens.css`; die
Tabelle bleibt als Kontext sichtbar, Pfeiltasten können durch Checks blättern,
Deep-Link per Query-Param (`/app/synthetics?check=<id>`). Inhalt: Header mit
Aktionen (Run now, Edit, Pause, Create incident), Uptime-Stats (24h/7d/30d,
p50/p95), 30-Tage-Heat-Bar, **By-sensor-agent-Tabelle** (letztes Ergebnis +
Fehlerdetail pro Agent), Latenz-Chart pro Agent, Recent Events (verlinkt auf
Cases), Konfigurations-Block. Eine eigene Page wird erst mit Browser-Checks
nötig (Screenshots/Traces/Waterfall) — das Flyout bekommt dann einen
"open full page"-Link, der Rest bleibt.

### UI-Flow: "New check"

Ein Formular, drei Abschnitte — bildet direkt das n:m-Datenmodell ab:

1. **Target** — URL/Host/`host:port` + optionaler Name, alternativ Verknüpfung
   mit einem bestehenden Asset.
2. **Checks to run** — Multi-Select der Check-Typen (http, icmp, dns, tcp,
   traceroute, browser). Ein Target kann mehrere Typen gleichzeitig bekommen;
   pro gewähltem Typ entsteht ein `synthetic_checks`-Eintrag.
   Typ-Details (HTTP-Assertions etc.) wie heute nach dem Anlegen.
3. **Run from these sensor agents** — Multi-Select über die Agents der Org
   (mit Kind-Badge, Region/City, Live-Latenz) plus Schalter
   **"all agents (incl. future)"** (= keine expliziten `check_locations`-Zeilen,
   Checks laufen automatisch auch auf später deployten Agents). Inline-Link
   "+ Deploy new sensor agent…" springt in den Agents-Tab. Browser-Checks sind
   nur auf browser-fähigen Agents wählbar; private Targets nur auf self-hosted.

Fußzeile rechnet live vor: "3 checks × 3 agents = 9 series · every 60s" —
danach Intervall/Timeout und Create.

### UI-Flow: "New Sensor Agent" (Wizard)

Einstieg rechts oben im Tab "Sensor Agents". Zwei Schritte:

**Schritt 1 — Provider wählen:**

1. **OpsCat Managed Sensor** — mit Kontingent-Anzeige "x / x in use";
   in der CE sichtbar, aber deaktiviert ("not available in OpsCat CE").
2. **AWS hosted** — Key-Status inline ("key configured" / "set key in Settings";
   ohne Key nicht wählbar, Verweis auf Settings → Cloud credentials).
3. **GCP hosted** — analog AWS.
4. **Self hosted** — immer verfügbar; statt Location-Picker: Name + optionale
   Region/City-Zuordnung (für Karte/Gruppierung) + Install-Snippet; der Probe
   Key wird nach dem Anlegen genau einmal angezeigt.

**Schritt 2 — Location wählen (zweistufig Region → City):** Erst Region
(`Europe`, `North America`, `South America`, `Asia-Pacific`,
`Middle East & Africa`), dann City innerhalb der Region. Bei AWS/GCP steht am
City-Eintrag der Provider-Region-Code (z. B. `eu-central-1`); bei Managed sind
Premium-Cities für Nicht-Enterprise sichtbar, aber gesperrt (Upgrade-Hinweis).
Kontingent-Zähler läuft live mit ("uses 1 of 3 remaining slots").

### Superadmin: Managed-Flotte ("Platform › Managed Fleet")

Die OpsCat-Plattform-Keys (AWS + GCP) liegen ausschließlich hier. Kunden sehen
von alledem nur das Ergebnis — die Location-Auswahl in Schritt 2 des Wizards.
Aufbau der Konsole:

- **KPI-Zeile:** Locations (online/provisioning/draining), Fleet-Load
  (kapazitätsgewichtete Check-Runs/min), Tenants using, Cloud-Kosten/Monat
  gegen Budget-Cap, Reconcile-Status (Orphans, letzter Lauf).
- **Platform cloud credentials:** die AWS/GCP-Plattform-Keys (verschlüsselt,
  nur Label + Hint, rotierbar).
- **Fleet-Tabelle:** pro Location City/Region, Backing (Provider +
  Provider-Region + Instanzklasse), Agent-Version, Status
  (`provisioning`/`online`/`draining`/`dead`), Tenants using, Load-Balken,
  **Visible-Toggle** und Aktionen (`scale`, `drain`, `replace node`, `cancel`).
- **Provision-Modal:** City/CC, Region (Picker-Gruppierung), Backing-Provider +
  Provider-Region, Instanzklasse, Premium-Flag, "Visible to tenants immediately".
  Unter der Instanzklasse steht, was ein zusätzlicher Node kostet — gespeist aus
  `COST_ESTIMATES` in `server/src/providers/index.js` und über
  `GET /api/synthetics/provider-catalog` (`costEstimates`, `instanceTypes`)
  ausgeliefert:

  | Klasse | AWS | GCP |
  |---|---|---|
  | `standard` | `t3.small` — ~21 $/Monat | `e2-small` — ~15 $/Monat |
  | `browser` | `t3.medium` — ~37 $/Monat | `e2-medium` — ~28 $/Monat |

  Listenpreis für eine mittelpreisige Region (Frankfurt) über 730 h, **inklusive
  Boot-Disk und öffentlicher IPv4** — letztere kostet bei AWS allein ~3,65 $/Monat
  und wird gern vergessen. US-Regionen liegen darunter, São Paulo und Sydney
  darüber; GCP rechnet Sustained-Use-Rabatte automatisch an. Bewusst eine Zahl je
  Provider/Klasse statt einer Regionstabelle — mehr Genauigkeit würden die Werte
  nicht hergeben. Bei Preisänderungen der Provider nachziehen.

**Vorfeld vs. on-demand:** Der Visible-Toggle entkoppelt Provisionierung und
Sichtbarkeit. Aus = **Pre-Provisioning**: der Node bootet, registriert sich und
reportet, erscheint aber erst im Kunden-Picker, wenn der Toggle umgelegt wird
(Launch einer Region erst nach Verifikation). On-demand ist derselbe Flow mit
Toggle direkt an. `drain` nimmt eine Location aus dem Picker, lässt bestehende
Zuweisungen aber weiterlaufen, bis Tenants migriert sind; `replace node` tauscht
den VPS unter einer stabilen Location (Historie + Probe Key bleiben).

Betriebs-Leitplanken (aus `docs/SENSORS.md` übernommen): Caps pro Location und
gesamt, Budget-Alarm, Teardown revoked den Probe Key vor der VM-Zerstörung,
Orphan-Sweeper joined das Provider-Tag `opscat-location:<id>` gegen die DB.

## 8. API-Änderungen (Session-API, `/api/synthetics`)

- `GET /locations` liefert zusätzlich `kind`, `isPremium`, `capabilities`,
  `booked` (managed) und `agentVersion`.
- `POST /locations` (customer) bleibt; neu `POST /locations/provision`
  (BYO: `{provider, region, credentialId, name}`) und
  `POST /locations/:id/book` / `DELETE /locations/:id/book` (managed, EE).
- Neu `GET|POST|DELETE /cloud-credentials` (nur Label + Hint in Responses;
  UI-seitig unter Settings → Cloud credentials, nicht im Wizard).
- Neu (Superadmin, EE): `GET|POST|DELETE /api/superadmin/managed-locations`
  — provisioniert Managed Locations mit den OpsCat-Plattform-Keys inkl.
  Region/City, Backing-Provider und Premium-Flag; liefert Tenant-Nutzung.
- `POST /checks` + `PATCH /checks/:id` akzeptieren `locationIds[]`
  (Default: alle gebuchten/eigenen Locations); Intervall-Clamp plan-abhängig.
- `/v1/synthetics/checks` (Probe-Key-Auth): für `managed` Locations Union der
  zugewiesenen Checks aller buchenden Orgs; Report-Payload erhält `agentVersion`.

## 9. Rollout-Etappen

1. **Schema v2 + Umbenennung** — Migration, `check_locations`, UI-Wording
   "Sensor Agents", Plan-Limits (`managedLocations`, `minIntervalS`).
2. **BYO-Cloud (Core)** — `cloud_credentials`, AWS/GCP-Adapter, Provision-UI,
   Reconcile-Job + Caps. Community-Launch-Feature.
3. **Managed-Flotte (EE)** — Standard-Locations aus `docs/SENSORS.md`-Backbone,
   Buchungs-UI mit Kontingenten, Premium Locations.
4. **Browser-Checks** — Sandbox-Runner, browser-fähige Node-Klasse,
   Artifact-Storage.

## 10. Offene Punkte

- Preis je Premium Location (Add-on vs. Enterprise-only, § 7 nimmt Enterprise-only an).
- Gcore/Fly.io als weitere Adapter (Fly: `CAP_NET_RAW`/ICMP in microVMs prüfen).
- Kapazitätsbudget-Formel pro Org auf Shared-Nodes (Checks × Frequenz je Location).
- Agent-Self-Update-Kanal für die Managed-Flotte.
