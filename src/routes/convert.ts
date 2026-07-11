import { Router, type Request, type Response } from "express";
import { pickField } from "../utils/field-aliases.js";

export const convertRouter = Router();

// Deterministic physical-unit conversion — pure in-code factor tables, no
// external calls, no LLM. Correctness rules that shape the design:
//   - Temperature is AFFINE (offset formulas), never a multiplicative factor.
//   - Ambiguous units (oz, cup/pint/gallon US vs imperial, decimal vs binary
//     storage) are resolved deterministically AND the resolution is reported
//     back in `assumptions` — a silent wrong guess is the failure mode.
//   - Cross-category requests (volume→mass) error cleanly, never fabricate.
//   - Clinical/medical units are refused outright.

type Category =
  | "length"
  | "mass"
  | "volume"
  | "temperature"
  | "area"
  | "speed"
  | "pressure"
  | "energy"
  | "time"
  | "digital"
  | "angle"
  | "power"
  | "frequency"
  | "data_rate"
  | "force"
  | "fuel_economy";

type System = "us" | "imperial";

// --- Factor tables (unit → factor to the category's base unit) ---

// base: meter
const LENGTH_M: Record<string, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
  nautical_mile: 1852,
};

// base: kilogram
const MASS_KG: Record<string, number> = {
  mg: 1e-6,
  g: 1e-3,
  kg: 1,
  tonne: 1000,
  oz: 0.028349523125,
  lb: 0.45359237,
  stone: 6.35029318,
  us_ton: 907.18474,
  imperial_ton: 1016.0469088,
};

// base: milliliter. System-dependent units carry exact US/imperial values
// (US: 1 gal = 231 in³; imperial: 1 gal = 4.54609 L exactly).
const VOLUME_ML: Record<string, number | { us: number; imperial: number }> = {
  ml: 1,
  l: 1000,
  tsp: { us: 4.92892159375, imperial: 5.919388020833333 },
  tbsp: { us: 14.78676478125, imperial: 17.7581640625 },
  fl_oz: { us: 29.5735295625, imperial: 28.4130625 },
  cup: { us: 236.5882365, imperial: 284.130625 },
  pint: { us: 473.176473, imperial: 568.26125 },
  quart: { us: 946.352946, imperial: 1136.5225 },
  gallon: { us: 3785.411784, imperial: 4546.09 },
  // Cubic units (system-independent; exact via 1 in = 2.54 cm).
  cm3: 1,
  m3: 1e6,
  in3: 16.387064,
  ft3: 28316.846592,
  yd3: 764554.857984,
  barrel: 158987.294928, // oil barrel: exactly 42 US gallons
};

const SYSTEM_DEPENDENT_VOLUME = new Set(["tsp", "tbsp", "fl_oz", "cup", "pint", "quart", "gallon"]);

// base: square meter
const AREA_M2: Record<string, number> = {
  mm2: 1e-6,
  cm2: 1e-4,
  m2: 1,
  km2: 1e6,
  hectare: 1e4,
  sq_in: 0.00064516,
  sq_yd: 0.83612736,
  acre: 4046.8564224,
  sq_ft: 0.09290304,
  sq_mi: 2589988.110336,
};

// base: meter/second
const SPEED_MS: Record<string, number> = {
  "m/s": 1,
  "km/h": 1 / 3.6,
  mph: 0.44704,
  knot: 1852 / 3600,
  "ft/s": 0.3048,
};

// base: pascal
const PRESSURE_PA: Record<string, number> = {
  pa: 1,
  hpa: 100, // = millibar
  kpa: 1000,
  bar: 100000,
  atm: 101325,
  psi: 6894.757293168361,
  mmhg: 133.322387415,
  inhg: 3386.389,
  torr: 101325 / 760,
};

// base: joule
const ENERGY_J: Record<string, number> = {
  j: 1,
  kj: 1000,
  cal: 4.184,
  kcal: 4184,
  wh: 3600,
  kwh: 3.6e6,
  mj: 1e6,
  gj: 1e9,
  btu: 1055.05585262,
  therm: 105505585.257348, // US therm = 100,000 BTU (ISO)
};

// base: second
const TIME_S: Record<string, number> = {
  ms: 0.001,
  s: 1,
  min: 60,
  hr: 3600,
  day: 86400,
  week: 604800,
  // Average Gregorian calendar units — always reported in assumptions.calendar.
  month: 2629746, // 30.436875 days
  year: 31556952, // 365.2425 days
};
const CALENDAR_UNITS = new Set(["month", "year"]);

// base: degree
const ANGLE_DEG: Record<string, number> = {
  degree: 1,
  radian: 180 / Math.PI,
  gradian: 0.9,
};

