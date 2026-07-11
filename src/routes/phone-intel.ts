import { Router, type Request, type Response } from "express";

export const phoneIntelRouter = Router();

// --- Country dial code database ---

interface CountryInfo {
  code: string;
  name: string;
  dialCode: string;
  nationalFormat: (digits: string) => string;
  internationalFormat: (dialCode: string, digits: string) => string;
  lineType: (digits: string) => string;
}

function genericNationalFormat(digits: string): string {
  if (digits.length <= 4) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  if (digits.length <= 10) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}

function genericInternationalFormat(dialCode: string, digits: string): string {
  if (digits.length <= 4) return `+${dialCode} ${digits}`;
  if (digits.length <= 7) return `+${dialCode} ${digits.slice(0, 3)} ${digits.slice(3)}`;
  if (digits.length <= 10) return `+${dialCode} ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return `+${dialCode} ${digits.slice(0, 4)} ${digits.slice(4, 8)} ${digits.slice(8)}`;
}

const NANP_TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

function nanpLineType(digits: string): string {
  // digits = 10-digit national number (no country code)
  const areaCode = digits.slice(0, 3);
  if (NANP_TOLL_FREE.has(areaCode)) return "toll_free";
  if (areaCode === "900") return "premium_rate";
  return "mobile_or_landline";
}

function nanpNationalFormat(digits: string): string {
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return genericNationalFormat(digits);
}

function nanpInternationalFormat(dialCode: string, digits: string): string {
  if (digits.length === 10) {
    return `+${dialCode} ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  return genericInternationalFormat(dialCode, digits);
}

function ukLineType(digits: string): string {
  // digits = national number without leading 0
  if (digits.startsWith("7")) {
    if (digits.startsWith("70")) return "voip";
    return "mobile";
  }
  if (digits.startsWith("1") || digits.startsWith("2")) return "landline";
  if (digits.startsWith("800") || digits.startsWith("808")) return "toll_free";
  if (digits.startsWith("9")) return "premium_rate";
  return "unknown";
}

function ukNationalFormat(digits: string): string {
  // digits without leading 0
  const withZero = "0" + digits;
  if (digits.startsWith("2")) {
    // London-style: 020 XXXX XXXX
    return `${withZero.slice(0, 3)} ${withZero.slice(3, 7)} ${withZero.slice(7)}`;
  }
  // Generic UK: 0XXXX XXXXXX
  if (withZero.length === 11) {
    return `${withZero.slice(0, 5)} ${withZero.slice(5)}`;
  }
  return withZero;
}

