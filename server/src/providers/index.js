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

// Region → City catalog shown in the wizard (step 2), clustered by UI region.
const CATALOG = {
  aws: [
    { code: 'eu-central-1', city: 'Frankfurt', cc: 'DE', region: 'Europe' },
    { code: 'eu-west-1', city: 'Ireland', cc: 'IE', region: 'Europe' },
    { code: 'eu-west-2', city: 'London', cc: 'GB', region: 'Europe' },
    { code: 'eu-west-3', city: 'Paris', cc: 'FR', region: 'Europe' },
    { code: 'eu-north-1', city: 'Stockholm', cc: 'SE', region: 'Europe' },
    { code: 'eu-central-2', city: 'Zurich', cc: 'CH', region: 'Europe' },
    { code: 'us-east-1', city: 'N. Virginia', cc: 'US', region: 'North America' },
    { code: 'us-east-2', city: 'Ohio', cc: 'US', region: 'North America' },
    { code: 'us-west-2', city: 'Oregon', cc: 'US', region: 'North America' },
    { code: 'ca-central-1', city: 'Montreal', cc: 'CA', region: 'North America' },
    { code: 'sa-east-1', city: 'São Paulo', cc: 'BR', region: 'South America' },
    { code: 'ap-southeast-1', city: 'Singapore', cc: 'SG', region: 'Asia-Pacific' },
    { code: 'ap-northeast-1', city: 'Tokyo', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'ap-southeast-2', city: 'Sydney', cc: 'AU', region: 'Asia-Pacific' },
    { code: 'ap-south-1', city: 'Mumbai', cc: 'IN', region: 'Asia-Pacific' },
    { code: 'ap-northeast-2', city: 'Seoul', cc: 'KR', region: 'Asia-Pacific' },
    { code: 'ap-southeast-3', city: 'Jakarta', cc: 'ID', region: 'Asia-Pacific' },
    { code: 'me-central-1', city: 'UAE', cc: 'AE', region: 'Middle East & Africa' },
    { code: 'me-south-1', city: 'Bahrain', cc: 'BH', region: 'Middle East & Africa' },
    { code: 'af-south-1', city: 'Cape Town', cc: 'ZA', region: 'Middle East & Africa' },
    { code: 'il-central-1', city: 'Tel Aviv', cc: 'IL', region: 'Middle East & Africa' },
  ],
  gcp: [
    { code: 'europe-west3', city: 'Frankfurt', cc: 'DE', region: 'Europe' },
    { code: 'europe-west1', city: 'Belgium', cc: 'BE', region: 'Europe' },
    { code: 'europe-west2', city: 'London', cc: 'GB', region: 'Europe' },
    { code: 'europe-west9', city: 'Paris', cc: 'FR', region: 'Europe' },
    { code: 'europe-west6', city: 'Zurich', cc: 'CH', region: 'Europe' },
    { code: 'europe-southwest1', city: 'Madrid', cc: 'ES', region: 'Europe' },
    { code: 'us-central1', city: 'Iowa', cc: 'US', region: 'North America' },
    { code: 'us-east1', city: 'S. Carolina', cc: 'US', region: 'North America' },
    { code: 'us-west1', city: 'Oregon', cc: 'US', region: 'North America' },
    { code: 'northamerica-northeast2', city: 'Toronto', cc: 'CA', region: 'North America' },
    { code: 'southamerica-east1', city: 'São Paulo', cc: 'BR', region: 'South America' },
    { code: 'southamerica-west1', city: 'Santiago', cc: 'CL', region: 'South America' },
    { code: 'asia-southeast1', city: 'Singapore', cc: 'SG', region: 'Asia-Pacific' },
    { code: 'asia-northeast1', city: 'Tokyo', cc: 'JP', region: 'Asia-Pacific' },
    { code: 'australia-southeast1', city: 'Sydney', cc: 'AU', region: 'Asia-Pacific' },
    { code: 'asia-south1', city: 'Mumbai', cc: 'IN', region: 'Asia-Pacific' },
    { code: 'asia-northeast3', city: 'Seoul', cc: 'KR', region: 'Asia-Pacific' },
    { code: 'me-west1', city: 'Tel Aviv', cc: 'IL', region: 'Middle East & Africa' },
    { code: 'me-central1', city: 'Doha', cc: 'QA', region: 'Middle East & Africa' },
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

module.exports = { PROVIDERS, CATALOG, INSTANCE_TYPES, provider, catalogEntry, instanceType, renderCloudInit };
