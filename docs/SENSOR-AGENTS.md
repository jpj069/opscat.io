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
`OPSCAT_PROBE_KEY`) bleiben stabil — nur die sichtbare Sprache ändert sich.

**Korrektur (2026-08):** Der Key-Prefix stand ursprünglich mit in dieser Liste
(`ocp_` "bleibt stabil"). Das war der falsche Eimer. Ein Tabellenname ist intern,
ein Flag ist intern — **ein Credential, das ein Mensch kopiert, ist es nicht**: es
steht in einer systemd-Env-Datei, in einem Support-Ticket und in der Regel eines
Secret-Scanners. Neue Keys heißen deshalb **`ocs_`** (Sensor). Bestehende `ocp_`-Keys
bleiben unbegrenzt gültig, ohne Migration und ohne Dual-Accept-Zweig: authentifiziert
wird ausschließlich über `sha256(token)`, der Prefix ist ein Etikett auf neu
erzeugten Secrets. Die ganze Namensraum-Tabelle steht in `server/src/lib/tokens.js`.

`ocsa_` wäre die naheliegende Wahl gewesen und ist genau deshalb keine: `och_` ist
bereits der Heartbeat-Token, und `ocha_` würde von jeder auf `och_` verankerten
Regel mitgetroffen. Die Regel lautet `oc` + **ein** Buchstabe + `_`.

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

-- Welcher Check läuft von welcher Location. Die Zuordnung ist EXPLIZIT: ein
-- leerer Zeilensatz war einmal "überall, auch auf später gebuchten Agents" und
-- ist seit Migration 034 nur noch ein Notfall-Fallback (siehe unten).
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

**„Alle Agents" heißt die Fleet von heute, nicht die von morgen.** Der Schalter
hieß einmal *all agents (incl. future)* und meinte es wörtlich: der Check wurde
mit *keiner* `check_locations`-Zeile gespeichert, und `runsOnLocation()` liest
einen leeren Zeilensatz als „überall". Das Ergebnis war, dass das Buchen einer
Managed Location **jeden bestehenden Check der Org** stillschweigend daran
hängte — eine Node auf einem anderen Kontinent fängt an zu kosten, und jede
Uptime- und Latenzreihe der Org bekommt einen zusätzlichen Messpunkt, ohne dass
jemand etwas angeklickt hat.

`setCheckLocations()` schreibt die Fleet jetzt beim Anlegen aus; Migration 034
füllt die Bestandschecks mit genau den Locations, auf denen sie in dem Moment
liefen, sodass sich kein Check verschiebt — er erbt nur die Zukunft nicht mehr.

Der leere Zeilensatz bleibt in `runsOnLocation()` als **Fallback** stehen und
das ist Absicht: Ein Check, der *nirgends* läuft, meldet nichts, alarmiert nicht
und sieht dabei exakt aus wie ein gesunder. Von den beiden möglichen Fehlern ist
das mit Abstand der schlechtere.

**Ein HTTP-Target ist kanonisch, bevor es gespeichert wird.** Jemand tippt
`link11.com` — ein völlig sinnvolles Monitoring-Ziel und keine URL. Irgendwas
muss das Schema ergänzen, und lange taten das ZWEI Stellen unterschiedlich: die
In-Process-Probe stellte `https://` voran, der Sensor Agent rief `fetch(target)`
direkt auf und undici antwortete `TypeError: Failed to parse URL from
link11.com`. Derselbe Check war aus Nürnberg grün und aus N. Virginia und Los
Angeles rot — mit einer Meldung über UNSEREN Parser an der Stelle, an der der
Kunde „läuft meine Seite?" liest.

