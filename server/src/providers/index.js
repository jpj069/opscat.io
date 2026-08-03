'use strict';
// Provider registry for sensor-agent auto-provisioning (BYO-cloud in the core,
// the managed fleet reuses it with platform credentials). First wave: AWS +
// GCP only — Hetzner/Vultr stay an internal option of the ops tooling and are
// not offered in the customer wizard (docs/SENSOR-AGENTS.md §4).
const aws = require('./aws');
const gcp = require('./gcp');
const { renderCloudInit } = require('./cloudinit');

const PROVIDERS = { aws, gcp };

// Instance classes per docs/SENSOR-AGENTS.md §6: 'browser' nodes carry enough
// RAM for Playwright later; 'standard' covers http/icmp/dns/tcp/traceroute.
const INSTANCE_TYPES = {
  standard: { aws: 't3.small', gcp: 'e2-small' },
  browser: { aws: 't3.medium', gcp: 'e2-medium' },
};

// Rough run-rate per node so the fleet wizard can show what one more sensor
// costs before you click Provision. `usdPerMonth` is on-demand list price for a
// mid-priced region (Frankfurt) over 730 h, plus the boot disk and the public
// IPv4 — the IPv4 alone is ~3.65 USD/mo on AWS and easy to forget. Deliberately
// a single number per provider/class, not a per-region table: US regions run
// below it, São Paulo and Sydney above, and GCP applies sustained-use discounts
// automatically, so anything more precise would imply accuracy we don't have.
// Revisit when provider list prices move.
const COST_ESTIMATES = {
  aws: { standard: { usdPerMonth: 21 }, browser: { usdPerMonth: 37 } },
  gcp: { standard: { usdPerMonth: 15 }, browser: { usdPerMonth: 28 } },
};

