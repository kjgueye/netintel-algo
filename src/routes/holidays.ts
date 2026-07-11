import { Router, type Request, type Response } from "express";
import { checkSsrf, ValidationError } from "../utils/validators.js";
import { timeouts } from "../config.js";
import { pickField } from "../utils/field-aliases.js";

export const holidaysRouter = Router();

// --- Interfaces ---

interface HolidayRaw {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
  fixed: boolean;
  global: boolean;
  counties: string[] | null;
  launchYear: number | null;
  types: string[];
}

interface HolidayEntry {
  date: string;
  name: string;
  local_name: string;
  is_global: boolean;
  types: string[];
}

interface DateCheck {
  date: string;
  is_holiday: boolean;
  is_weekend: boolean;
  is_business_day: boolean;
  holiday_name: string | null;
  next_business_day: string | null;
}

// --- Helpers ---

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function findNextBusinessDay(startDate: Date, holidayDates: Set<string>): string | null {
  const d = new Date(startDate);
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    const ds = formatDate(d);
    if (!isWeekend(d) && !holidayDates.has(ds)) {
      return ds;
    }
  }
  return null;
}

function calculateGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 55) return "C";
  if (score >= 30) return "D";
  return "F";
}

// --- Route handler ---

holidaysRouter.get("/holidays/check", async (req: Request, res: Response) => {
  try {
    const countryCode = (pickField(req.query, ["country_code", "country", "cc"]) as string) || undefined;
    const yearParam = req.query.year as string | undefined;
    const dateParam = req.query.date as string | undefined;

    if (!countryCode) {
      res.status(400).json({
        error: 'country_code is required — pass a 2-letter ISO country code as "country_code", with optional "year", e.g. ?country_code=US&year=2026',
      });
      return;
    }

    if (!/^[A-Za-z]{2}$/.test(countryCode)) {
      res.status(400).json({ error: "country_code must be a 2-letter ISO country code" });
      return;
    }

    const cc = countryCode.toUpperCase();

    // Determine year
    let year: number;
    if (yearParam) {
      year = parseInt(yearParam, 10);
      if (isNaN(year) || year < 2000 || year > 2099) {
        res.status(400).json({ error: "year must be between 2000 and 2099" });
        return;
      }
    } else if (dateParam) {
      // Extract year from date param if no year specified
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
      year = parseInt(dateParam.substring(0, 4), 10);
    } else {
      year = new Date().getFullYear();
    }

    // Validate date format if provided
    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
      return;
    }

    // Validate date is a real date
    if (dateParam) {
      const parsed = new Date(dateParam + "T00:00:00");
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "date must be in YYYY-MM-DD format" });
        return;
      }
    }

    // Fetch holidays from Nager.Date API
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`;
    await checkSsrf(new URL(url).hostname);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeouts.holidays),
    });

    if (response.status === 404) {
      res.status(400).json({ error: `Country not supported: ${cc}` });
      return;
    }

    if (!response.ok) {
      const score = 40;
      res.json({
        country_code: cc,
        year,
        total_holidays: 0,
        holidays: [],
        date_check: null,
        score,
        grade: calculateGrade(score),
        findings: [{ rule: "api_error", label: "API error", impact: -60, detail: `Nager.Date API returned HTTP ${response.status}` }],
      });
      return;
    }

    const rawHolidays: HolidayRaw[] = await response.json() as HolidayRaw[];

    const holidays: HolidayEntry[] = rawHolidays.map((h) => ({
      date: h.date,
      name: h.name,
      local_name: h.localName,
      is_global: h.global,
      types: h.types,
    }));

    const holidayDates = new Set(rawHolidays.map((h) => h.date));

    // Date check
    let dateCheck: DateCheck | null = null;
    if (dateParam) {
      const d = new Date(dateParam + "T00:00:00");
      const dateStr = dateParam;
      const weekend = isWeekend(d);
      const holiday = holidayDates.has(dateStr);
      const holidayName = holiday
        ? rawHolidays.find((h) => h.date === dateStr)?.name ?? null
        : null;
      const businessDay = !weekend && !holiday;
      const nextBiz = businessDay ? null : findNextBusinessDay(d, holidayDates);

      dateCheck = {
        date: dateStr,
        is_holiday: holiday,
        is_weekend: weekend,
        is_business_day: businessDay,
        holiday_name: holidayName,
        next_business_day: nextBiz,
      };
    }

    res.json({
      country_code: cc,
      year,
      total_holidays: holidays.length,
      holidays,
      date_check: dateCheck,
      score: 100,
      grade: "A",
      findings: [],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Holidays error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