`util.httpTarget()` ist jetzt die einzige Regel; Create und PATCH gehen beide
hindurch, und Migration 038 backfillt die Bestandszeilen. Das ist auch, was die
**bereits ausgerollten Agents** repariert: sie lesen das Target aus der
Work-List, eine kanonische Zeile heilt sie also ohne Agent-Update. Ergänzt wird
nur das Schema — ein anders kaputtes Target (`https://` ohne Host) bleibt stehen
und sichtbar rot, statt still in einen anderen Check umgeschrieben zu werden.

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
  Mit Break-glass-SSH (§11) kommen auf beiden Seiten Firewall-Rechte dazu —
  siehe die Policy unten und den GCP-Abschnitt daneben.
- Audit-Log-Eintrag bei jedem Provisioning-/Teardown-Call.

**AWS: Minimal-IAM-Policy (verifiziert gegen `server/src/providers/aws.js`).**
Diese Policy an einen dedizierten IAM-User (z. B. `opscat-sensor-provisioner`)
hängen und dessen Access-Key in OpsCat hinterlegen. Launch *und* Terminate sind
über das Tag `opscat-sensor` eingegrenzt — der Key kann keine fremden Instanzen
anfassen. `ec2:DescribeImages` ist Pflicht, weil der Adapter das aktuelle
Ubuntu-24.04-AMI je Region selbst auflöst; `ec2:CreateTags` ist auf
`ec2:CreateAction = RunInstances` beschränkt, deckt also nur das Taggen beim
Start ab.

<!-- policy:aws -->
```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Discover", "Effect": "Allow", "Resource": "*",
      "Action": ["ec2:DescribeImages", "ec2:DescribeInstances",
                 "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups"] },
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
      "Condition": { "StringEquals": { "aws:ResourceTag/opscat-sensor": "1" } } },
    { "Sid": "BreakGlassSshGroup", "Effect": "Allow",
      "Action": ["ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress",
                 "ec2:RevokeSecurityGroupIngress"],
      "Resource": ["arn:aws:ec2:*:*:security-group/*", "arn:aws:ec2:*:*:vpc/*"] }
  ]
}
```

**`BreakGlassSshGroup` wird nur gebraucht, wenn §11 aktiv ist** — ohne
`sensor_ssh_key`/`sensor_ssh_cidrs` ruft der Adapter `ensureSshAccess()` gar
nicht auf. Wer kein Break-glass-SSH will, lässt das Statement weg.

**Die neun Actions sind exakt die, die `aws.js` aufruft — das prüft jetzt der
Build.** `server/scripts/check-cloud-policy.js` (`npm run check:cloud`, in CI)
liest die `Action:`-Literale aus dem Adapter und diffed sie gegen genau diesen
JSON-Block; der HTML-Anker `<!-- policy:aws -->` darüber ist, woran das Skript
ihn findet. Beide Richtungen sind rot: ein Aufruf ohne Grant *und* ein Grant
ohne Aufruf.

Die zweite Richtung hat gleich vier Zeilen gekostet — `ec2:DescribeRegions`,
`DescribeSubnets`, `DescribeInstanceTypes` und `DescribeInstanceStatus` standen
hier und wurden von nichts aufgerufen: der Regions-Katalog ist eine Tabelle in
`providers/index.js`, keine API-Abfrage. Harmlose Lesezugriffe, aber in einer
Policy, deren ganzer Verkaufspunkt „minimal" ist, gehören sie nicht. Eine
bestehende Installation mit der breiteren Fassung läuft unverändert weiter —
wer aufräumen will, ersetzt das `Discover`-Statement.

`ec2:CreateTags` ist der umgekehrte Fall und steht als begründete Ausnahme in
`GRANTED_UNUSED` im Skript: es ist kein eigener API-Call, sondern das, was EC2
für die `TagSpecification` an `RunInstances` prüft — ohne das Recht scheitert
der *Launch*, nicht das Taggen.

Dieses Statement fehlte, und das ist teuer bezahlt worden: die Policy oben war
gegen den Adapter *vor* §11 verifiziert, und §11 wurde in einem anderen
Abschnitt ergänzt, ohne sie anzufassen. In Produktion sah das so aus — die
Provisionierung schlug erst zu, als die Settings gesetzt waren, mit

