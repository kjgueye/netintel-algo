import { Router, type Request, type Response } from "express";
import { config, pricing } from "../config.js";

export const langDetectRouter = Router();

// GET/HEAD return 402 so Bazaar health prober sees a payment challenge
const langDetectPaymentRequired = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      price: pricing.langDetect,
      network: config.network,
      payTo: config.payTo,
    },
  ],
  error: "Payment required",
};

langDetectRouter.get("/lang-detect/analyze", (_req: Request, res: Response) => {
  res.status(402).json(langDetectPaymentRequired);
});

langDetectRouter.head("/lang-detect/analyze", (_req: Request, res: Response) => {
  res.status(402).end();
});

// --- Language data ---

interface LangProfile {
  name: string;
  code: string;
  words: string[];
}

const LANGUAGE_MAP: Record<string, string> = {
  en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese",
  it: "Italian", nl: "Dutch", ru: "Russian", uk: "Ukrainian", ar: "Arabic",
  zh: "Chinese", ja: "Japanese", ko: "Korean", hi: "Hindi", he: "Hebrew",
  th: "Thai", el: "Greek", pl: "Polish", sv: "Swedish", da: "Danish",
  fi: "Finnish", no: "Norwegian", cs: "Czech", ro: "Romanian", hu: "Hungarian",
  tr: "Turkish", id: "Indonesian", vi: "Vietnamese", bg: "Bulgarian",
};