// base: watt. hp = mechanical/imperial horsepower; metric_hp (PS) is separate.
const POWER_W: Record<string, number> = {
  w: 1,
  kw: 1000,
  mw: 1e6,
  hp: 745.6998715822702,
  metric_hp: 735.49875,
  btu_h: 1055.05585262 / 3600,
};

// base: hertz
const FREQ_HZ: Record<string, number> = {
  hz: 1,
  khz: 1e3,
  mhz: 1e6,
  ghz: 1e9,
  rpm: 1 / 60,
};

// Data-transfer rate — base: bit/s, decimal prefixes (networking convention).
// bit-rates (mbps) and byte-rates (mb_s, i.e. "MB/s") are distinct units.
const RATE_BPS: Record<string, number> = {
  bps: 1,
  kbps: 1e3,
  mbps: 1e6,
  gbps: 1e9,
  tbps: 1e12,
  byte_s: 8,
  kb_s: 8e3,
  mb_s: 8e6,
  gb_s: 8e9,
};

// base: newton
const FORCE_N: Record<string, number> = {
  n: 1,
  kn: 1000,
  lbf: 4.4482216152605,
  kgf: 9.80665,
};

// --- Fuel economy (RECIPROCAL — l_per_100km is inverse of distance-per-fuel) ---
// Linear base: km per liter. "mpg" alone resolves by the system param (US default).
const FUEL_KM_PER_L: Record<string, number> = {
  km_per_l: 1,
  mpg_us: 1.609344 / 3.785411784,
  mpg_imp: 1.609344 / 4.54609,
};

function fuelToKmPerL(v: number, unit: string): number {
  if (unit === "l_per_100km") return 100 / v;
  return v * FUEL_KM_PER_L[unit];
}

function fuelFromKmPerL(kmPerL: number, unit: string): number {
  if (unit === "l_per_100km") return 100 / kmPerL;
  return kmPerL / FUEL_KM_PER_L[unit];
}

// Digital storage — base: bit. KB..PB scale by k^exp where k is 1000 (decimal)
// or 1024 (binary), chosen by the `base` param (default decimal, reported).
const DIGITAL_EXP: Record<string, number> = { kb: 1, mb: 2, gb: 3, tb: 4, pb: 5 };

function digitalFactorBits(unit: string, k: number): number {
  if (unit === "bit") return 1;
  if (unit === "byte") return 8;
  return 8 * k ** DIGITAL_EXP[unit];
}

// --- Temperature (AFFINE — offset formulas, never a factor) ---

function tempToCelsius(v: number, unit: string): number {
  if (unit === "c") return v;
  if (unit === "f") return ((v - 32) * 5) / 9;
  return v - 273.15; // k
}

function tempFromCelsius(c: number, unit: string): number {
  if (unit === "c") return c;
  if (unit === "f") return (c * 9) / 5 + 32;
  return c + 273.15; // k
}

// --- Medical/clinical denylist — refused, never converted ---

const MEDICAL_UNITS = new Set([
  "mmol/l", "mmol", "mg/dl", "meq/l", "meq", "iu", "iu/l", "iu/ml",
  "µg/dl", "ug/dl", "mcg/dl", "µg/l", "ug/l", "mcg/l",
  "ng/ml", "ng/dl", "ng/l", "pg/ml", "miu/l", "µiu/ml", "uiu/ml",
]);

// --- Alias registry (normalized alias → candidate units) ---

interface UnitRef {
  cat: Category;
  unit: string;
}

const UNIT_LOOKUP = new Map<string, UnitRef[]>();

function reg(cat: Category, unit: string, aliases: string[]): void {
  for (const a of aliases) {
    const arr = UNIT_LOOKUP.get(a) ?? [];
    arr.push({ cat, unit });
    UNIT_LOOKUP.set(a, arr);
  }
}

reg("length", "nm", ["nm", "nanometer", "nanometers", "nanometre", "nanometres"]);
reg("length", "um", ["um", "µm", "micrometer", "micrometers", "micrometre", "micrometres", "micron", "microns"]);
reg("length", "mm", ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]);
reg("length", "cm", ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]);
reg("length", "m", ["m", "meter", "meters", "metre", "metres"]);
reg("length", "km", ["km", "kms", "kilometer", "kilometers", "kilometre", "kilometres"]);
reg("length", "in", ["in", "inch", "inches"]);
reg("length", "ft", ["ft", "foot", "feet"]);
reg("length", "yd", ["yd", "yds", "yard", "yards"]);
reg("length", "mi", ["mi", "mile", "miles"]);
reg("length", "nautical_mile", ["nautical_mile", "nautical_miles", "nmi"]);

