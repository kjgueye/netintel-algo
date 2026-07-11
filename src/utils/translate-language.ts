// Language-value resolution for the translate endpoints (shared by short + long
// so the two tiers can never drift).
//
// Callers pass the TARGET (and optional source) language as an ISO 639-1 code
// ("de"), an English name ("German"), or — increasingly in production — the
// language's own endonym ("Deutsch", "polski"), a native-script name ("中文"), or
// a qualified phrase we can't fully enumerate ("Brazilian Portuguese"). The
// translation engine is an LLM, so it does not actually need a normalized code.
// Rather than 400 on a clearly-intentioned value we couldn't pre-map, we defer
// interpretation to the model and surface a "use the ISO code next time" hint in
// the response findings. A genuine garbage value still fails — but as a 400 after
// the model has had its say, not a pre-emptive reject of intent we understood.

// ISO 639-1: caller spelling → code. English names, common endonyms (romanized +
// native script), and frequent qualified names. This is the cheap, deterministic
// fast path; the long tail is handled by the model fallback (see resolveTarget).
const LANGUAGE_NAMES: Record<string, string> = {
  // English names
  english: "en",
  spanish: "es",
  french: "fr",
  german: "de",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  russian: "ru",
  chinese: "zh",
  japanese: "ja",
  korean: "ko",
  arabic: "ar",
  hindi: "hi",
  bengali: "bn",
  punjabi: "pa",
  turkish: "tr",
  polish: "pl",
  ukrainian: "uk",
  romanian: "ro",
  greek: "el",
  swedish: "sv",
  norwegian: "no",
  danish: "da",
  finnish: "fi",
  czech: "cs",
  hungarian: "hu",
  hebrew: "he",
  thai: "th",
  vietnamese: "vi",
  indonesian: "id",
  malay: "ms",
  persian: "fa",
  farsi: "fa",
  urdu: "ur",
  tamil: "ta",
  telugu: "te",
  swahili: "sw",
  filipino: "tl",
  tagalog: "tl",
  catalan: "ca",
  croatian: "hr",
  serbian: "sr",
  slovak: "sk",
  bulgarian: "bg",
  armenian: "hy",
  georgian: "ka",
  azerbaijani: "az",
  azeri: "az",
  kazakh: "kk",
  uzbek: "uz",
  belarusian: "be",
  estonian: "et",
  latvian: "lv",
  lithuanian: "lt",
  slovenian: "sl",
  slovene: "sl",
  icelandic: "is",
  albanian: "sq",
  macedonian: "mk",
  bosnian: "bs",
  gujarati: "gu",
  marathi: "mr",
  kannada: "kn",
  malayalam: "ml",
  nepali: "ne",
  sinhala: "si",
  sinhalese: "si",
  khmer: "km",
  cambodian: "km",
  lao: "lo",
  burmese: "my",
  myanmar: "my",
  mongolian: "mn",
  pashto: "ps",
  kurdish: "ku",
  amharic: "am",
  somali: "so",
  hausa: "ha",
  yoruba: "yo",
  igbo: "ig",
  zulu: "zu",
  xhosa: "xh",
  afrikaans: "af",
  malagasy: "mg",
  maltese: "mt",
  welsh: "cy",
  irish: "ga",
  basque: "eu",
  galician: "gl",
  yiddish: "yi",
  latin: "la",
  esperanto: "eo",
  haitian: "ht",
  "haitian creole": "ht",

  // Endonyms (the language's own name) — the dominant source of false 400s.
  español: "es",
  espanol: "es",
  castellano: "es",
  castilian: "es",
  français: "fr",
  francais: "fr",
  deutsch: "de",
  italiano: "it",
  português: "pt",
  portugues: "pt",
  brazilian: "pt",
  "brazilian portuguese": "pt",
  nederlands: "nl",
  flemish: "nl",
  русский: "ru",
  russkiy: "ru",
  中文: "zh",
  汉语: "zh",
  普通话: "zh",
  mandarin: "zh",
  "mandarin chinese": "zh",
  "simplified chinese": "zh",
  "traditional chinese": "zh",
  zhongwen: "zh",
  日本語: "ja",
  nihongo: "ja",
  한국어: "ko",
  hangugeo: "ko",
  العربية: "ar",
  हिन्दी: "hi",
  हिंदी: "hi",
  বাংলা: "bn",
  bangla: "bn",
  panjabi: "pa",
  ਪੰਜਾਬੀ: "pa",
  türkçe: "tr",
  turkce: "tr",
  polski: "pl",
  українська: "uk",
  ukrainska: "uk",
  română: "ro",
  romana: "ro",
  ελληνικά: "el",
  ellinika: "el",
  svenska: "sv",
  norsk: "no",
  "bokmål": "no",
  bokmal: "no",
  dansk: "da",
  suomi: "fi",
  čeština: "cs",
  cestina: "cs",
  česky: "cs",
  cesky: "cs",
  magyar: "hu",
  עברית: "he",
  ivrit: "he",
  ไทย: "th",
  "ภาษาไทย": "th",
  "tiếng việt": "vi",
  "tieng viet": "vi",
  "bahasa indonesia": "id",
  bahasa: "id",
  "bahasa melayu": "ms",
  melayu: "ms",
  فارسی: "fa",
  parsi: "fa",
  اردو: "ur",
  தமிழ்: "ta",
  tamizh: "ta",
  తెలుగు: "te",
  kiswahili: "sw",
  català: "ca",
  catala: "ca",
  hrvatski: "hr",
  srpski: "sr",
  српски: "sr",
  "slovenčina": "sk",
  slovencina: "sk",
  slovensky: "sk",
  български: "bg",
  balgarski: "bg",
  հայերեն: "hy",
  hayeren: "hy",
  ქართული: "ka",
  kartuli: "ka",
  ગુજરાતી: "gu",
  मराठी: "mr",
  ಕನ್ನಡ: "kn",
  മലയാളം: "ml",
  नेपाली: "ne",
  සිංහල: "si",
  ខ្មែរ: "km",
  ລາວ: "lo",
  မြန်မာ: "my",
  монгол: "mn",
  پښتو: "ps",
  kurdî: "ku",
  kurdi: "ku",
  አማርኛ: "am",
  amharinya: "am",
  cymraeg: "cy",
  gaeilge: "ga",
  euskara: "eu",
  galego: "gl",
  ייִדיש: "yi",
  "kreyòl ayisyen": "ht",
  "kreyol ayisyen": "ht",
  kreyòl: "ht",
  kreyol: "ht",
};