const LATIN_PROFILES: LangProfile[] = [
  {
    name: "English", code: "en",
    words: ["the", "be", "to", "of", "and", "a", "in", "that", "have", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when", "make", "can", "like", "time", "no", "just", "know", "take", "people", "into", "year", "your", "good", "some", "could", "them", "see", "other", "than", "then", "now", "look", "only", "come", "its", "over", "think", "also", "back", "after", "use", "two", "how", "our", "work", "first", "well", "way", "even", "new", "want", "because", "any", "these", "give", "day", "most", "us"],
  },
  {
    name: "Spanish", code: "es",
    words: ["el", "la", "de", "que", "y", "en", "los", "se", "del", "las", "un", "por", "con", "no", "una", "su", "para", "es", "al", "lo", "como", "pero", "sus", "le", "ya", "o", "este", "porque", "esta", "entre", "cuando", "muy", "sin", "sobre", "hay", "donde", "quien", "desde", "todo", "nos", "durante", "todos", "uno", "les", "ni", "contra", "otros", "ese", "eso", "ante", "ellos", "esto", "antes", "algunos", "unos", "yo", "otro", "otras", "otra", "tanto", "esa", "estos", "mucho", "quienes", "nada", "muchos", "cual", "poco", "ella", "estar", "estas", "algunas", "algo", "nosotros"],
  },
  {
    name: "French", code: "fr",
    words: ["le", "de", "un", "et", "il", "avoir", "ne", "je", "son", "que", "se", "qui", "ce", "dans", "en", "du", "elle", "au", "par", "mais", "sur", "les", "avec", "tout", "nous", "vous", "plus", "bien", "aussi", "comme", "leurs", "leur", "ni", "notre", "peu", "encore", "sous", "autre", "sont", "cette", "fait", "peut", "ses", "ces", "aux", "sans", "des", "sur", "entre", "chez", "donc", "puis", "ici", "ils", "ont", "mes", "tes"],
  },
  {
    name: "German", code: "de",
    words: ["der", "die", "und", "in", "den", "von", "zu", "das", "mit", "sich", "des", "auf", "ist", "im", "dem", "nicht", "ein", "eine", "als", "auch", "es", "an", "werden", "aus", "er", "hat", "dass", "sie", "nach", "wird", "bei", "einer", "um", "am", "sind", "noch", "wie", "einem", "einen", "so", "zum", "war", "haben", "nur", "oder", "aber", "vor", "zur", "bis", "unter", "seit", "muss", "ihm", "wenn", "dann", "kann", "ihr", "ins", "man", "ihn", "zwischen"],
  },
  {
    name: "Portuguese", code: "pt",
    words: ["de", "a", "o", "que", "e", "do", "da", "em", "um", "para", "com", "uma", "os", "no", "se", "na", "por", "mais", "as", "dos", "como", "mas", "foi", "ao", "ele", "das", "tem", "seu", "sua", "ou", "ser", "quando", "muito", "nos", "pelo", "pela", "isso", "ela", "entre", "era", "depois", "sem", "mesmo", "aos", "ter", "seus", "quem", "nas", "me", "esse", "eles", "essa", "num", "nem", "suas", "meu", "minha"],
  },
  {
    name: "Italian", code: "it",
    words: ["di", "e", "il", "la", "che", "un", "in", "per", "con", "del", "si", "da", "i", "una", "non", "le", "su", "lo", "al", "come", "ma", "ci", "mi", "anche", "ha", "gli", "ne", "ho", "vi", "li", "era", "poi", "qui", "altro", "loro", "sua", "suo", "lei", "lui", "essere", "avere", "fare", "questo", "quella", "quello"],
  },
  {
    name: "Dutch", code: "nl",
    words: ["de", "het", "een", "van", "en", "in", "is", "dat", "op", "te", "zijn", "voor", "met", "die", "niet", "aan", "er", "maar", "om", "ook", "als", "kan", "nog", "dan", "wel", "bij", "uit", "al", "tot", "werd", "ze", "naar", "wat", "of", "meer", "hebben", "worden", "dit", "ik", "deze", "hun", "veel", "zou", "geen", "over", "zo", "door", "hij", "jaar", "haar"],
  },
  {
    name: "Polish", code: "pl",
    words: ["i", "w", "na", "nie", "co", "to", "do", "tak", "jak", "od", "je", "go", "za", "ale", "po", "czy", "si", "ten", "tego", "jest", "czy", "gdzie", "kiedy", "tylko", "bardzo", "jego", "jej", "ich", "nam", "bez", "aby", "przed", "nad", "pod", "przez", "jednak", "wszystko", "tego", "jeszcze", "sobie", "teraz", "tutaj", "moze", "ludzie", "dobrze", "niech"],
  },
  {
    name: "Swedish", code: "sv",
    words: ["och", "i", "att", "det", "som", "en", "pa", "ar", "av", "for", "med", "har", "den", "till", "inte", "om", "ett", "men", "var", "jag", "de", "sa", "hade", "vi", "kan", "alla", "ska", "nu", "sig", "han", "hon", "mot", "efter", "vid", "bara", "utan", "mer", "mycket", "nar", "sina", "sitt", "vara", "genom", "sina", "oss", "dem"],
  },
  {
    name: "Danish", code: "da",
    words: ["og", "i", "at", "det", "er", "en", "til", "pa", "den", "for", "med", "har", "de", "ikke", "som", "et", "af", "var", "men", "der", "vi", "kan", "skal", "han", "hun", "om", "sig", "efter", "fra", "sa", "alle", "kun", "nu", "blev", "mere", "meget", "hvad", "sin", "sit", "sine", "hvor", "mange", "hvis", "ingen"],
  },
  {
    name: "Finnish", code: "fi",
    words: ["ja", "on", "ei", "se", "oli", "kun", "niin", "ovat", "tai", "mutta", "olla", "ovat", "sen", "voi", "ole", "yli", "alla", "olemme", "olette", "he", "me", "te", "minun", "sinun", "myos", "sitten", "koska", "kuin", "mutta", "etta", "tama", "tuo", "sita", "mika", "kuka", "joka", "kaikki", "hyvin", "paljon", "vain"],
  },
  {
    name: "Norwegian", code: "no",
    words: ["og", "i", "er", "det", "en", "som", "pa", "at", "til", "for", "med", "har", "den", "av", "ikke", "var", "de", "men", "et", "vi", "kan", "han", "hun", "om", "etter", "fra", "sa", "skal", "alle", "meg", "seg", "sin", "sitt", "sine", "mot", "ved", "bare", "uten", "mer", "na", "noe", "bli", "hvor"],
  },
  {
    name: "Czech", code: "cs",
    words: ["a", "v", "je", "na", "se", "to", "ze", "s", "do", "pro", "ale", "si", "co", "jak", "od", "po", "tak", "ten", "jeho", "jsou", "byl", "jsem", "aby", "ani", "kde", "nebo", "pouze", "jejich", "byla", "bylo", "byli", "ktery", "ktera", "ktere", "tedy", "jeste", "vsak", "jako", "jiz", "pred", "tato", "tyto", "bude"],
  },
  {
    name: "Romanian", code: "ro",
    words: ["de", "si", "in", "la", "cu", "un", "nu", "pe", "este", "sunt", "ca", "din", "ce", "se", "mai", "o", "ale", "sau", "dar", "care", "fost", "pentru", "acest", "prin", "era", "lui", "doar", "pot", "vom", "foarte", "fie", "ori", "inca", "aici", "cele", "acea", "acei", "acele", "acest", "acesta", "aceasta"],
  },
  {
    name: "Hungarian", code: "hu",
    words: ["a", "az", "es", "nem", "hogy", "is", "egy", "volt", "meg", "van", "de", "csak", "ez", "el", "ki", "mint", "fel", "meg", "ra", "mar", "akkor", "igen", "majd", "minden", "lett", "utan", "vagy", "azt", "ezt", "ott", "itt", "lesz", "mert", "sem", "nagyon", "mindig", "soha", "valami"],
  },
  {
    name: "Turkish", code: "tr",
    words: ["bir", "bu", "da", "de", "ve", "ile", "ne", "ben", "sen", "biz", "siz", "ama", "her", "olan", "gibi", "daha", "sonra", "kadar", "benim", "senin", "onun", "bizim", "sizin", "var", "yok", "ise", "hem", "onu", "bunu", "icin", "ancak", "sadece", "olan", "olarak", "nasil", "neden", "nerede", "zaman", "hangi"],
  },
  {
    name: "Indonesian", code: "id",
    words: ["dan", "di", "yang", "ini", "itu", "dengan", "untuk", "pada", "adalah", "dari", "dalam", "tidak", "akan", "ke", "ada", "juga", "sudah", "bisa", "oleh", "saya", "kami", "mereka", "telah", "lebih", "atau", "banyak", "seperti", "karena", "tetapi", "hanya", "belum", "antara", "setelah", "semua", "lagi", "sangat", "masih", "harus", "orang", "lain", "sama"],
  },
  {
    name: "Vietnamese", code: "vi",
    words: ["va", "cua", "la", "co", "trong", "cho", "mot", "khong", "nhu", "nhung", "duoc", "voi", "thi", "da", "cac", "den", "nay", "khi", "qua", "con", "tu", "tai", "hay", "sau", "hon", "noi", "len", "bao", "truoc", "rat", "nhat", "gi", "lam", "dang", "theo", "mai", "rieng", "cung", "muon", "biet"],
  },
];

// --- Script detection ---

interface ScriptRange {
  name: string;
  ranges: [number, number][];
}

const SCRIPT_RANGES: ScriptRange[] = [
  { name: "Arabic", ranges: [[0x0600, 0x06FF]] },
  { name: "Cyrillic", ranges: [[0x0400, 0x04FF]] },
  { name: "Han", ranges: [[0x4E00, 0x9FFF]] },
  { name: "Hiragana", ranges: [[0x3040, 0x309F]] },
  { name: "Katakana", ranges: [[0x30A0, 0x30FF]] },
  { name: "Korean", ranges: [[0xAC00, 0xD7AF]] },
  { name: "Devanagari", ranges: [[0x0900, 0x097F]] },
  { name: "Hebrew", ranges: [[0x0590, 0x05FF]] },
  { name: "Thai", ranges: [[0x0E00, 0x0E7F]] },
  { name: "Greek", ranges: [[0x0370, 0x03FF]] },
];

function charInRange(code: number, ranges: [number, number][]): boolean {
  return ranges.some(([lo, hi]) => code >= lo && code <= hi);
}

interface ScriptCounts {
  [script: string]: number;
}

function detectScript(text: string): { script: string; counts: ScriptCounts } {
  const counts: ScriptCounts = {};
  let total = 0;

  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    // skip ASCII whitespace/punctuation
    if (code < 0x0080) continue;
    total++;
    for (const sr of SCRIPT_RANGES) {
      if (charInRange(code, sr.ranges)) {
        counts[sr.name] = (counts[sr.name] || 0) + 1;
        break;
      }
    }
  }

  // Find dominant non-Latin script
  let topScript = "Latin";
  let topCount = 0;
  for (const [script, count] of Object.entries(counts)) {
    if (count > topCount) {
      topCount = count;
      topScript = script;
    }
  }

  // Need >10% of non-ASCII chars to call it
  if (total === 0 || topCount / total < 0.1) {
    topScript = "Latin";
  }

  return { script: topScript, counts };
}