reg("mass", "mg", ["mg", "milligram", "milligrams"]);
reg("mass", "g", ["g", "gram", "grams", "gm"]);
reg("mass", "kg", ["kg", "kgs", "kilogram", "kilograms", "kilo", "kilos"]);
reg("mass", "tonne", ["tonne", "tonnes", "metric_ton", "metric_tons"]);
reg("mass", "lb", ["lb", "lbs", "pound", "pounds"]);
reg("mass", "stone", ["stone", "stones", "st"]);
reg("mass", "us_ton", ["us_ton", "us_tons", "short_ton", "short_tons"]);
reg("mass", "imperial_ton", ["imperial_ton", "imperial_tons", "long_ton", "long_tons", "uk_ton", "uk_tons"]);

reg("volume", "ml", ["ml", "milliliter", "milliliters", "millilitre", "millilitres", "cc"]);
reg("volume", "l", ["l", "liter", "liters", "litre", "litres"]);
reg("volume", "tsp", ["tsp", "tsps", "teaspoon", "teaspoons"]);
reg("volume", "tbsp", ["tbsp", "tbsps", "tbs", "tablespoon", "tablespoons"]);
reg("volume", "fl_oz", ["fl_oz", "floz", "fluid_ounce", "fluid_ounces", "oz_fl", "fl_ounce", "fl_ounces"]);
reg("volume", "cup", ["cup", "cups"]);
reg("volume", "pint", ["pint", "pints", "pt"]);
reg("volume", "quart", ["quart", "quarts", "qt"]);
reg("volume", "gallon", ["gallon", "gallons", "gal"]);
reg("volume", "cm3", ["cm3", "cm³", "cm^3", "cubic_centimeter", "cubic_centimeters", "cubic_centimetre", "cubic_centimetres", "cu_cm"]);
reg("volume", "m3", ["m3", "m³", "m^3", "cubic_meter", "cubic_meters", "cubic_metre", "cubic_metres", "cu_m"]);
reg("volume", "in3", ["in3", "in³", "in^3", "cubic_inch", "cubic_inches", "cu_in"]);
reg("volume", "ft3", ["ft3", "ft³", "ft^3", "cubic_foot", "cubic_feet", "cubic_ft", "cu_ft"]);
reg("volume", "yd3", ["yd3", "yd³", "yd^3", "cubic_yard", "cubic_yards", "cu_yd"]);
reg("volume", "barrel", ["barrel", "barrels", "bbl", "oil_barrel", "oil_barrels"]);

reg("temperature", "c", ["c", "celsius", "degc", "deg_c", "centigrade", "degree_celsius", "degrees_celsius"]);
reg("temperature", "f", ["f", "fahrenheit", "degf", "deg_f", "degree_fahrenheit", "degrees_fahrenheit"]);
reg("temperature", "k", ["k", "kelvin", "kelvins", "degk"]);

reg("area", "mm2", ["mm2", "mm²", "mm^2", "sq_mm"]);
reg("area", "cm2", ["cm2", "cm²", "cm^2", "sq_cm"]);
reg("area", "m2", ["m2", "m²", "m^2", "sq_m", "square_meter", "square_meters", "square_metre", "square_metres"]);
reg("area", "km2", ["km2", "km²", "km^2", "sq_km", "square_kilometer", "square_kilometers"]);
reg("area", "hectare", ["hectare", "hectares", "ha"]);
reg("area", "acre", ["acre", "acres"]);
reg("area", "sq_in", ["sq_in", "sqin", "in2", "in²", "in^2", "square_inch", "square_inches"]);
reg("area", "sq_ft", ["sq_ft", "sqft", "ft2", "ft²", "ft^2", "square_foot", "square_feet"]);
reg("area", "sq_yd", ["sq_yd", "sqyd", "yd2", "yd²", "yd^2", "square_yard", "square_yards"]);
reg("area", "sq_mi", ["sq_mi", "sqmi", "mi2", "mi²", "mi^2", "square_mile", "square_miles"]);

reg("speed", "m/s", ["m/s", "mps", "meters_per_second", "metres_per_second"]);
reg("speed", "km/h", ["km/h", "kmh", "kph", "kilometers_per_hour", "kilometres_per_hour"]);
reg("speed", "mph", ["mph", "miles_per_hour"]);
reg("speed", "knot", ["knot", "knots", "kn", "kt", "kts"]);
reg("speed", "ft/s", ["ft/s", "fps", "feet_per_second"]);

reg("pressure", "pa", ["pa", "pascal", "pascals"]);
reg("pressure", "hpa", ["hpa", "hectopascal", "hectopascals", "mbar", "mbars", "millibar", "millibars"]);
reg("pressure", "inhg", ["inhg", "in_hg", "inch_of_mercury", "inches_of_mercury"]);
reg("pressure", "kpa", ["kpa", "kilopascal", "kilopascals"]);
reg("pressure", "bar", ["bar", "bars"]);
reg("pressure", "atm", ["atm", "atmosphere", "atmospheres"]);
reg("pressure", "psi", ["psi"]);
reg("pressure", "mmhg", ["mmhg", "mm_hg"]);
reg("pressure", "torr", ["torr"]);