const LANGUAGE_CODES = new Set(Object.values(LANGUAGE_NAMES));

// English name per code — first entry wins, and the English-names section is
// listed first in LANGUAGE_NAMES. Used to spell out the target language in the
// model prompt: a bare code is ambiguous to the model (production 2026-07-10:
// target "te" nondeterministically translated into Japanese).
const CODE_TO_ENGLISH_NAME: Record<string, string> = {};
for (const [name, code] of Object.entries(LANGUAGE_NAMES)) {
  if (!(code in CODE_TO_ENGLISH_NAME)) CODE_TO_ENGLISH_NAME[code] = name;
}

function titleCase(name: string): string {
  return name
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Resolve a caller-supplied language (code, English name, or known endonym) to an
// ISO 639-1 code, or null if not in the static map (caller should defer to the model).
export function resolveLanguage(input: string): string | null {
  const normalized = input.trim().toLowerCase();
  if (LANGUAGE_CODES.has(normalized)) return normalized;
  if (normalized in LANGUAGE_NAMES) return LANGUAGE_NAMES[normalized];
  return null;
}

// "Auto-detect" sentinels agents send as an explicit source value. These are NOT
// language names — treating them as one puts `The source language is "auto"` in
// the model instruction and echoes "auto" back as source_language (seen in
// production: {"source_language":"auto"} → 502). Callers sending any of these
// get the same behavior as omitting source entirely.
const AUTO_SOURCE_SENTINELS = new Set([
  "auto",
  "auto-detect",
  "auto_detect",
  "autodetect",
  "detect",
  "detected",
  "any",
  "unknown",
]);

export function isAutoSource(input: string): boolean {
  return AUTO_SOURCE_SENTINELS.has(input.trim().toLowerCase());
}

export interface TargetResolution {
  /** ISO 639-1 code when statically resolved; null → defer interpretation to the model. */
  code: string | null;
  /** Trimmed caller string — used in the model instruction and the findings hint. */
  raw: string;
}

export function resolveTarget(target: string): TargetResolution {
  return { code: resolveLanguage(target), raw: target.trim() };
}

// The target-language fragment of the system prompt. When statically resolved we
// pin the model to the code; when not, we hand it the raw caller string and ask it
// to interpret (names, endonyms, qualified names) — reporting the code it chose.
export function targetInstruction(res: TargetResolution): string {
  if (res.code) {
    const name = CODE_TO_ENGLISH_NAME[res.code];
    return name
      ? `Translate the user's text into ${titleCase(name)} (ISO 639-1 code "${res.code}").`
      : `Translate the user's text into ${res.code} (ISO 639-1).`;
  }
  return (
    `Translate the user's text into the language the user specifies as "${res.raw}". ` +
    `Interpret it generously — accept English names, the language's own name (endonym), ` +
    `native-script names, and qualified names like "Brazilian Portuguese". ` +
    `If "${res.raw}" does not name a real human language, do NOT translate; instead return ` +
    `{"error":"unrecognized_language","target":null}.`
  );
}

// One findings hint nudging the caller toward an ISO code, emitted only when we had
// to defer to the model (i.e. the value wasn't in the static map).
export function targetHint(res: TargetResolution, effectiveCode: string): string {
  return (
    `Interpreted "${res.raw}" as "${effectiveCode}". For guaranteed, instant routing, ` +
    `pass the ISO 639-1 code ("${effectiveCode}") or the English language name next time.`
  );
}
