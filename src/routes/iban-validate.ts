import { Router, type Request, type Response } from "express";
import { pickRequestParam } from "../utils/field-aliases.js";

export const ibanValidateRouter = Router();

// Complete offline IBAN validation — normalization, per-country length +
// BBAN-structure checks against the hardcoded SWIFT registry table, the ISO
// 7064 mod-97 check, bank/branch/account extraction, and print formatting.
// No external calls, ever: a structurally invalid IBAN is a VALID RESULT
// (200 billed, valid:false + findings); only missing/empty input 400s.
// Privacy: the IBAN is quasi-PII — never log or store it.

interface Finding {
  rule: string;
  detail: string;
}

// BBAN pattern notation (SWIFT registry style): sequence of <count><type>
// tokens where n = digits, a = uppercase letters, c = alphanumeric.
// bank/branch/account are 0-based [start, end) offsets WITHIN the BBAN
// (i.e. after the 2-letter country + 2 check digits); omitted when the
// country's format does not define that segment.
interface IbanSpec {
  name: string;
  length: number;
  bban: string;
  bank?: [number, number];
  branch?: [number, number];
  account?: [number, number];
  sepa?: boolean;
}

// The official IBAN registry list (SWIFT IBAN Registry structure). Pattern
// token lengths always sum to length - 4.
const IBAN_REGISTRY: Record<string, IbanSpec> = {
  AD: { name: "Andorra", length: 24, bban: "4n4n12c", bank: [0, 4], branch: [4, 8], account: [8, 20], sepa: true },
  AE: { name: "United Arab Emirates", length: 23, bban: "3n16n", bank: [0, 3], account: [3, 19] },
  AL: { name: "Albania", length: 28, bban: "8n16c", bank: [0, 3], branch: [3, 7], account: [8, 24] },
  AT: { name: "Austria", length: 20, bban: "5n11n", bank: [0, 5], account: [5, 16], sepa: true },
  AZ: { name: "Azerbaijan", length: 28, bban: "4a20c", bank: [0, 4], account: [4, 24] },
  BA: { name: "Bosnia and Herzegovina", length: 20, bban: "3n3n8n2n", bank: [0, 3], branch: [3, 6], account: [6, 14] },
  BE: { name: "Belgium", length: 16, bban: "3n7n2n", bank: [0, 3], account: [3, 10], sepa: true },
  BG: { name: "Bulgaria", length: 22, bban: "4a4n2n8c", bank: [0, 4], branch: [4, 8], account: [10, 18], sepa: true },
  BH: { name: "Bahrain", length: 22, bban: "4a14c", bank: [0, 4], account: [4, 18] },
  BI: { name: "Burundi", length: 27, bban: "5n5n11n2n", bank: [0, 5], branch: [5, 10], account: [10, 21] },
  BR: { name: "Brazil", length: 29, bban: "8n5n10n1a1c", bank: [0, 8], branch: [8, 13], account: [13, 23] },
  BY: { name: "Belarus", length: 28, bban: "4c4n16c", bank: [0, 4], account: [8, 24] },
  CH: { name: "Switzerland", length: 21, bban: "5n12c", bank: [0, 5], account: [5, 17], sepa: true },
  CR: { name: "Costa Rica", length: 22, bban: "4n14n", bank: [0, 4], account: [4, 18] },
  CY: { name: "Cyprus", length: 28, bban: "3n5n16c", bank: [0, 3], branch: [3, 8], account: [8, 24], sepa: true },
  CZ: { name: "Czechia", length: 24, bban: "4n6n10n", bank: [0, 4], account: [4, 20], sepa: true },
  DE: { name: "Germany", length: 22, bban: "8n10n", bank: [0, 8], account: [8, 18], sepa: true },
  DJ: { name: "Djibouti", length: 27, bban: "5n5n11n2n", bank: [0, 5], branch: [5, 10], account: [10, 21] },
  DK: { name: "Denmark", length: 18, bban: "4n9n1n", bank: [0, 4], account: [4, 14], sepa: true },
  DO: { name: "Dominican Republic", length: 28, bban: "4c20n", bank: [0, 4], account: [4, 24] },
  EE: { name: "Estonia", length: 20, bban: "2n2n11n1n", bank: [0, 2], branch: [2, 4], account: [4, 15], sepa: true },
  EG: { name: "Egypt", length: 29, bban: "4n4n17n", bank: [0, 4], branch: [4, 8], account: [8, 25] },
  ES: { name: "Spain", length: 24, bban: "4n4n2n10n", bank: [0, 4], branch: [4, 8], account: [10, 20], sepa: true },
  FI: { name: "Finland", length: 18, bban: "3n11n", bank: [0, 3], account: [3, 14], sepa: true },
  FK: { name: "Falkland Islands", length: 18, bban: "2a12n", bank: [0, 2], account: [2, 14] },
  FO: { name: "Faroe Islands", length: 18, bban: "4n9n1n", bank: [0, 4], account: [4, 14] },
  FR: { name: "France", length: 27, bban: "5n5n11c2n", bank: [0, 5], branch: [5, 10], account: [10, 21], sepa: true },
  GB: { name: "United Kingdom", length: 22, bban: "4a6n8n", bank: [0, 4], branch: [4, 10], account: [10, 18], sepa: true },
  GE: { name: "Georgia", length: 22, bban: "2a16n", bank: [0, 2], account: [2, 18] },
  GI: { name: "Gibraltar", length: 23, bban: "4a15c", bank: [0, 4], account: [4, 19], sepa: true },
  GL: { name: "Greenland", length: 18, bban: "4n9n1n", bank: [0, 4], account: [4, 14] },
  GR: { name: "Greece", length: 27, bban: "3n4n16c", bank: [0, 3], branch: [3, 7], account: [7, 23], sepa: true },
  GT: { name: "Guatemala", length: 28, bban: "4c20c", bank: [0, 4], account: [4, 24] },
  HR: { name: "Croatia", length: 21, bban: "7n10n", bank: [0, 7], account: [7, 17], sepa: true },
  HU: { name: "Hungary", length: 28, bban: "3n4n1n15n1n", bank: [0, 3], branch: [3, 7], account: [8, 23], sepa: true },
  IE: { name: "Ireland", length: 22, bban: "4a6n8n", bank: [0, 4], branch: [4, 10], account: [10, 18], sepa: true },
  IL: { name: "Israel", length: 23, bban: "3n3n13n", bank: [0, 3], branch: [3, 6], account: [6, 19] },
  IQ: { name: "Iraq", length: 23, bban: "4a3n12n", bank: [0, 4], branch: [4, 7], account: [7, 19] },
  IS: { name: "Iceland", length: 26, bban: "4n2n6n10n", bank: [0, 4], account: [6, 12], sepa: true },
  IT: { name: "Italy", length: 27, bban: "1a5n5n12c", bank: [1, 6], branch: [6, 11], account: [11, 23], sepa: true },
  JO: { name: "Jordan", length: 30, bban: "4a4n18c", bank: [0, 4], branch: [4, 8], account: [8, 26] },
  KW: { name: "Kuwait", length: 30, bban: "4a22c", bank: [0, 4], account: [4, 26] },
  KZ: { name: "Kazakhstan", length: 20, bban: "3n13c", bank: [0, 3], account: [3, 16] },
  LB: { name: "Lebanon", length: 28, bban: "4n20c", bank: [0, 4], account: [4, 24] },
  LC: { name: "Saint Lucia", length: 32, bban: "4a24c", bank: [0, 4], account: [4, 28] },
  LI: { name: "Liechtenstein", length: 21, bban: "5n12c", bank: [0, 5], account: [5, 17], sepa: true },
  LT: { name: "Lithuania", length: 20, bban: "5n11n", bank: [0, 5], account: [5, 16], sepa: true },
  LU: { name: "Luxembourg", length: 20, bban: "3n13c", bank: [0, 3], account: [3, 16], sepa: true },
  LV: { name: "Latvia", length: 21, bban: "4a13c", bank: [0, 4], account: [4, 17], sepa: true },
  LY: { name: "Libya", length: 25, bban: "3n3n15n", bank: [0, 3], branch: [3, 6], account: [6, 21] },
  MC: { name: "Monaco", length: 27, bban: "5n5n11c2n", bank: [0, 5], branch: [5, 10], account: [10, 21], sepa: true },
  MD: { name: "Moldova", length: 24, bban: "2c18c", bank: [0, 2], account: [2, 20] },
  ME: { name: "Montenegro", length: 22, bban: "3n13n2n", bank: [0, 3], account: [3, 16] },
  MK: { name: "North Macedonia", length: 19, bban: "3n10c2n", bank: [0, 3], account: [3, 13] },
  MN: { name: "Mongolia", length: 20, bban: "4n12n", bank: [0, 4], account: [4, 16] },
  MR: { name: "Mauritania", length: 27, bban: "5n5n11n2n", bank: [0, 5], branch: [5, 10], account: [10, 21] },
  MT: { name: "Malta", length: 31, bban: "4a5n18c", bank: [0, 4], branch: [4, 9], account: [9, 27], sepa: true },
  MU: { name: "Mauritius", length: 30, bban: "4a2n2n12n3n3a", bank: [0, 6], branch: [6, 8], account: [8, 20] },
  NI: { name: "Nicaragua", length: 28, bban: "4a20n", bank: [0, 4], account: [4, 24] },
  NL: { name: "Netherlands", length: 18, bban: "4a10n", bank: [0, 4], account: [4, 14], sepa: true },
  NO: { name: "Norway", length: 15, bban: "4n6n1n", bank: [0, 4], account: [4, 10], sepa: true },
  OM: { name: "Oman", length: 23, bban: "3n16c", bank: [0, 3], account: [3, 19] },
  PK: { name: "Pakistan", length: 24, bban: "4a16c", bank: [0, 4], account: [4, 20] },
  PL: { name: "Poland", length: 28, bban: "8n16n", bank: [0, 3], branch: [3, 7], account: [8, 24], sepa: true },
  PS: { name: "Palestine", length: 29, bban: "4a21c", bank: [0, 4], account: [4, 25] },
  PT: { name: "Portugal", length: 25, bban: "4n4n11n2n", bank: [0, 4], branch: [4, 8], account: [8, 19], sepa: true },
  QA: { name: "Qatar", length: 29, bban: "4a21c", bank: [0, 4], account: [4, 25] },
  RO: { name: "Romania", length: 24, bban: "4a16c", bank: [0, 4], account: [4, 20], sepa: true },
  RS: { name: "Serbia", length: 22, bban: "3n13n2n", bank: [0, 3], account: [3, 16] },
  RU: { name: "Russia", length: 33, bban: "9n5n15c", bank: [0, 9], branch: [9, 14], account: [14, 29] },
  SA: { name: "Saudi Arabia", length: 24, bban: "2n18c", bank: [0, 2], account: [2, 20] },
  SC: { name: "Seychelles", length: 31, bban: "4a2n2n16n3a", bank: [0, 4], branch: [4, 8], account: [8, 24] },
  SD: { name: "Sudan", length: 18, bban: "2n12n", bank: [0, 2], account: [2, 14] },
  SE: { name: "Sweden", length: 24, bban: "3n16n1n", bank: [0, 3], account: [3, 20], sepa: true },
  SI: { name: "Slovenia", length: 19, bban: "5n8n2n", bank: [0, 5], account: [5, 13], sepa: true },
  SK: { name: "Slovakia", length: 24, bban: "4n6n10n", bank: [0, 4], account: [4, 20], sepa: true },
  SM: { name: "San Marino", length: 27, bban: "1a5n5n12c", bank: [1, 6], branch: [6, 11], account: [11, 23], sepa: true },
  SO: { name: "Somalia", length: 23, bban: "4n3n12n", bank: [0, 4], branch: [4, 7], account: [7, 19] },
  ST: { name: "Sao Tome and Principe", length: 25, bban: "4n4n11n2n", bank: [0, 4], branch: [4, 8], account: [8, 19] },
  SV: { name: "El Salvador", length: 28, bban: "4a20n", bank: [0, 4], account: [4, 24] },
  TL: { name: "Timor-Leste", length: 23, bban: "3n14n2n", bank: [0, 3], account: [3, 17] },
  TN: { name: "Tunisia", length: 24, bban: "2n3n13n2n", bank: [0, 2], branch: [2, 5], account: [5, 18] },
  TR: { name: "Turkey", length: 26, bban: "5n1n16c", bank: [0, 5], account: [6, 22] },
  UA: { name: "Ukraine", length: 29, bban: "6n19c", bank: [0, 6], account: [6, 25] },
  VA: { name: "Vatican City", length: 22, bban: "3n15n", bank: [0, 3], account: [3, 18], sepa: true },
  VG: { name: "British Virgin Islands", length: 24, bban: "4a16n", bank: [0, 4], account: [4, 20] },
  XK: { name: "Kosovo", length: 20, bban: "4n10n2n", bank: [0, 2], branch: [2, 4], account: [4, 14] },
  YE: { name: "Yemen", length: 30, bban: "4a4n18c", bank: [0, 4], branch: [4, 8], account: [8, 26] },
};