reg("energy", "j", ["j", "joule", "joules"]);
reg("energy", "kj", ["kj", "kilojoule", "kilojoules"]);
reg("energy", "cal", ["cal", "calorie", "calories"]);
reg("energy", "kcal", ["kcal", "kilocalorie", "kilocalories"]);
reg("energy", "wh", ["wh", "watt_hour", "watt_hours"]);
reg("energy", "kwh", ["kwh", "kilowatt_hour", "kilowatt_hours"]);
reg("energy", "mj", ["mj", "megajoule", "megajoules"]);
reg("energy", "gj", ["gj", "gigajoule", "gigajoules"]);
reg("energy", "btu", ["btu", "btus"]);
reg("energy", "therm", ["therm", "therms"]);

reg("time", "ms", ["ms", "millisecond", "milliseconds"]);
reg("time", "s", ["s", "sec", "secs", "second", "seconds"]);
reg("time", "min", ["min", "mins", "minute", "minutes"]);
reg("time", "hr", ["hr", "hrs", "h", "hour", "hours"]);
reg("time", "day", ["day", "days", "d"]);
reg("time", "week", ["week", "weeks", "wk", "wks"]);
reg("time", "month", ["month", "months", "mo", "mos"]);
reg("time", "year", ["year", "years", "yr", "yrs"]);

reg("digital", "bit", ["bit", "bits"]);
reg("digital", "byte", ["byte", "bytes"]);
reg("digital", "kb", ["kb", "kilobyte", "kilobytes", "kib", "kibibyte", "kibibytes"]);
reg("digital", "mb", ["mb", "megabyte", "megabytes", "mib", "mebibyte", "mebibytes"]);
reg("digital", "gb", ["gb", "gigabyte", "gigabytes", "gib", "gibibyte", "gibibytes"]);
reg("digital", "tb", ["tb", "terabyte", "terabytes", "tib", "tebibyte", "tebibytes"]);
reg("digital", "pb", ["pb", "petabyte", "petabytes", "pib", "pebibyte", "pebibytes"]);

reg("angle", "degree", ["degree", "degrees", "deg"]);
reg("angle", "radian", ["radian", "radians", "rad", "rads"]);
reg("angle", "gradian", ["gradian", "gradians", "grad", "gon"]);

reg("power", "w", ["w", "watt", "watts"]);
reg("power", "kw", ["kw", "kilowatt", "kilowatts"]);
reg("power", "mw", ["mw", "megawatt", "megawatts"]);
reg("power", "hp", ["hp", "horsepower", "bhp"]);
reg("power", "metric_hp", ["metric_hp", "ps", "cv", "metric_horsepower"]);
reg("power", "btu_h", ["btu_h", "btu/h", "btu/hr", "btu_per_hour", "btus_per_hour"]);

reg("frequency", "hz", ["hz", "hertz"]);
reg("frequency", "khz", ["khz", "kilohertz"]);
reg("frequency", "mhz", ["mhz", "megahertz"]);
reg("frequency", "ghz", ["ghz", "gigahertz"]);
reg("frequency", "rpm", ["rpm", "rpms", "revolutions_per_minute", "revs_per_minute"]);

reg("data_rate", "bps", ["bps", "bit/s", "bits_per_second", "bit_per_second"]);
reg("data_rate", "kbps", ["kbps", "kbit/s", "kilobit_per_second", "kilobits_per_second"]);
reg("data_rate", "mbps", ["mbps", "mbit/s", "megabit_per_second", "megabits_per_second"]);
reg("data_rate", "gbps", ["gbps", "gbit/s", "gigabit_per_second", "gigabits_per_second"]);
reg("data_rate", "tbps", ["tbps", "tbit/s", "terabit_per_second", "terabits_per_second"]);
// NOTE: bare "b/s" is deliberately unregistered — bits vs bytes is a coin flip.
reg("data_rate", "byte_s", ["byte/s", "bytes_per_second", "byte_per_second"]);
reg("data_rate", "kb_s", ["kb/s", "kilobyte_per_second", "kilobytes_per_second"]);
reg("data_rate", "mb_s", ["mb/s", "megabyte_per_second", "megabytes_per_second"]);
reg("data_rate", "gb_s", ["gb/s", "gigabyte_per_second", "gigabytes_per_second"]);

reg("force", "n", ["n", "newton", "newtons"]);
reg("force", "kn", ["kn", "kilonewton", "kilonewtons"]);
reg("force", "lbf", ["lbf", "pound_force", "pounds_force", "pound_of_force"]);
reg("force", "kgf", ["kgf", "kilogram_force", "kilograms_force", "kilopond", "kp"]);