```
aws HTTP 403: … not authorized to perform: ec2:CreateSecurityGroup
```

und rollte sauber zurück. **Die Lehre ist dieselbe wie bei Migration +
`schema.sql`: ein Feature und seine Berechtigungen gehören in denselben
Commit.** Eine Policy, die gegen eine ältere Fassung des Adapters verifiziert
wurde, ist ab dem nächsten neuen API-Call falsch, und nichts im Build merkt es.

**Es ist bewusst weiter gefasst als der Rest der Policy.** `CreateSecurityGroup`
lässt sich nicht auf „nur die Gruppe, die wir gleich anlegen" einschränken, weil
es die Gruppe erst erzeugt, und `Authorize/Revoke` sind hier auf jede
Security-Group des Accounts erlaubt statt nur auf `opscat-sensor-ssh`. Eng
ziehen ließe sich das mit `TagSpecification` beim Create plus einer
`aws:ResourceTag`-Condition auf den beiden Ingress-Calls — das setzt aber
voraus, dass `ensureSshAccess()` die Gruppe taggt, was es heute nicht tut.
Solange das offen ist: ein **dedizierter** IAM-User pro Installation, nie ein
geteilter.

**GCP: die Firewall-Rechte für §11.** Die Custom Role für den Service Account
braucht neben `compute.instances.create/delete/list` zusätzlich
`compute.firewalls.get`, `compute.firewalls.create`, `compute.firewalls.update`
und `compute.networks.updatePolicy` — `ensureSshAccess()` macht ein GET auf
`/global/firewalls/opscat-sensor-ssh`, ein POST, wenn es die Regel nicht gibt,
und ein PATCH, wenn die Ranges abweichen. Die Regel adressiert Instanzen über
das Tag `opscat-sensor`, nicht über IP-Bereiche.

**Verifiziert am 2026-08-27**, und zwar auf die unangenehme Art: die erste echte
GCP-Provisionierung mit gesetztem `sensor_ssh_key` kam mit

```
gcp HTTP 403: Required 'compute.firewalls.create' permission for
'projects/opscat-sensors/global/firewalls/opscat-sensor-ssh'
```

zurück und rollte sauber zurück. Der Service Account hatte
**Compute Instance Admin (v1)** — das deckt Instanzen ab, Firewalls nicht.

Die Abhilfe ist eine **Custom Role**, nicht `roles/compute.securityAdmin`: die
predefined Rolle darf jede Firewall-Regel im Projekt anfassen, dazu SSL-Zertifikate
und mehr. Angelegt als `projects/<projekt>/roles/opscatSensorFirewall` mit exakt
den vier Permissions oben und dem Service Account zugewiesen; danach lief dieselbe
Provisionierung durch (`us-west2`, Node online, SSH als `opscat-admin` erreichbar).

`compute.firewalls.delete` ist **bewusst nicht** enthalten — `ensureSshAccess()`
löscht keine Regel, es legt an und patcht. Eine Berechtigung, die der Adapter nie
braucht, gehört nicht in die Rolle.

Als Datei zum Anlegen — `gcloud iam roles create opscatSensorFirewall
--project=<projekt> --file=rolle.yaml` frisst dieselben Felder als YAML oder
JSON. Dieser Block ist die maschinenlesbare Fassung, die `check:cloud` gegen
`gcp.js` prüft:

<!-- policy:gcp -->
```json
{
  "title": "OpsCat Sensor Provisioner",
  "description": "Provisioniert und entfernt OpsCat Sensor Agents; verwaltet die Break-glass-SSH-Regel.",
  "stage": "GA",
  "includedPermissions": [
    "compute.instances.create",
    "compute.instances.delete",
    "compute.instances.list",
    "compute.firewalls.get",
    "compute.firewalls.create",
    "compute.firewalls.update",
    "compute.networks.updatePolicy"
  ]
}
```

