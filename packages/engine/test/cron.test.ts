import { afterEach, describe, expect, it, vi } from "vitest";
import { cronMatches, isDue, localMinute, localMinutes, parseCron } from "../src/cron";
import { TICK_MINUTES } from "../src/worker";

const SGT = "Asia/Singapore";

function dueAt(expressions: string[], utc: string, timezone = SGT): boolean {
  const tick = Date.parse(utc);
  return isDue(expressions.map(parseCron), localMinutes(timezone, tick - TICK_MINUTES * 60_000, tick));
}

/** UTC tick times (ISO) within one day from `startUtc` at which the schedule is due. */
function dueTicks(expressions: string[], startUtc: string, hours = 24): string[] {
  const start = Date.parse(startUtc);
  const due: string[] = [];
  for (let t = start; t < start + hours * 3_600_000; t += TICK_MINUTES * 60_000) {
    const iso = new Date(t).toISOString().slice(0, 16);
    if (dueAt(expressions, iso + "Z")) due.push(iso);
  }
  return due;
}

describe("parseCron", () => {
  it("expands numbers, lists, ranges and steps", () => {
    const s = parseCron("*/20 8-20/4 1,15 1-3 1-5");
    expect([...s.minute]).toEqual([0, 20, 40]);
    expect([...s.hour]).toEqual([8, 12, 16, 20]);
    expect([...s.dayOfMonth]).toEqual([1, 15]);
    expect([...s.month]).toEqual([1, 2, 3]);
    expect([...s.dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads a start with a step as start to max", () => {
    expect([...parseCron("50/5 * * * *").minute]).toEqual([50, 55]);
  });

  it("treats 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").dayOfWeek]).toEqual([0]);
  });

  it.each(["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "5-1 * * * *", "*/0 * * * *", "a * * * *", "1,,2 * * * *"])(
    "rejects %s",
    (expression) => {
      expect(() => parseCron(expression)).toThrow(/Cron/);
    },
  );
});

describe("cronMatches", () => {
  const monday1st = { year: 2026, minute: 0, hour: 0, dayOfMonth: 1, month: 6, dayOfWeek: 1 };
  const tuesday2nd = { year: 2026, minute: 0, hour: 0, dayOfMonth: 2, month: 6, dayOfWeek: 2 };
  const friday13th = { year: 2026, minute: 0, hour: 0, dayOfMonth: 13, month: 6, dayOfWeek: 5 };

  it("matches either day field when both are restricted", () => {
    const s = parseCron("0 0 1 * 5");
    expect(cronMatches(s, monday1st)).toBe(true);
    expect(cronMatches(s, friday13th)).toBe(true);
    expect(cronMatches(s, tuesday2nd)).toBe(false);
  });

  it("needs both day fields when one is a wildcard", () => {
    expect(cronMatches(parseCron("0 0 * * 5"), monday1st)).toBe(false);
    expect(cronMatches(parseCron("0 0 */2 * *"), tuesday2nd)).toBe(false);
    expect(cronMatches(parseCron("0 0 */2 * *"), monday1st)).toBe(true);
  });
});

describe("schedules in Asia/Singapore (UTC+8)", () => {
  it("reads the local wall clock across the UTC day boundary", () => {
    expect(localMinute(SGT, Date.parse("2026-10-25T16:30:00Z"))).toEqual({
      year: 2026,
      minute: 30,
      hour: 0,
      dayOfMonth: 26,
      month: 10,
      dayOfWeek: 1,
    });
  });

  it("runs local midnight at the 16:00 UTC tick of the previous UTC day", () => {
    expect(dueTicks(["0 0 * * *"], "2026-10-25T00:00Z")).toEqual(["2026-10-25T16:00"]);
  });

  it("evaluates the day of week in local time", () => {
    // Monday 00:30 SGT is Sunday 16:30 UTC.
    expect(dueTicks(["30 0 * * 1"], "2026-10-25T00:00Z")).toEqual(["2026-10-25T16:30"]);
    expect(dueAt(["30 0 * * 1"], "2026-10-26T16:30Z")).toBe(false);
  });

  it("evaluates the day of month and month in local time", () => {
    // 1 November 07:00 SGT is 31 October 23:00 UTC.
    expect(dueTicks(["0 7 1 11 *"], "2026-10-31T00:00Z", 48)).toEqual(["2026-10-31T23:00"]);
  });

  it("runs a schedule not aligned to 15 minutes on the next tick after it", () => {
    expect(dueTicks(["7 9 * * *"], "2026-10-25T00:00Z")).toEqual(["2026-10-25T01:15"]);
    expect(dueTicks(["*/20 9 * * *"], "2026-10-25T00:00Z")).toEqual([
      "2026-10-25T01:00",
      "2026-10-25T01:30",
      "2026-10-25T01:45",
    ]);
  });

  it("counts the tick's own minute and not the previous tick's", () => {
    expect(dueAt(["15 9 * * *"], "2026-10-25T01:15Z")).toBe(true);
    expect(dueAt(["15 9 * * *"], "2026-10-25T01:30Z")).toBe(false);
  });

  it("uses the tick time rounded down to the minute", () => {
    expect(dueAt(["15 9 * * *"], "2026-10-25T01:15:42.500Z")).toBe(true);
  });

  it("is due when any of several expressions matches", () => {
    expect(dueTicks(["15 * * * *", "45 6-7 * * *"], "2026-10-25T00:00Z", 1)).toEqual(["2026-10-25T00:15"]);
    expect(dueTicks(["15 * * * *", "45 6-7 * * *"], "2026-10-24T22:00Z", 1)).toEqual([
      "2026-10-24T22:15",
      "2026-10-24T22:45",
    ]);
  });
});

describe("localMinutes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function formatMinuteByMinute(timezone: string, afterMs: number, untilMs: number) {
    const minutes = [];
    for (let t = afterMs + 60_000; t <= untilMs; t += 60_000) minutes.push(localMinute(timezone, t));
    return minutes;
  }

  const day = 24 * 3_600_000;
  it.each([
    ["Europe/London", "2026-10-24T12:00:00Z"],
    ["America/New_York", "2026-03-07T12:00:00Z"],
    ["Australia/Lord_Howe", "2026-04-04T12:00:00Z"],
    ["Asia/Singapore", "2026-12-31T04:00:00Z"],
  ])("gives the same 24 h of minutes in %s from %s as formatting each one", (timezone, start) => {
    const after = Date.parse(start);
    const expected = formatMinuteByMinute(timezone, after, after + day);
    expect(expected).toHaveLength(1440);
    expect(localMinutes(timezone, after, after + day)).toEqual(expected);
  });

  it("covers (after, until] rounded down to the minute", () => {
    const after = Date.parse("2026-10-25T01:00:30Z");
    const until = Date.parse("2026-10-25T01:03:59Z");
    expect(localMinutes("UTC", after, until).map((t) => t.minute)).toEqual([1, 2, 3]);
    expect(localMinutes("UTC", until, until)).toEqual([]);
  });

  it("refuses a window longer than 24 hours", () => {
    const after = Date.parse("2026-03-01T00:00:00Z");
    expect(() => localMinutes("Europe/London", after, after + day + 60_000)).toThrow(RangeError);
  });

  it("formats a few minutes, not every one, for a day that changes offset", () => {
    const format = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const after = Date.parse("2026-10-24T12:00:00Z");
    localMinutes("Europe/London", after, after + day);
    expect(format.mock.calls.length).toBeLessThanOrEqual(30);

    format.mockClear();
    localMinutes("Europe/London", after + 2 * day, after + 3 * day);
    expect(format.mock.calls.length).toBe(2);
  });
});
