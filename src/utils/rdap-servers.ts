// One place to turn a TLD into its RDAP base URL. IANA's bootstrap file
// (https://data.iana.org/rdap/dns.json) covers gTLDs; ccTLD registries are not
// required to register there, and several that DO run public RDAP servers are
// missing from it — most importantly .io. Every route that resolved a server
// straight from the bootstrap (bulk-domain, domain-availability, domain-age,
// domain-report) therefore fell back to a bare DNS check for .io and reported
// `registrar: null` for a registered name; whois-rdap alone carried a fix.
// Production evidence: /domain/vet on 2026-10-11 listed payloop.io as taken with
// no registrar while Identity Digital's RDAP names GoDaddy.

export interface RdapBootstrap {
  services?: string[][][];
}

// ccTLD registries that RUN public RDAP servers but are absent from IANA's
// bootstrap. Each entry was verified live to serve /domain/<name> with valid
// RDAP JSON (registrar entity present). Identity Digital is the backend for all.
export const SUPPLEMENTAL_RDAP: Readonly<Record<string, string>> = {
  io: "https://rdap.identitydigital.services/rdap",
  me: "https://rdap.identitydigital.services/rdap",
  sh: "https://rdap.identitydigital.services/rdap",
  ac: "https://rdap.identitydigital.services/rdap",
};

/** RDAP base URL (no trailing slash) for a TLD: the IANA bootstrap first, then the supplemental map; null when neither knows it. */
export function rdapServerForTld(bootstrap: RdapBootstrap | null | undefined, tld: string): string | null {
  const t = tld.toLowerCase().replace(/^\./, "");
  if (bootstrap && Array.isArray(bootstrap.services)) {
    for (const service of bootstrap.services) {
      const tlds = service[0];
      const urls = service[1];
      if (Array.isArray(tlds) && tlds.includes(t) && Array.isArray(urls) && urls.length > 0) {
        return urls[0].replace(/\/+$/, "");
      }
    }
  }
  return SUPPLEMENTAL_RDAP[t] ?? null;
}