function scriptToLanguage(script: string, counts: ScriptCounts): { name: string; code: string } {
  switch (script) {
    case "Arabic": return { name: "Arabic", code: "ar" };
    case "Cyrillic": return { name: "Russian", code: "ru" };
    case "Korean": return { name: "Korean", code: "ko" };
    case "Devanagari": return { name: "Hindi", code: "hi" };
    case "Hebrew": return { name: "Hebrew", code: "he" };
    case "Thai": return { name: "Thai", code: "th" };
    case "Greek": return { name: "Greek", code: "el" };
    case "Han": {
      // If hiragana or katakana present → Japanese
      const kana = (counts["Hiragana"] || 0) + (counts["Katakana"] || 0);
      if (kana > 0) return { name: "Japanese", code: "ja" };
      return { name: "Chinese", code: "zh" };
    }
    case "Hiragana":
    case "Katakana":
      return { name: "Japanese", code: "ja" };
    default:
      return { name: "Unknown", code: "" };
  }
}

// --- Latin language scoring ---

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-zA-Z\u00C0-\u024F]+/).filter(Boolean);
}

interface LangScore {
  name: string;
  code: string;
  score: number;
}

function scoreLatin(text: string): LangScore[] {
  const words = tokenize(text);
  if (words.length === 0) return [];

  const wordSet = new Set(words);
  const scores: LangScore[] = [];

  for (const profile of LATIN_PROFILES) {
    let matches = 0;
    for (const w of profile.words) {
      if (wordSet.has(w)) matches++;
    }
    // Coverage ratio: how many of the profile's words appear in the text
    const score = matches / words.length;
    scores.push({ name: profile.name, code: profile.code, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// --- Grading ---

interface Finding {
  rule: string;
  label: string;
  impact: number;
  detail: string;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

langDetectRouter.post("/lang-detect/analyze", (req: Request, res: Response) => {
  try {
    const { text } = req.body || {};

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: 'text is required — e.g. {"text":"Bonjour, comment allez-vous?"}' });
      return;
    }

    if (text.length > 10000) {
      res.status(400).json({ error: "text must be 10000 characters or less" });
      return;
    }

    const words = tokenize(text);
    const wordCount = words.length;

    // Step 1: Script detection
    const { script, counts } = detectScript(text);

    let detectedLanguage: string;
    let languageCode: string;
    let confidence: "high" | "medium" | "low";
    let alternatives: Array<{ language: string; code: string; score: number }> = [];
    let isMultilingual = false;

    if (script !== "Latin") {
      // Non-Latin: use script mapping
      const lang = scriptToLanguage(script, counts);
      detectedLanguage = lang.name;
      languageCode = lang.code;
      confidence = "high";
    } else {
      // Latin: word frequency scoring
      const scores = scoreLatin(text);

      if (scores.length === 0 || scores[0].score === 0) {
        detectedLanguage = "Unknown";
        languageCode = "";
        confidence = "low";
      } else {
        const top = scores[0];
        const second = scores.length > 1 ? scores[1] : { score: 0 };

        detectedLanguage = top.name;
        languageCode = top.code;

        // Confidence mapping
        if (top.score > 0.15 && (second.score === 0 || top.score > 2 * second.score)) {
          confidence = "high";
        } else if (top.score > 0.08 || (second.score > 0 && top.score > 1.5 * second.score)) {
          confidence = "medium";
        } else {
          confidence = "low";
        }

        // Multilingual detection
        if (scores.length > 1 && top.score > 0.08 && second.score > 0.08) {
          isMultilingual = true;
        }

        // Top 3 alternatives (excluding winner)
        alternatives = scores.slice(1, 4).map((s) => ({
          language: s.name,
          code: s.code,
          score: Math.round(s.score * 100) / 100,
        }));
      }
    }

    // Force low confidence for very short Latin text
    if (script === "Latin" && wordCount < 5) {
      confidence = "low";
    }

    // Grading
    let score = 100;
    const findings: Finding[] = [];

    if (confidence === "low") {
      findings.push({ rule: "low_confidence", label: "Low confidence detection", impact: -20, detail: "Language detection confidence is low" });
      score -= 20;
    }

    if (wordCount < 5) {
      findings.push({ rule: "text_too_short", label: "Text too short for reliable detection", impact: -30, detail: "Fewer than 5 words makes detection unreliable" });
      score -= 30;
    }

    if (detectedLanguage === "Unknown") {
      findings.push({ rule: "unknown_language", label: "Could not detect language", impact: -40, detail: "No language could be identified from the input text" });
      score -= 40;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    res.json({
      detected_language: detectedLanguage,
      language_code: languageCode,
      confidence,
      script,
      is_multilingual: isMultilingual,
      alternatives,
      text_length: text.length,
      word_count: wordCount,
      score,
      grade,
      findings,
    });
  } catch (err) {
    console.error("Lang detect error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