// Region → City catalog shown in the wizard (step 2), clustered by UI region.
// Full commercial footprint of both providers, verified against the vendors' own
// tables (AWS `aws-regions.md`, GCP `regions-zones` doc) rather than typed from
// memory: AWS 34 regions, GCP 43. One entry per region — NOT per availability
// zone. AZs inside a region sit in the same metro on the same egress path, so a
// second AZ costs another node and measures the same thing (docs/SENSORS.md).
//
// `optIn: true` marks an AWS region that is disabled by default and has to be
// enabled per account before a launch there can succeed (AWS calls these
// opt-in regions). GCP has no equivalent — every region is usable once billing
// is attached.
const CATALOG = {
  aws: [
    { code: 'eu-central-1', city: 'Frankfurt', cc: 'DE', region: 'Europe' },
    { code: 'eu-west-1', city: 'Ireland', cc: 'IE', region: 'Europe' },
    { code: 'eu-west-2', city: 'London', cc: 'GB', region: 'Europe' },
    { code: 'eu-west-3', city: 'Paris', cc: 'FR', region: 'Europe' },
    { code: 'eu-north-1', city: 'Stockholm', cc: 'SE', region: 'Europe' },
    { code: 'eu-central-2', city: 'Zurich', cc: 'CH', region: 'Europe', optIn: true },
    { code: 'eu-south-1', city: 'Milan', cc: 'IT', region: 'Europe', optIn: true },
    { code: 'eu-south-2', city: 'Spain', cc: 'ES', region: 'Europe', optIn: true },
    { code: 'us-east-1', city: 'N. Virginia', cc: 'US', region: 'North America' },
    { code: 'us-east-2', city: 'Ohio', cc: 'US', region: 'North America' },
    { code: 'us-west-1', city: 'N. California', cc: 'US', region: 'North America' },
    { code: 'us-west-2', city: 'Oregon', cc: 'US', region: 'North America' },
    { code: 'ca-central-1', city: 'Montreal', cc: 'CA', region: 'North America' },
    { code: 'ca-west-1', city: 'Calgary', cc: 'CA', region: 'North America', optIn: true },
    { code: 'mx-central-1', city: 'Mexico', cc: 'MX', region: 'North America', optIn: true },
    { code: 'sa-east-1', city: 'São Paulo', cc: 'BR', region: 'South America' },
    { code: 'ap-southeast-1', city: 'Singapore', cc: 'SG', region: 'Asia-Pacific' },
    { code: 'ap-northeast-1', city: 'Tokyo', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'ap-northeast-3', city: 'Osaka', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'ap-southeast-2', city: 'Sydney', cc: 'AU', region: 'Asia-Pacific' },
    { code: 'ap-southeast-4', city: 'Melbourne', cc: 'AU', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-south-1', city: 'Mumbai', cc: 'IN', region: 'Asia-Pacific' },
    { code: 'ap-south-2', city: 'Hyderabad', cc: 'IN', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-northeast-2', city: 'Seoul', cc: 'KR', region: 'Asia-Pacific' },
    { code: 'ap-southeast-3', city: 'Jakarta', cc: 'ID', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-southeast-5', city: 'Malaysia', cc: 'MY', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-southeast-6', city: 'New Zealand', cc: 'NZ', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-southeast-7', city: 'Thailand', cc: 'TH', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-east-1', city: 'Hong Kong', cc: 'HK', region: 'Asia-Pacific', optIn: true },
    { code: 'ap-east-2', city: 'Taipei', cc: 'TW', region: 'Asia-Pacific', optIn: true },
    { code: 'me-central-1', city: 'UAE', cc: 'AE', region: 'Middle East & Africa', optIn: true },
    // Bahrain (me-south-1) is deliberately absent: the region is opted in on our
    // account, but its API endpoint was unreachable from two independent networks
    // (both resolved IPs time out on 443). Re-add once AWS routing recovers.
    { code: 'af-south-1', city: 'Cape Town', cc: 'ZA', region: 'Middle East & Africa', optIn: true },
    { code: 'il-central-1', city: 'Tel Aviv', cc: 'IL', region: 'Middle East & Africa', optIn: true },
  ],
  gcp: [
    { code: 'europe-west3', city: 'Frankfurt', cc: 'DE', region: 'Europe' },
    { code: 'europe-west10', city: 'Berlin', cc: 'DE', region: 'Europe' },
    { code: 'europe-west1', city: 'Belgium', cc: 'BE', region: 'Europe' },
    { code: 'europe-west2', city: 'London', cc: 'GB', region: 'Europe' },
    { code: 'europe-west9', city: 'Paris', cc: 'FR', region: 'Europe' },
    { code: 'europe-west6', city: 'Zurich', cc: 'CH', region: 'Europe' },
    { code: 'europe-west4', city: 'Netherlands', cc: 'NL', region: 'Europe' },
    { code: 'europe-southwest1', city: 'Madrid', cc: 'ES', region: 'Europe' },
    { code: 'europe-west8', city: 'Milan', cc: 'IT', region: 'Europe' },
    { code: 'europe-west12', city: 'Turin', cc: 'IT', region: 'Europe' },
    { code: 'europe-north1', city: 'Finland', cc: 'FI', region: 'Europe' },
    { code: 'europe-north2', city: 'Stockholm', cc: 'SE', region: 'Europe' },
    { code: 'europe-central2', city: 'Warsaw', cc: 'PL', region: 'Europe' },
    { code: 'us-central1', city: 'Iowa', cc: 'US', region: 'North America' },
    { code: 'us-east1', city: 'S. Carolina', cc: 'US', region: 'North America' },
    { code: 'us-east4', city: 'N. Virginia', cc: 'US', region: 'North America' },
    { code: 'us-east5', city: 'Ohio', cc: 'US', region: 'North America' },
    { code: 'us-south1', city: 'Dallas', cc: 'US', region: 'North America' },
    { code: 'us-west1', city: 'Oregon', cc: 'US', region: 'North America' },
    { code: 'us-west2', city: 'Los Angeles', cc: 'US', region: 'North America' },
    { code: 'us-west3', city: 'Salt Lake City', cc: 'US', region: 'North America' },
    { code: 'us-west4', city: 'Las Vegas', cc: 'US', region: 'North America' },
    { code: 'northamerica-northeast1', city: 'Montreal', cc: 'CA', region: 'North America' },
    { code: 'northamerica-northeast2', city: 'Toronto', cc: 'CA', region: 'North America' },
    { code: 'northamerica-south1', city: 'Querétaro', cc: 'MX', region: 'North America' },
    { code: 'southamerica-east1', city: 'São Paulo', cc: 'BR', region: 'South America' },
    { code: 'southamerica-west1', city: 'Santiago', cc: 'CL', region: 'South America' },
    { code: 'asia-southeast1', city: 'Singapore', cc: 'SG', region: 'Asia-Pacific' },
    { code: 'asia-southeast2', city: 'Jakarta', cc: 'ID', region: 'Asia-Pacific' },
    { code: 'asia-southeast3', city: 'Bangkok', cc: 'TH', region: 'Asia-Pacific' },
    { code: 'asia-northeast1', city: 'Tokyo', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'asia-northeast2', city: 'Osaka', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'asia-northeast3', city: 'Seoul', cc: 'KR', region: 'Asia-Pacific' },
    { code: 'asia-east1', city: 'Taiwan', cc: 'TW', region: 'Asia-Pacific' },
    { code: 'asia-east2', city: 'Hong Kong', cc: 'HK', region: 'Asia-Pacific' },
    { code: 'asia-south1', city: 'Mumbai', cc: 'IN', region: 'Asia-Pacific' },
    { code: 'asia-south2', city: 'Delhi', cc: 'IN', region: 'Asia-Pacific' },
    { code: 'australia-southeast1', city: 'Sydney', cc: 'AU', region: 'Asia-Pacific' },
    { code: 'australia-southeast2', city: 'Melbourne', cc: 'AU', region: 'Asia-Pacific' },
    { code: 'me-west1', city: 'Tel Aviv', cc: 'IL', region: 'Middle East & Africa' },
    { code: 'me-central1', city: 'Doha', cc: 'QA', region: 'Middle East & Africa' },
    { code: 'me-central2', city: 'Dammam', cc: 'SA', region: 'Middle East & Africa' },
    { code: 'africa-south1', city: 'Johannesburg', cc: 'ZA', region: 'Middle East & Africa' },
  ],
};

function provider(key) {
  const p = PROVIDERS[key];
  if (!p) throw new Error(`unknown provider: ${key}`);
  return p;
}
function catalogEntry(providerKey, code) {
  return (CATALOG[providerKey] || []).find((e) => e.code === code) || null;
}
function instanceType(providerKey, instanceClass) {
  const c = INSTANCE_TYPES[instanceClass] || INSTANCE_TYPES.standard;
  return c[providerKey];
}

module.exports = { PROVIDERS, CATALOG, INSTANCE_TYPES, COST_ESTIMATES, provider, catalogEntry, instanceType, renderCloudInit };