Die sechs `compute.*`-Permissions leitet der Check aus dem Adapter ab, und zwar
aus Googles URL-Grammatik (`/projects/<p>/<scope>/<collection>[/<item>]`) plus
der HTTP-Methode: POST auf eine Collection ist `create`, PATCH auf ein Item ist
`update`, und so weiter. Ein siebter API-Call bringt seine Permission also von
selbst mit, statt darauf zu warten, dass sich jemand an diese Datei erinnert.

`compute.networks.updatePolicy` ist die einzige Ausnahme: GCP prüft die am
*Netzwerk*, nicht an der Firewall-Regel, es gibt also keinen Request, aus dem
sie abzuleiten wäre. Sie steht mit Begründung in `GRANTED_UNUSED`.

**Was der Check nicht kann**, deutlich gesagt: Er vergleicht den Adapter mit der
*dokumentierten* Policy, nicht mit der, die im Kundenkonto tatsächlich hängt.
Wer die Doku ignoriert, bekommt weiter ein 403 — nur eben nicht mehr, weil die
Doku falsch war. Die Rümpfe von `ensureSshAccess()` selbst sind weiterhin von
keinem Test abgedeckt (`e2e-sensors` stubbt `providers.provider()`); dafür
bräuchte es einen Fake der beiden Cloud-APIs auf HTTP-Ebene.

**Der Sweeper merkt sich, wo er gestartet hat.** `engine/reconcile.js` leitete
seine Regionsliste aus `SELECT DISTINCT provider_region FROM sensor_nodes` ab —
aus *lebenden* Zeilen, während dieselbe Funktion Zeilen löscht. Sobald die letzte
Node einer Region weg war, wurde die Region nie wieder gelistet, und eine Waise
dort lief auf Kosten des Kunden weiter. Der Kommentar über der Query sagte
bereits „regions we ever provisioned" — genau das tat sie nicht.

`cloud_regions_used` (Migration 029) ist das Gedächtnis: eine Zeile pro
(Credential, Region) beim **erfolgreichen** Start, vom Sweeper nie gelöscht. Die
Migration backfillt aus den heute existierenden Nodes — eine Region, deren letzte
Node schon weg ist, kann sie nicht rekonstruieren, denn diese Historie wurde nie
aufgeschrieben. Eine vor Migration 029 geleakte Instanz muss also von Hand
gefunden werden.

Bewusst **nicht** gewählt: einfach alle 33 AWS-Regionen abklappern. Das wären 33
`DescribeInstances` pro Stunde pro Credential, inklusive Fehlern in nicht
aktivierten Opt-in-Regionen — teuer und laut für eine Menge, die fast immer aus
ein bis zwei Regionen besteht.

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
   (mit Kind-Badge, Region/City, Live-Latenz) plus Schalter **"all agents"**
   (= die Fleet, die es beim Anlegen gibt, als echte `check_locations`-Zeilen).
   Inline-Link
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

## 11. Break-glass-SSH + Sensor-Adresse

Die vom Wizard provisionierten Nodes waren **prinzipiell** nicht erreichbar:
`renderCloudInit()` kannte nur URL und Probe-Key, `RunInstances` übergab kein
`KeyName`, und der einzige angelegte User hat `/usr/sbin/nologin`. Kein Login,
kein Passwort, keine Shell. Das ist eine gute Voreinstellung — eine Box ohne
Login kann keinen gestohlenen Key haben — aber sie kostet: eine Node, die sich
falsch verhält, kann man nur wegwerfen, nicht ansehen, und ein Lasttest, der
`htop` auf dem Sensor braucht, ist gar nicht möglich.

Der Zugang ist deshalb **opt-in und paarweise**, pro Organisation, als zwei
Org-Settings:

| Setting | Inhalt |
|---|---|
| `sensor_ssh_key` | ein OpenSSH-**Public**-Key, einzeilig |
| `sensor_ssh_cidrs` | bis zu 8 IPv4-Adressen/CIDRs, `/16` oder enger |