reg("fuel_economy", "mpg", ["mpg", "miles_per_gallon", "mile_per_gallon"]);
reg("fuel_economy", "mpg_us", ["mpg_us", "us_mpg"]);
reg("fuel_economy", "mpg_imp", ["mpg_imp", "imperial_mpg", "uk_mpg", "mpg_uk"]);
reg("fuel_economy", "km_per_l", ["km/l", "kml", "km_per_l", "km_per_liter", "km_per_litre", "kilometers_per_liter", "kilometres_per_litre"]);
reg("fuel_economy", "l_per_100km", ["l/100km", "l/100_km", "l_per_100km", "l_per_100_km", "liters_per_100km", "liters_per_100_km", "litres_per_100km", "litres_per_100_km"]);

// "oz"/"ounce" are genuinely ambiguous: fluid ounce (volume) vs ounce (mass).
// Register both candidates; the shared-category step resolves against the other
// unit, and the resolution is reported as oz_interpreted_as.
const OZ_AMBIGUOUS = new Set(["oz", "ozs", "ounce", "ounces"]);
for (const a of OZ_AMBIGUOUS) {
  reg("mass", "oz", [a]);
  reg("volume", "fl_oz", [a]);
}

// IEC binary prefixes (KiB/MiB/GiB/…) are binary BY DEFINITION — they override
// the `base` param rather than silently converting at 1000.
const FORCE_BINARY = new Set([
  "kib", "kibibyte", "kibibytes",
  "mib", "mebibyte", "mebibytes",
  "gib", "gibibyte", "gibibytes",
  "tib", "tebibyte", "tebibytes",
  "pib", "pebibyte", "pebibytes",
]);

// Bare "ton" is ambiguous (US short ton vs imperial long ton) — resolved by the
// `system` param and reported as ton_interpreted_as.
const TON_AMBIGUOUS = new Set(["ton", "tons"]);

// --- Helpers ---

function normalizeUnit(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/°/g, "deg")
    .replace(/\./g, "")
    .replace(/[\s\-]+/g, "_");
}

// ~6 significant figures without dumping float noise; toPrecision keeps small
// magnitudes exact (0.001 mm → 1e-6, not 0).
function roundSig(v: number, sig = 6): number {
  if (!isFinite(v) || v === 0) return v;
  return Number(v.toPrecision(sig));
}

function factorOf(cat: Category, unit: string, system: System, k: number): number {
  switch (cat) {
    case "length": return LENGTH_M[unit];
    case "mass": return MASS_KG[unit];
    case "volume": {
      const v = VOLUME_ML[unit];
      return typeof v === "number" ? v : v[system];
    }
    case "area": return AREA_M2[unit];
    case "speed": return SPEED_MS[unit];
    case "pressure": return PRESSURE_PA[unit];
    case "energy": return ENERGY_J[unit];
    case "time": return TIME_S[unit];
    case "digital": return digitalFactorBits(unit, k);
    case "angle": return ANGLE_DEG[unit];
    case "power": return POWER_W[unit];
    case "frequency": return FREQ_HZ[unit];
    case "data_rate": return RATE_BPS[unit];
    case "force": return FORCE_N[unit];
    default: throw new Error(`no factor table for category ${cat}`);
  }
}

interface ResolvedSide {
  raw: string;
  candidates: UnitRef[];
  ambiguousOz: boolean;
  forceBinary: boolean;
  tonBySystem: boolean;
}

type ResolveOutcome =
  | { ok: true; side: ResolvedSide }
  | { ok: false; status: number; body: { error: string; code: string } };