// Synonyms agents send for the IBAN. Canonical `iban` first so it always wins.
const IBAN_ALIASES = ["iban", "account", "account_number", "number"];

const CHAR_CLASS: Record<string, { re: RegExp; label: string }> = {
  n: { re: /^[0-9]+$/, label: "digits" },
  a: { re: /^[A-Z]+$/, label: "uppercase letters" },
  c: { re: /^[A-Z0-9]+$/, label: "letters or digits" },
};

// Strip the noise people paste around an IBAN: a leading "IBAN"/"iban:" label,
// spaces (incl. NBSP and other unicode spaces — JS \s covers them), hyphens.
// Uppercase last so the country/check extraction sees canonical form.
function normalizeIban(raw: string): string {
  return raw
    .trim()
    .replace(/^iban[:\s]+/i, "")
    .replace(/[\s -]+/g, "")
    .toUpperCase();
}

/**
 * ISO 7064 mod-97 over a full (normalized) IBAN: move the first four chars to
 * the end, expand letters to numbers (A=10 … Z=35), then reduce piecewise —
 * the numeric expansion of a 34-char IBAN overflows Number, so the remainder
 * is folded in 7-digit chunks (each chunk is at most 9 digits with the carried
 * remainder prefixed, safely inside Number precision). Valid IBANs ≡ 1.
 * Exported for tests.
 */