Beide zusammen oder gar nicht: ein Key ohne Quell-Range wäre ein offener
Port 22, eine Range ohne Key eine Regel, die nichts schützt. `sshAccessFor()`
(`src/lib/sshaccess.js`) liefert `null`, wenn beides leer ist, und **wirft**,
wenn nur eine Hälfte gesetzt ist — auch dann, wenn jemand an der Settings-Route
vorbei direkt in `org_settings` schreibt.

Warum die Validierung so streng ist: der Key landet in **cloud-init**, und das
ist YAML, das per String-Interpolation gebaut wird. Ein „Public Key" mit einem
Zeilenumbruch setzt das Dokument fort — `runcmd:` inklusive — auf einer
Maschine, für die wir anschließend Port 22 öffnen. `validateSshKey()` prüft
deshalb einzeilig + Format, und `renderCloudInit()` prüft **noch einmal**, weil
ein zweiter Aufrufer (Skript, künftiger Ops-Pfad) die erste Prüfung sonst
umgehen könnte.

**Vorher: die Cloud-Berechtigungen.** Break-glass-SSH legt eine Firewall-Regel
an, und das ist ein Recht, das reines Provisionieren nicht braucht — AWS
`ec2:CreateSecurityGroup` + `Authorize/RevokeSecurityGroupIngress`, GCP
`compute.firewalls.get/create/update`. Beide stehen in §4 bei den
Minimal-Policies. Fehlen sie, schlägt die Provisionierung mit einem 403 fehl
und rollt zurück — was das gewünschte Verhalten ist, aber die Fehlermeldung
kommt vom Cloud-Provider und nicht von uns, also hier der Hinweis.

Was beim Provisionieren passiert, in dieser Reihenfolge:

1. `ensureSshAccess()` legt die Inbound-Regel an — AWS: eine Security-Group
   `opscat-sensor-ssh` pro Region in der Default-VPC; GCP: eine projektweite
   Firewall-Regel gleichen Namens auf `default`, adressiert über das
   Instanz-Tag `opscat-sensor`. Beide sind **idempotent und abgleichend**:
   Ranges, die in OpsCat entfernt wurden, werden entzogen bzw. gepatcht, sonst
   bliebe die Tür von gestern offen.
2. `renderCloudInit()` legt den User `opscat-admin` (sudo, key-only) an. Der
   Agent behält seinen `nologin`-Service-User und seine systemd-Härtung.
3. `createInstance()` startet die Instanz **in** dieser Group.

Schlägt Schritt 1 fehl, wird die ganze Provisionierung zurückgerollt — eine Box
mit Key, die niemand erreicht, ist genau der Zustand, den das Feature
beseitigen soll.

**Beide Provisionierungs-Pfade sind verdrahtet, und der zweite war der
wichtigere.** `POST /api/synthetics/locations/provision` (BYO-Cloud, liest die
Settings der handelnden Org) *und* `POST /api/superadmin/managed-locations`
(die Managed-Flotte, liest die Settings der **Plattform-Org**, weil die Flotte
uns gehört und nicht einem Tenant). Der Managed-Pfad ist der, den der In-App-
Wizard fährt, also die Nodes, für die wir im Zweifel geradestehen — und genau
der ist zuerst ohne SSH ausgeliefert worden.

**Bestehende Nodes bekommen den Key nicht nachträglich.** cloud-init läuft
einmal; wer eine schon laufende Node öffnen will, provisioniert sie neu (der
Reconcile-Sweeper räumt die alte ab). Das steht so auch im UI.

### Die Adresse, von der ein Probe kommt