function ukInternationalFormat(dialCode: string, digits: string): string {
  if (digits.startsWith("2") && digits.length === 10) {
    return `+${dialCode} ${digits.slice(0, 2)} ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  if (digits.length === 10) {
    return `+${dialCode} ${digits.slice(0, 4)} ${digits.slice(4)}`;
  }
  return genericInternationalFormat(dialCode, digits);
}

function makeGenericCountry(code: string, name: string, dialCode: string): CountryInfo {
  return {
    code,
    name,
    dialCode,
    nationalFormat: genericNationalFormat,
    internationalFormat: genericInternationalFormat,
    lineType: () => "unknown",
  };
}

const COUNTRIES: CountryInfo[] = [
  {
    code: "US", name: "United States", dialCode: "1",
    nationalFormat: nanpNationalFormat,
    internationalFormat: nanpInternationalFormat,
    lineType: nanpLineType,
  },
  {
    code: "GB", name: "United Kingdom", dialCode: "44",
    nationalFormat: ukNationalFormat,
    internationalFormat: ukInternationalFormat,
    lineType: ukLineType,
  },
  makeGenericCountry("FR", "France", "33"),
  makeGenericCountry("DE", "Germany", "49"),
  makeGenericCountry("ES", "Spain", "34"),
  makeGenericCountry("IT", "Italy", "39"),
  makeGenericCountry("NL", "Netherlands", "31"),
  makeGenericCountry("AU", "Australia", "61"),
  makeGenericCountry("NZ", "New Zealand", "64"),
  makeGenericCountry("JP", "Japan", "81"),
  makeGenericCountry("KR", "South Korea", "82"),
  makeGenericCountry("CN", "China", "86"),
  makeGenericCountry("IN", "India", "91"),
  makeGenericCountry("MX", "Mexico", "52"),
  makeGenericCountry("BR", "Brazil", "55"),
  makeGenericCountry("RU", "Russia", "7"),
  makeGenericCountry("ZA", "South Africa", "27"),
  makeGenericCountry("AE", "United Arab Emirates", "971"),
  makeGenericCountry("SA", "Saudi Arabia", "966"),
  makeGenericCountry("EG", "Egypt", "20"),
  makeGenericCountry("NG", "Nigeria", "234"),
  makeGenericCountry("KE", "Kenya", "254"),
  makeGenericCountry("IE", "Ireland", "353"),
  makeGenericCountry("CH", "Switzerland", "41"),
  makeGenericCountry("SE", "Sweden", "46"),
  makeGenericCountry("NO", "Norway", "47"),
  makeGenericCountry("DK", "Denmark", "45"),
  makeGenericCountry("FI", "Finland", "358"),
  makeGenericCountry("PL", "Poland", "48"),
  makeGenericCountry("CZ", "Czech Republic", "420"),
  makeGenericCountry("UA", "Ukraine", "380"),
  makeGenericCountry("GR", "Greece", "30"),
  makeGenericCountry("PT", "Portugal", "351"),
  makeGenericCountry("BE", "Belgium", "32"),
  makeGenericCountry("AT", "Austria", "43"),
];

// Build a lookup by dial code, sorted longest first for matching
const DIAL_CODE_MAP = new Map<string, CountryInfo>();
for (const c of COUNTRIES) {
  DIAL_CODE_MAP.set(c.dialCode, c);
}

// Also need CA → NANP
const CA_INFO: CountryInfo = {
  code: "CA", name: "Canada", dialCode: "1",
  nationalFormat: nanpNationalFormat,
  internationalFormat: nanpInternationalFormat,
  lineType: nanpLineType,
};

// Country hint lookup by ISO code
const COUNTRY_BY_ISO = new Map<string, CountryInfo>();
for (const c of COUNTRIES) {
  COUNTRY_BY_ISO.set(c.code, c);
}
COUNTRY_BY_ISO.set("CA", CA_INFO);

// Sorted dial codes longest first for greedy matching
const SORTED_DIAL_CODES = Array.from(DIAL_CODE_MAP.keys()).sort((a, b) => b.length - a.length);

// --- Parsing logic ---

interface Finding {
  rule: string;
  deduction: number;
  detail: string;
}

interface PhoneResult {
  input: string;
  is_valid: boolean;
  e164: string | null;
  international: string | null;
  national: string | null;
  country_code: string | null;
  country: string | null;
  country_name: string | null;
  line_type: string | null;
  digit_count: number;
  score: number;
  grade: string;
  findings: Finding[];
}

function parsePhone(rawPhone: string, countryHint?: string): PhoneResult {
  const input = rawPhone;

  // Step 1: Normalize — strip non-digits except leading +
  const hasPlus = rawPhone.trimStart().startsWith("+");
  const digitsOnly = rawPhone.replace(/[^\d]/g, "");

  if (digitsOnly.length === 0) {
    return invalidResult(input, 0, [{ rule: "invalid_format", deduction: -100, detail: "No digits found in input" }]);
  }

  // Step 2: Identify country
  let country: CountryInfo | null = null;
  let nationalDigits: string = digitsOnly;

  if (hasPlus) {
    // Match dial code from digits
    let matched = false;
    for (const dc of SORTED_DIAL_CODES) {
      if (digitsOnly.startsWith(dc)) {
        country = DIAL_CODE_MAP.get(dc)!;
        nationalDigits = digitsOnly.slice(dc.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unknown dial code
      nationalDigits = digitsOnly;
    }
  } else if (countryHint) {
    const hint = countryHint.toUpperCase();
    country = COUNTRY_BY_ISO.get(hint) || null;
    if (country) {
      nationalDigits = digitsOnly;
    } else {
      nationalDigits = digitsOnly;
    }
  } else {
    // Default to US/NANP
    country = DIAL_CODE_MAP.get("1")!;
    nationalDigits = digitsOnly;
  }

  // Total digit count for E.164 validation
  const totalDigits = country ? country.dialCode.length + nationalDigits.length : digitsOnly.length;

  // Step 3: Validate length (E.164: 7-15 total digits including country code)
  if (totalDigits < 7 || totalDigits > 15) {
    const reason = totalDigits < 7 ? "too_short" : "too_long";
    const detail = totalDigits < 7
      ? `Number has only ${totalDigits} digits, minimum is 7`
      : `Number has ${totalDigits} digits, maximum is 15`;
    return invalidResult(input, totalDigits, [{ rule: reason, deduction: -100, detail }]);
  }

  // Step 4: Format variants
  const findings: Finding[] = [];
  let score = 100;

  let e164: string;
  let international: string;
  let national: string;
  let countryCode: string | null = null;
  let countryIso: string | null = null;
  let countryName: string | null = null;
  let lineType: string = "unknown";

  if (country) {
    countryCode = country.dialCode;
    countryIso = country.code;
    countryName = country.name;
    e164 = `+${countryCode}${nationalDigits}`;
    international = country.internationalFormat(countryCode, nationalDigits);
    national = country.nationalFormat(nationalDigits);
    lineType = country.lineType(nationalDigits);
  } else {
    // Unknown country — still provide E.164 with the raw digits
    e164 = `+${digitsOnly}`;
    international = `+${digitsOnly}`;
    national = digitsOnly;
    findings.push({ rule: "unknown_country", deduction: -20, detail: "Dial code not recognized" });
    score -= 20;
  }

  // Step 5: Line type scoring
  if (lineType === "unknown") {
    findings.push({ rule: "unknown_line_type", deduction: -10, detail: "Line type could not be determined" });
    score -= 10;
  }

  if (lineType === "premium_rate") {
    findings.push({ rule: "premium_rate", deduction: -30, detail: "Premium-rate number detected (high fraud signal)" });
    score -= 30;
  }

  score = Math.max(0, score);
  const grade = calculateGrade(score);

  return {
    input,
    is_valid: true,
    e164,
    international,
    national,
    country_code: countryCode,
    country: countryIso,
    country_name: countryName,
    line_type: lineType,
    digit_count: totalDigits,
    score,
    grade,
    findings,
  };
}

function invalidResult(input: string, digitCount: number, findings: Finding[]): PhoneResult {
  return {
    input,
    is_valid: false,
    e164: null,
    international: null,
    national: null,
    country_code: null,
    country: null,
    country_name: null,
    line_type: null,
    digit_count: digitCount,
    score: 0,
    grade: "F",
    findings,
  };
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

phoneIntelRouter.get("/phone-intel/analyze", async (req: Request, res: Response) => {
  try {
    let phone = req.query.phone as string | undefined;
    const countryHint = req.query.country_hint as string | undefined;

    if (!phone) {
      res.status(400).json({
        error:
          "phone is required — pass a phone number, e.g. ?phone=%2B14155550123 (URL-encode a leading + as %2B, or omit it and set country_hint)",
      });
      return;
    }

    // Un-encoded `+` in a query string decodes to a space (application/
    // x-www-form-urlencoded rules), silently turning "+1415…" into " 1415…"
    // and mis-deriving the country. A phone value can never legitimately
    // START with whitespace-then-digits, so restore the intended plus.
    if (/^\s+\d/.test(phone)) {
      phone = `+${phone.trimStart()}`;
    }

    // INTENTIONAL 200 (and therefore charged): this endpoint is a phone
    // VALIDATOR — "is this number valid?" and the answer "no" (is_valid:false,
    // grade:"F", with findings explaining why) is the paid product, exactly like
    // a valid "yes". Do NOT flip present-but-invalid input (e.g. "abc", "12") to a
    // 4xx to make it uncharged: that would withhold billing for a completed
    // analysis. Only a wholly MISSING `phone` is a 400 (uncharged) above, because
    // there is nothing to validate. (Contrast /money/parse, whose product is an
    // amount, so "no amount" is a failure → 400.)
    const result = parsePhone(phone, countryHint);
    res.json(result);
  } catch (err) {
    console.error("Phone intel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
