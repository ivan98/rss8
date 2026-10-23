// A 5-field cron matcher: minute, hour, day of month, month, day of week.
// Fields accept numbers, `*`, lists, ranges and steps (`*/15`, `1-5`, `8-20/4`,
// `5/10`). Day of week is 0-7 with both 0 and 7 meaning Sunday. When both day
// fields are restricted, a time matches if either matches (the Vixie cron rule).

export interface CronSchedule {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  dayOfMonthAny: boolean;
  dayOfWeekAny: boolean;
}

/** Wall-clock fields of one minute in some time zone. */
export interface LocalMinute {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  /** 0 = Sunday. */
  dayOfWeek: number;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expression}" must have 5 fields`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, i) =>
    parseField(part, FIELDS[i]!, expression),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthAny: parts[2]!.startsWith("*"),
    dayOfWeekAny: parts[4]!.startsWith("*"),
  };
}

function parseField(
  text: string,
  field: (typeof FIELDS)[number],
  expression: string,
): Set<number> {
  const values = new Set<number>();
  const fail = () => new Error(`Cron "${expression}": bad ${field.name} "${text}"`);
  for (const term of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(term);
    if (!match) throw fail();
    const [, range, from, to, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    let start: number = field.min;
    let end: number = field.max;
    if (range !== "*") {
      start = Number(from);
      end = to !== undefined ? Number(to) : stepText !== undefined ? field.max : start;
    }
    if (step < 1 || start < field.min || end > field.max || start > end) throw fail();
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export function cronMatches(schedule: CronSchedule, t: LocalMinute): boolean {
  if (!schedule.minute.has(t.minute) || !schedule.hour.has(t.hour) || !schedule.month.has(t.month)) {
    return false;
  }
  const dom = schedule.dayOfMonth.has(t.dayOfMonth);
  const dow = schedule.dayOfWeek.has(t.dayOfWeek);
  if (schedule.dayOfMonthAny || schedule.dayOfWeekAny) return dom && dow;
  return dom || dow;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function localMinute(timezone: string, epochMs: number): LocalMinute {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timezone, format);
  }
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(epochMs)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    dayOfMonth: Number(parts.day),
    month: Number(parts.month),
    dayOfWeek: WEEKDAYS[parts.weekday!]!,
  };
}

/**
 * The minutes a tick covers: (tick - windowMinutes, tick], in `timezone`.
 * A schedule is due on this tick if it matches any of them, so an expression
 * that isn't aligned to the trigger interval runs on the next tick after it.
 */
export function tickWindow(timezone: string, tickMs: number, windowMinutes: number): LocalMinute[] {
  const end = Math.floor(tickMs / 60_000) * 60_000;
  const minutes: LocalMinute[] = [];
  for (let i = windowMinutes - 1; i >= 0; i--) minutes.push(localMinute(timezone, end - i * 60_000));
  return minutes;
}

export function isDue(schedules: readonly CronSchedule[], window: readonly LocalMinute[]): boolean {
  return schedules.some((s) => window.some((t) => cronMatches(s, t)));
}
