import { Router, type Request, type Response } from "express";
import { ValidationError } from "../utils/validators.js";

export const cronParserRouter = Router();

// --- Constants ---

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DAY_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const MONTH_LABELS = ["", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// --- Field parsing ---

interface FieldRange {
  min: number;
  max: number;
}

const FIELD_RANGES: Record<string, FieldRange> = {
  second: { min: 0, max: 59 },
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  day_of_month: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  day_of_week: { min: 0, max: 7 },
};

function replaceNames(field: string, mapping: Record<string, number>): string {
  let result = field.toUpperCase();
  for (const [name, val] of Object.entries(mapping)) {
    result = result.replace(new RegExp(name, "g"), String(val));
  }
  return result;
}

function parseField(raw: string, fieldName: string): number[] {
  const range = FIELD_RANGES[fieldName];
  if (!range) throw new ValidationError(`Unknown field: ${fieldName}`);

  // Replace month/day names
  let field = raw;
  if (fieldName === "month") field = replaceNames(field, MONTH_NAMES);
  if (fieldName === "day_of_week") field = replaceNames(field, DAY_NAMES);

  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // */n
    const stepAll = trimmed.match(/^\*\/(\d+)$/);
    if (stepAll) {
      const step = parseInt(stepAll[1], 10);
      if (step === 0) throw new ValidationError(`Invalid step value 0 in ${fieldName} field`);
      for (let i = range.min; i <= range.max; i += step) values.add(i);
      continue;
    }

    // *
    if (trimmed === "*") {
      for (let i = range.min; i <= range.max; i++) values.add(i);
      continue;
    }

    // n-m/s
    const rangeStep = trimmed.match(/^(\d+)-(\d+)\/(\d+)$/);
    if (rangeStep) {
      const start = parseInt(rangeStep[1], 10);
      const end = parseInt(rangeStep[2], 10);
      const step = parseInt(rangeStep[3], 10);
      if (step === 0) throw new ValidationError(`Invalid step value 0 in ${fieldName} field`);
      validateValue(start, fieldName, range);
      validateValue(end, fieldName, range);
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // n-m
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      validateValue(start, fieldName, range);
      validateValue(end, fieldName, range);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // single number
    const numMatch = trimmed.match(/^\d+$/);
    if (numMatch) {
      const val = parseInt(trimmed, 10);
      validateValue(val, fieldName, range);
      values.add(val);
      continue;
    }

    throw new ValidationError(`Invalid syntax "${raw}" in ${fieldName} field`);
  }

  return Array.from(values).sort((a, b) => a - b);
}

function validateValue(val: number, fieldName: string, range: FieldRange): void {
  if (val < range.min || val > range.max) {
    throw new ValidationError(`Value ${val} out of range ${range.min}-${range.max} in ${fieldName} field`);
  }
}

// --- Explanation builder ---

function explainMinute(values: number[], raw: string): string {
  if (raw === "*") return "";
  const stepMatch = raw.match(/^\*\/(\d+)$/);
  if (stepMatch) return `every ${stepMatch[1]} minutes`;
  if (values.length === 1) return `at minute ${values[0]}`;
  return `at minutes ${values.join(", ")}`;
}

function explainHour(values: number[], raw: string): string {
  if (raw === "*") return "";
  const stepMatch = raw.match(/^\*\/(\d+)$/);
  if (stepMatch) return `every ${stepMatch[1]} hours`;
  if (values.length === 1) return `at ${values[0]}:00`;
  return `between ${values[0]}:00 and ${values[values.length - 1]}:00`;
}

function explainDom(values: number[], raw: string): string {
  if (raw === "*") return "every day";
  if (values.length === 1) return `on day ${values[0]} of the month`;
  return `on days ${values.join(", ")} of the month`;
}

function explainMonth(values: number[], raw: string): string {
  if (raw === "*") return "every month";
  const names = values.map((v) => MONTH_LABELS[v]).filter(Boolean);
  return `in ${names.join(" and ")}`;
}

function explainDow(values: number[], raw: string): string {
  if (raw === "*") return "";
  // Normalize 7 to 0 for Sunday
  const normalized = values.map((v) => (v === 7 ? 0 : v));
  const unique = [...new Set(normalized)].sort((a, b) => a - b);

  // Check weekdays
  if (unique.length === 5 && [1, 2, 3, 4, 5].every((d) => unique.includes(d))) return "Monday through Friday";
  // Check weekends
  if (unique.length === 2 && unique.includes(0) && unique.includes(6)) return "on weekends";

  const names = unique.map((v) => DAY_LABELS[v]).filter(Boolean);
  if (names.length === 1) return `on ${names[0]}`;
  return `on ${names.join(", ")}`;
}

function buildExplanation(fields: ParsedFields): string {
  const parts: string[] = [];

  const minVals = parseField(fields.minute, "minute");
  const hourVals = parseField(fields.hour, "hour");
  const domVals = parseField(fields.day_of_month, "day_of_month");
  const monthVals = parseField(fields.month, "month");
  const dowVals = parseField(fields.day_of_week, "day_of_week");

  // Time part
  if (fields.minute === "0" && fields.hour === "0") {
    parts.push("At midnight");
  } else if (fields.minute === "0" && hourVals.length === 1) {
    const h = hourVals[0];
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    parts.push(`At ${h12}:00 ${ampm}`);
  } else {
    const minPart = explainMinute(minVals, fields.minute);
    const hourPart = explainHour(hourVals, fields.hour);
    if (minPart) parts.push(minPart);
    if (hourPart) parts.push(hourPart);
    if (!minPart && !hourPart) parts.push("every minute");
  }

  // Day part
  const dowPart = explainDow(dowVals, fields.day_of_week);
  if (dowPart) {
    parts.push(dowPart);
  }

  // Day of month
  if (fields.day_of_month !== "*") {
    parts.push(explainDom(domVals, fields.day_of_month));
  } else if (!dowPart) {
    parts.push("every day");
  }

  // Month
  if (fields.month !== "*") {
    parts.push(explainMonth(monthVals, fields.month));
  }

  return parts.join(", ");
}

// --- Pattern detection ---

interface ParsedFields {
  second?: string;
  minute: string;
  hour: string;
  day_of_month: string;
  month: string;
  day_of_week: string;
}

function detectPattern(fields: ParsedFields): string | null {
  const { minute: m, hour: h, day_of_month: dom, month: mo, day_of_week: dow } = fields;

  if (m === "0" && h === "0" && dom === "*" && mo === "*" && dow === "*") return "Daily at midnight";
  if (m === "0" && h === "*" && dom === "*" && mo === "*" && dow === "*") return "Every hour";

  // Step patterns on minute
  const minuteStep = m.match(/^\*\/(\d+)$/);
  if (minuteStep && h === "*" && dom === "*" && mo === "*" && dow === "*") {
    return `Every ${minuteStep[1]} minutes`;
  }

  // Weekdays at specific time
  const dowNorm = replaceNames(dow, DAY_NAMES);
  if (m === "0" && /^\d+$/.test(h) && dom === "*" && mo === "*" && (dowNorm === "1-5" || dow === "MON-FRI")) {
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? "PM" : "AM";
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `Weekdays at ${h12}:00 ${ampm}`;
  }

  if (m === "0" && h === "0" && dom === "*" && mo === "*" && (dow === "0" || dow === "7" || dow.toUpperCase() === "SUN"))
    return "Every Sunday at midnight";

  if (m === "0" && h === "0" && /^\d+$/.test(dom) && mo === "*" && dow === "*")
    return `Monthly on the ${ordinal(parseInt(dom, 10))}`;

  if (m === "0" && h === "0" && /^\d+$/.test(dom) && /^\d+$/.test(replaceNames(mo, MONTH_NAMES)) && dow === "*") {
    const monthNum = parseInt(replaceNames(mo, MONTH_NAMES), 10);
    return `Yearly on ${MONTH_LABELS[monthNum]} ${ordinal(parseInt(dom, 10))}`;
  }

  return null;
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// --- Next run computation ---

function computeNextRuns(fields: ParsedFields, count: number, now: Date): string[] {
  const minValues = parseField(fields.minute, "minute");
  const hourValues = parseField(fields.hour, "hour");
  const domValues = parseField(fields.day_of_month, "day_of_month");
  const monthValues = parseField(fields.month, "month");
  const dowValues = parseField(fields.day_of_week, "day_of_week");

  // Normalize day_of_week: 7 → 0
  const dowSet = new Set(dowValues.map((v) => (v === 7 ? 0 : v)));

  const results: string[] = [];
  const current = new Date(now);
  current.setUTCSeconds(0, 0);
  // Start from the next minute
  current.setUTCMinutes(current.getUTCMinutes() + 1);

  const maxIterations = 525600; // 1 year of minutes
  for (let i = 0; i < maxIterations && results.length < count; i++) {
    const month = current.getUTCMonth() + 1;
    const dom = current.getUTCDate();
    const dow = current.getUTCDay();
    const hour = current.getUTCHours();
    const minute = current.getUTCMinutes();

    if (
      monthValues.includes(month) &&
      domValues.includes(dom) &&
      dowSet.has(dow) &&
      hourValues.includes(hour) &&
      minValues.includes(minute)
    ) {
      results.push(current.toISOString().replace(/\.\d{3}Z$/, "Z"));
    }

    current.setUTCMinutes(current.getUTCMinutes() + 1);
  }

  return results;
}

// --- Grading ---

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

cronParserRouter.get("/cron-parser/explain", (req: Request, res: Response) => {
  try {
    const expression = req.query.expression as string | undefined;
    const timezone = (req.query.timezone as string | undefined) || "UTC";
    const countParam = req.query.count as string | undefined;
    const count = countParam ? Math.min(Math.max(parseInt(countParam, 10) || 5, 1), 20) : 5;

    if (!expression) {
      res.status(400).json({ error: "Missing required parameter: expression" });
      return;
    }

    const parts = expression.trim().split(/\s+/);

    if (parts.length < 5 || parts.length > 6) {
      res.status(400).json({ error: `Invalid cron expression: expected 5 or 6 fields, got ${parts.length}` });
      return;
    }

    const isSixField = parts.length === 6;
    const fields: ParsedFields = isSixField
      ? {
          second: parts[0],
          minute: parts[1],
          hour: parts[2],
          day_of_month: parts[3],
          month: parts[4],
          day_of_week: parts[5],
        }
      : {
          minute: parts[0],
          hour: parts[1],
          day_of_month: parts[2],
          month: parts[3],
          day_of_week: parts[4],
        };

    // Validate all fields
    try {
      if (fields.second !== undefined) parseField(fields.second, "second");
      parseField(fields.minute, "minute");
      parseField(fields.hour, "hour");
      parseField(fields.day_of_month, "day_of_month");
      parseField(fields.month, "month");
      parseField(fields.day_of_week, "day_of_week");
    } catch (err) {
      if (err instanceof ValidationError) {
        // INTENTIONAL 200 (and therefore charged): this endpoint is a cron
        // VALIDATOR/explainer — for a well-formed-but-invalid expression (right
        // field count, bad field value/syntax) the verdict is_valid:false, with
        // the offending field surfaced in warnings/findings, IS the paid product.
        // Do NOT flip this to a 4xx to make it uncharged: a completed "this cron
        // is invalid because…" analysis is exactly what the caller paid for. Only
        // a MISSING expression, or one with the wrong field count, returns 400
        // (uncharged) above — those can't be analyzed. (Contrast /money/parse,
        // whose product is an amount, so "no amount" is a failure → 400.)
        res.json({
          expression,
          is_valid: false,
          fields: {
            ...(isSixField ? { second: fields.second } : {}),
            minute: fields.minute,
            hour: fields.hour,
            day_of_month: fields.day_of_month,
            month: fields.month,
            day_of_week: fields.day_of_week,
          },
          explanation: null,
          pattern_name: null,
          next_runs: [],
          warnings: [err.message],
          score: 0,
          grade: "F",
          findings: [{ rule: "invalid_expression", label: "Invalid cron expression", impact: -100, detail: err.message }],
        });
        return;
      }
      throw err;
    }

    // Build response
    const warnings: string[] = [];
    const findings: Array<{ rule: string; label: string; impact: number; detail: string }> = [];
    let score = 100;

    // Check too_frequent
    const minuteField = fields.minute;
    const tooFrequentMatch = minuteField.match(/^\*\/([1-4])$/);
    if (tooFrequentMatch) {
      const interval = tooFrequentMatch[1];
      warnings.push(`Expression runs every ${interval} minute(s) — verify this is intentional`);
      findings.push({ rule: "too_frequent", label: "Very frequent schedule", impact: -30, detail: `Runs every ${interval} minute(s)` });
      score -= 30;
    } else if (minuteField === "*") {
      warnings.push("Expression runs every minute — verify this is intentional");
      findings.push({ rule: "too_frequent", label: "Very frequent schedule", impact: -30, detail: "Runs every minute" });
      score -= 30;
    }

    // Check dom_and_dow_both_set
    if (fields.day_of_month !== "*" && fields.day_of_week !== "*") {
      warnings.push("Day of month and day of week are both specified — behavior may be unexpected");
      findings.push({ rule: "dom_and_dow_both_set", label: "Ambiguous day specification", impact: -10, detail: "Both day-of-month and day-of-week are set" });
      score -= 10;
    }

    score = Math.max(0, score);
    const grade = calculateGrade(score);

    const explanation = buildExplanation(fields);
    const patternName = detectPattern(fields);
    const nextRuns = computeNextRuns(fields, count, new Date());

    res.json({
      expression,
      is_valid: true,
      fields: {
        ...(isSixField ? { second: fields.second } : {}),
        minute: fields.minute,
        hour: fields.hour,
        day_of_month: fields.day_of_month,
        month: fields.month,
        day_of_week: fields.day_of_week,
      },
      explanation,
      pattern_name: patternName,
      next_runs: nextRuns,
      warnings,
      score,
      grade,
      findings,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Cron parser error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