`synthetic_locations.last_ip` (Migration 026) wird bei **jedem** Abholen der
Arbeitsliste geschrieben (`GET /v1/synthetics/checks`). Das ist der einzige
Ort, der die Wahrheit für jede Betriebsart kennt: ein Self-hosted-Agent hat
keine Cloud-API, die man fragen könnte, und die öffentliche IP einer
auto-provisionierten Node ist ephemer und ändert sich unter ihr. Die Adresse
steht auf der Agent-Karte in `/app/synthetics` — sie ist die Antwort auf „was
muss ich in der Firewall freigeben", die vorher nur über die Konsole des
Cloud-Providers zu bekommen war.

## 12. Host Agent: dieselbe Node, zweite Rolle

`opscat-agent` hat immer zwei Rollen in einer Binary gehabt, und eine
provisionierte Node hat bisher nur eine davon gefahren:

| Rolle | Credential | Was sie tut | Wo sie auftaucht |
|---|---|---|---|
| **Sensor Agent** | Sensor Key (`ocs_…`) | zieht die Check-Liste, führt synthetische Checks aus, meldet Ergebnisse | Synthetics › Sensor Agents |
| **Host Agent** | Agent Token (`oca_…`) | Heartbeat, CPU/RAM/Disk/Netz, optional Container + Logs | Assets › Agents |

Der Begriff ist bewusst gewählt: „Host Agent" ist das, was die Branche
`node_exporter`, `telegraf`, `datadog-agent` nennt — ein Prozess, der die
*Maschine* meldet, auf der er läuft. „Sensor Agent" ist die Rolle, die von
*außen* misst. Ein Wort für beides gäbe es nicht, weil es zwei Dinge sind.

**Eine Managed Node wird beim Provisionieren als beides registriert.** Der
Provision-Handler legt neben dem Probe Key ein `agents`-Row in der
Plattform-Org an (Gruppe `sensors`), speichert davon nur den Hash, und
cloud-init schreibt beide Credentials in `/etc/opscat-agent.env`. Der Agent
startet dann mit `--probe` **und** einem Token und fährt beide Rollen in einem
Prozess — ein Timer für die Checks, einer für die Metriken.

Warum das gebaut wurde: der Fleet-Screen konnte sagen, dass eine Node hinter
ihrem Soll zurückliegt (`scheduledPerMin` vs. `observedPerMin`), aber nicht
warum. CPU 96 % heißt „die Box", CPU 11 % heißt „nicht die Box" — und keine der
beiden Zahlen ist für sich genommen viel wert. Der HOST-AGENT-Block im Flyout
zeigt beides nebeneinander.

Drei Details, die still danebengehen würden:

- **`agents.name` ist UNIQUE pro Org** (`UNIQUE (org_id, name)`, Migration 036
  — davor global, was bedeutete, dass die erste Org auf einer Instanz einen
  Namen allen anderen wegnahm), und zwei Nodes in einer Stadt ist der
  Normalfall. Die Node-ID steht deshalb **im** Namen (`Sensor Frankfurt DE
  (node 42)`) statt bei einer Kollision nachgeschlagen und angehängt zu werden
  — ein Lookup wäre ein Rennen zwischen zwei Provisionierungen, die ID ist per
  Konstruktion eindeutig.
- **Ein zurückgerollter Provision und ein Teardown löschen die Registrierung
  mit.** Ein übrig gebliebenes `agents`-Row ist kein Schönheitsfehler, sondern
  ein *gültiges Agent-Token für eine Maschine, die es nicht gibt*. Derselbe
  Grund gilt für den Reconcile-Sweeper: eine Node, die nie hochkam, nimmt ihre
  Registrierung mit.
- **`null` heißt „nicht bekannt", nie `0`.** Eine Node, von der wir noch nie
  gehört haben, meldet `cpuPct: null` und der Screen zeigt einen Gedankenstrich.
  „CPU 0 %" wäre eine Aussage über eine gesunde Box, die wir nicht treffen
  können — dieselbe Regel, auf der `Count` in `ui.tsx` steht.

**Bestehende Nodes bekommen das nicht nachträglich** (cloud-init läuft einmal);
das Flyout sagt das an der Stelle, an der sonst die Hardware stünde.