function resolveSide(raw: string, param: "from" | "to", system: System): ResolveOutcome {
  const norm = normalizeUnit(raw);

  if (MEDICAL_UNITS.has(norm)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `"${raw}" is a clinical/medical unit and is not supported by this converter`,
        code: "UNSUPPORTED_UNIT",
      },
    };
  }

  if (TON_AMBIGUOUS.has(norm)) {
    const unit = system === "imperial" ? "imperial_ton" : "us_ton";
    return {
      ok: true,
      side: { raw, candidates: [{ cat: "mass", unit }], ambiguousOz: false, forceBinary: false, tonBySystem: true },
    };
  }

  const candidates = UNIT_LOOKUP.get(norm);
  if (!candidates) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Unknown unit: "${raw}" (${param}) — supported categories: length, mass, volume, temperature, area, speed, pressure, energy, time, digital storage, angle, power, frequency, data rate, force, fuel economy`,
        code: "UNKNOWN_UNIT",
      },
    };
  }

  return {
    ok: true,
    side: {
      raw,
      candidates,
      ambiguousOz: OZ_AMBIGUOUS.has(norm),
      forceBinary: FORCE_BINARY.has(norm),
      tonBySystem: false,
    },
  };
}

// Accept common synonyms agents send for the three required params; canonical
// name first so an explicit value always wins (same pattern as currency-exchange).
const VALUE_ALIASES = ["value", "amount", "quantity", "qty"];
const FROM_ALIASES = ["from", "from_unit", "source_unit", "source"];
const TO_ALIASES = ["to", "to_unit", "target_unit", "target"];

// Natural-language query fallback. The FIRST real agent call to this endpoint
// sent ?query=convert 73 liters to kilograms, 400'd twice, and never came back
// (production failure ids 863/864). The dominant "convert VALUE UNIT to UNIT"
// shapes are a regex, not an LLM — parsing them deterministically keeps the
// flat price honest. Explicit value/from/to always win over the query.
const QUERY_ALIASES = ["query", "q", "text"];
// Number token: plain/decimal/scientific, comma-grouped (1,500), fraction (1/2),
// or mixed number (1 1/2). Fractions can't collide with slash units (km/h)
// because the token is anchored to the position right after the prefix.
const NL_NUM = String.raw`-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+\s+\d+\/\d+|-?\d+\/\d+|-?\d+(?:\.\d+)?(?:e-?\d+)?`;
const NL_QUERY_RE = new RegExp(
  String.raw`^\s*(?:(?:please\s+)?(?:convert|what\s+is|what's|whats|how\s+much\s+is)\s+)?(${NL_NUM})\s+(.+?)\s+(?:to|into|as|in)\s+(.+?)\s*\??\s*$`,
  "i"
);
// Inverted question shape: "how many miles is/are in 5 km" → to, value, from.
const NL_INVERTED_RE = new RegExp(
  String.raw`^\s*how\s+many\s+(.+?)\s+(?:are\s+in|is\s+in|is|are|in)\s+(${NL_NUM})\s+(.+?)\s*\??\s*$`,
  "i"
);

// "1,500" → "1500"; "1/2" → "0.5"; "1 1/2" → "1.5"; plain numbers pass through.
function parseNumberToken(tok: string): string {
  const t = tok.trim().replace(/,/g, "");
  const mixed = /^(-?\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) {
    const whole = Number(mixed[1]);
    const frac = Number(mixed[2]) / Number(mixed[3]);
    return String(whole < 0 ? whole - frac : whole + frac);
  }
  const frac = /^(-?\d+)\/(\d+)$/.exec(t);
  if (frac) return String(Number(frac[1]) / Number(frac[2]));
  return t;
}

// Nominal densities (kg/L ≈ g/mL, room temperature) for common substances, so
// volume↔mass converts instead of dead-ending. Values are approximate by
// nature (bulk goods like flour vary by packing); the density used is ALWAYS
// reported back in `assumptions.density_used` — no silent guesses.
const SUBSTANCE_DENSITY_KG_PER_L: Record<string, number> = {
  water: 1.0,
  seawater: 1.025,
  milk: 1.03,
  gasoline: 0.745,
  petrol: 0.745,
  diesel: 0.85,
  ethanol: 0.789,
  alcohol: 0.789,
  olive_oil: 0.915,
  oil: 0.915,
  honey: 1.42,
  butter: 0.911,
  flour: 0.593,
  sugar: 0.845,
};
const SUBSTANCE_LIST = [...new Set(Object.keys(SUBSTANCE_DENSITY_KG_PER_L))].join(", ");

function paramString(params: unknown, keys: string[]): string | undefined {
  const v = pickField(params, keys);
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? String(v[0]) : String(v);
  return s.trim() === "" ? undefined : s;
}

// --- Route handler ---

convertRouter.get("/convert", (req: Request, res: Response) => {
  try {
    // Merge query + JSON body (query wins) so agents that send the params as a
    // body instead of a query string still convert — same leniency as
    // /currency-exchange/convert.
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const params: Record<string, unknown> = { ...body, ...(req.query as Record<string, unknown>) };

    let valueRaw = paramString(params, VALUE_ALIASES);
    let fromRaw = paramString(params, FROM_ALIASES);
    let toRaw = paramString(params, TO_ALIASES);

    // Natural-language fallback: when none of value/from/to arrived but a
    // query did, regex-parse "convert 73 liters to gallons" shapes.
    let parsedFromQuery = false;
    if (valueRaw === undefined && fromRaw === undefined && toRaw === undefined) {
      const q = paramString(params, QUERY_ALIASES);
      if (q !== undefined) {
        const m = NL_QUERY_RE.exec(q);
        const inv = m ? null : NL_INVERTED_RE.exec(q);
        if (!m && !inv) {
          res.status(400).json({
            error:
              `Could not parse query "${q}" — use the shape "convert 73 liters to gallons", ` +
              `or pass the parts explicitly: ?value=73&from=liters&to=gallons`,
            code: "UNPARSEABLE_QUERY",
          });
          return;
        }
        if (m) {
          valueRaw = parseNumberToken(m[1]);
          fromRaw = m[2];
          toRaw = m[3];
        } else {
          valueRaw = parseNumberToken(inv![2]);
          fromRaw = inv![3];
          toRaw = inv![1];
        }
        parsedFromQuery = true;
      }
    }

    const missing: string[] = [];
    if (valueRaw === undefined) missing.push("value");
    if (fromRaw === undefined) missing.push("from");
    if (toRaw === undefined) missing.push("to");
    if (missing.length > 0) {
      res.status(400).json({
        error: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required — pass the quantity and both units, e.g. ?value=2&from=cups&to=fl_oz, or a single natural-language ?query=convert 2 cups to fl oz`,
        code: "MISSING_FIELD",
      });
      return;
    }

    const value = Number(valueRaw);
    if (!isFinite(value)) {
      res.status(400).json({
        error: `value must be a finite number, got "${valueRaw}" — e.g. ?value=2&from=cups&to=fl_oz`,
        code: "INVALID_VALUE",
      });
      return;
    }

    const systemRaw = paramString(params, ["system"]);
    let system: System = "us";
    if (systemRaw !== undefined) {
      const s = systemRaw.trim().toLowerCase();
      if (s === "us") system = "us";
      else if (s === "imperial" || s === "uk") system = "imperial";
      else {
        res.status(400).json({
          error: `system must be "us" or "imperial", got "${systemRaw}"`,
          code: "INVALID_VALUE",
        });
        return;
      }
    }

    const baseRaw = paramString(params, ["base"]);
    let base: "decimal" | "binary" = "decimal";
    if (baseRaw !== undefined) {
      const b = baseRaw.trim().toLowerCase();
      if (b === "decimal" || b === "binary") base = b;
      else {
        res.status(400).json({
          error: `base must be "decimal" or "binary", got "${baseRaw}"`,
          code: "INVALID_VALUE",
        });
        return;
      }
    }

    const fromResolved = resolveSide(fromRaw!, "from", system);
    if (!fromResolved.ok) {
      res.status(fromResolved.status).json(fromResolved.body);
      return;
    }
    const toResolved = resolveSide(toRaw!, "to", system);
    if (!toResolved.ok) {
      res.status(toResolved.status).json(toResolved.body);
      return;
    }
    const fromSide = fromResolved.side;
    const toSide = toResolved.side;

    // Shared-category resolution. This is also what disambiguates "oz": if the
    // other unit is a volume the shared category is volume (→ fl_oz), if mass
    // (→ mass oz). oz→oz shares both; default to fluid (the `system` context).
    const fromCats = [...new Set(fromSide.candidates.map((c) => c.cat))];
    const shared = fromCats.filter((c) => toSide.candidates.some((t) => t.cat === c));

    if (shared.length === 0) {
      const fromCat = fromSide.candidates[0].cat;
      const toCat = toSide.candidates[0].cat;
      const volumeMass =
        (fromCats.includes("volume") && toSide.candidates.some((t) => t.cat === "mass")) ||
        (fromCats.includes("mass") && toSide.candidates.some((t) => t.cat === "volume"));

      if (volumeMass) {
        // volume↔mass IS convertible once a density is known. Accept an
        // explicit &density=<kg/L> (= g/mL) or a &substance=<name> from the
        // nominal table; without either, the 400 says exactly how to retry —
        // the previous dead-end ("without density") lost the endpoint's first
        // real customer after one retry.
        const densityRaw = paramString(params, ["density"]);
        const substanceRaw = paramString(params, ["substance"]);

        let density: number | undefined;
        let densityUsed: string | undefined;
        if (densityRaw !== undefined) {
          density = Number(densityRaw);
          if (!isFinite(density) || density <= 0) {
            res.status(400).json({
              error: `density must be a positive number in kg per liter (= g/mL), got "${densityRaw}" — e.g. &density=0.92`,
              code: "INVALID_VALUE",
            });
            return;
          }
          densityUsed = `${density} kg/L (caller-supplied)`;
        } else if (substanceRaw !== undefined) {
          const key = normalizeUnit(substanceRaw);
          const d = SUBSTANCE_DENSITY_KG_PER_L[key];
          if (d === undefined) {
            res.status(400).json({
              error: `Unknown substance "${substanceRaw}" — supported: ${SUBSTANCE_LIST}; or pass an explicit &density=<kg per liter>`,
              code: "UNKNOWN_SUBSTANCE",
            });
            return;
          }
          density = d;
          densityUsed = `${d} kg/L (nominal density of ${key})`;
        }

        if (density === undefined || densityUsed === undefined) {
          res.status(400).json({
            error:
              `Cannot convert volume to mass without a density — add &density=<kg per liter> ` +
              `(e.g. &density=0.92) or &substance=<name> (supported: ${SUBSTANCE_LIST}).`,
            code: "MISSING_DENSITY",
          });
          return;
        }

        const fromIsVolume = fromCats.includes("volume");
        const volUnit = (fromIsVolume ? fromSide : toSide).candidates.find((c) => c.cat === "volume")!.unit;
        const massUnit = (fromIsVolume ? toSide : fromSide).candidates.find((c) => c.cat === "mass")!.unit;
        const volFactorMl = factorOf("volume", volUnit, system, 1000);
        const massFactorKg = MASS_KG[massUnit];

        let rawResult: number;
        if (fromIsVolume) {
          const liters = (value * volFactorMl) / 1000;
          rawResult = (liters * density) / massFactorKg;
        } else {
          const liters = (value * massFactorKg) / density;
          rawResult = (liters * 1000) / volFactorMl;
        }

        const assumptions: Record<string, string> = { density_used: densityUsed };
        if (SYSTEM_DEPENDENT_VOLUME.has(volUnit)) assumptions.system = system;
        if (parsedFromQuery) assumptions.parsed_from_query = `${valueRaw} ${fromRaw} → ${toRaw}`;

        res.json({
          value,
          from: fromRaw,
          to: toRaw,
          result: roundSig(rawResult),
          category: fromIsVolume ? "volume→mass" : "mass→volume",
          assumptions,
          precision_note: "rounded to 6 significant figures",
          score: 100,
          grade: "A",
          findings: [
            {
              rule: "density_conversion",
              detail: `Converted via density ${densityUsed}; nominal substance densities are room-temperature approximations`,
            },
          ],
        });
        return;
      }

      res.status(400).json({
        error: `Cannot convert ${fromCat} to ${toCat} — the units measure different physical quantities`,
        code: "INCOMPATIBLE_CATEGORY",
      });
      return;
    }

    const category: Category = shared.includes("volume") ? "volume" : shared[0];
    const fromUnit = fromSide.candidates.find((c) => c.cat === category)!.unit;
    const toUnit = toSide.candidates.find((c) => c.cat === category)!.unit;

    // Every default applied to resolve ambiguity goes here — silent guesses are
    // the failure mode this endpoint is designed against.
    const assumptions: Record<string, string> = {};
    if (parsedFromQuery) {
      assumptions.parsed_from_query = `${valueRaw} ${fromRaw} → ${toRaw}`;
    }
    if (fromSide.ambiguousOz || toSide.ambiguousOz) {
      assumptions.oz_interpreted_as = category === "volume" ? "fluid" : "mass";
    }
    if (
      category === "volume" &&
      (SYSTEM_DEPENDENT_VOLUME.has(fromUnit) || SYSTEM_DEPENDENT_VOLUME.has(toUnit))
    ) {
      assumptions.system = system;
    }
    if (fromSide.tonBySystem || toSide.tonBySystem) {
      assumptions.ton_interpreted_as = system === "imperial" ? "imperial_ton" : "us_ton";
    }
    if (category === "time" && (CALENDAR_UNITS.has(fromUnit) || CALENDAR_UNITS.has(toUnit))) {
      assumptions.calendar = "average Gregorian month = 30.436875 days, year = 365.2425 days";
    }

    let effectiveBase = base;
    if (category === "digital") {
      if (fromSide.forceBinary || toSide.forceBinary) effectiveBase = "binary";
      assumptions.base_used = effectiveBase;
    }

    let rawResult: number;
    if (category === "temperature") {
      // AFFINE path — offset formulas, never factors.
      rawResult = tempFromCelsius(tempToCelsius(value, fromUnit), toUnit);
    } else if (category === "fuel_economy") {
      // RECIPROCAL path — l_per_100km is the inverse of distance-per-fuel, so
      // it can never go through the multiplicative factor pipeline.
      const resolveMpg = (u: string) => (u === "mpg" ? (system === "imperial" ? "mpg_imp" : "mpg_us") : u);
      const fromFuel = resolveMpg(fromUnit);
      const toFuel = resolveMpg(toUnit);
      if (fromUnit === "mpg" || toUnit === "mpg") {
        assumptions.mpg_interpreted_as = system === "imperial" ? "mpg_imp" : "mpg_us";
      }
      if (value <= 0 && (fromFuel === "l_per_100km" || toFuel === "l_per_100km")) {
        res.status(400).json({
          error: "fuel economy must be a positive number when converting to or from l/100km (reciprocal unit)",
          code: "INVALID_VALUE",
        });
        return;
      }
      rawResult = fuelFromKmPerL(fuelToKmPerL(value, fromFuel), toFuel);
    } else {
      const k = effectiveBase === "binary" ? 1024 : 1000;
      rawResult = (value * factorOf(category, fromUnit, system, k)) / factorOf(category, toUnit, system, k);
    }

    res.json({
      value,
      from: fromRaw,
      to: toRaw,
      result: roundSig(rawResult),
      category,
      assumptions,
      precision_note: "rounded to 6 significant figures",
      score: 100,
      grade: "A",
      findings: [],
    });
  } catch (err) {
    console.error("Convert error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