export function __ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = "";
  for (const ch of rearranged) {
    numeric += ch >= "0" && ch <= "9" ? ch : String(ch.charCodeAt(0) - 55);
  }
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = parseInt(String(remainder) + numeric.slice(i, i + 7), 10) % 97;
  }
  return remainder;
}

// Walk the BBAN pattern tokens and return the first failing segment, or null
// when the whole BBAN conforms. Positions in the detail are 1-based within the
// full IBAN so the caller can point at the exact characters.
function checkBbanStructure(bban: string, pattern: string): string | null {
  let offset = 0;
  for (const token of pattern.matchAll(/(\d+)([nac])/g)) {
    const count = parseInt(token[1], 10);
    const cls = CHAR_CLASS[token[2]];
    const segment = bban.slice(offset, offset + count);
    if (!cls.re.test(segment)) {
      const start = 4 + offset + 1;
      const end = 4 + offset + count;
      return `characters ${start}–${end} must be ${cls.label}, got "${segment}"`;
    }
    offset += count;
  }
  return null;
}

function sliceOrNull(bban: string, range?: [number, number]): string | null {
  return range ? bban.slice(range[0], range[1]) : null;
}

// --- Route handler (shared by GET and POST) ---

function handleIbanValidate(req: Request, res: Response): void {
  const raw = pickRequestParam(req, IBAN_ALIASES);
  const iban = raw === undefined ? "" : normalizeIban(raw);

  if (iban === "") {
    res.status(400).json({
      error:
        'iban is required — pass the IBAN via ?iban=DE89370400440532013000 or a JSON body {"iban":"DE89 3704 0044 0532 0130 00"} (spaces/hyphens/case tolerated). Also accepted: account, account_number, number.',
    });
    return;
  }

  const findings: Finding[] = [];
  const country = iban.slice(0, 2);
  const checkDigits = iban.slice(2, 4);
  const bban = iban.slice(4);
  const spec = /^[A-Z]{2}$/.test(country) ? IBAN_REGISTRY[country] : undefined;

  // The checksum is computable on any [A-Z0-9] string long enough to rearrange.
  const checksumComputable = iban.length >= 5 && /^[A-Z0-9]+$/.test(iban);
  const checksumOk = checksumComputable && __ibanMod97(iban) === 1;

  let lengthOk: boolean;
  let structureOk: boolean;

  if (!spec) {
    findings.push({
      rule: "unknown_country",
      detail: `"${country}" is not a country code in the IBAN registry`,
    });
    // Only the generic ISO 13616 constraints apply without a registry entry.
    lengthOk = iban.length >= 5 && iban.length <= 34;
    structureOk = /^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban);
  } else {
    lengthOk = iban.length === spec.length;
    if (!lengthOk) {
      findings.push({
        rule: "bad_length",
        detail: `${country} (${spec.name}) IBANs are ${spec.length} characters, got ${iban.length}`,
      });
      // Segments cannot be aligned against a wrong-length BBAN; bad_length
      // already names the failure, so no separate bad_structure finding.
      structureOk = false;
    } else if (!/^[0-9]{2}$/.test(checkDigits)) {
      structureOk = false;
      findings.push({
        rule: "bad_structure",
        detail: `characters 3–4 (check digits) must be digits, got "${checkDigits}"`,
      });
    } else {
      const structureError = checkBbanStructure(bban, spec.bban);
      structureOk = structureError === null;
      if (structureError) {
        findings.push({ rule: "bad_structure", detail: structureError });
      }
    }
    if (!checksumOk) {
      findings.push({
        rule: "bad_checksum",
        detail: "mod-97 check failed (ISO 7064) — the IBAN contains a typo or transposition",
      });
    }
  }

  // Extraction only makes sense when the registry defines the layout AND the
  // length matches (segments still extract on e.g. a checksum typo — useful).
  const extractable = spec !== undefined && lengthOk;

  res.json({
    iban,
    valid: spec !== undefined && lengthOk && structureOk && checksumOk,
    country,
    country_name: spec ? spec.name : null,
    check_digits: checkDigits,
    checksum_ok: checksumOk,
    length_ok: lengthOk,
    structure_ok: structureOk,
    bank_code: extractable ? sliceOrNull(bban, spec.bank) : null,
    branch_code: extractable ? sliceOrNull(bban, spec.branch) : null,
    account_number: extractable ? sliceOrNull(bban, spec.account) : null,
    formatted: iban.match(/.{1,4}/g)?.join(" ") ?? iban,
    sepa_member: spec?.sepa === true,
    findings,
  });
}

ibanValidateRouter.get("/iban/validate", handleIbanValidate);
ibanValidateRouter.post("/iban/validate", handleIbanValidate);
