import { RecurrenceError, parseRrule } from "./index";

describe("parseRrule", () => {
  it("applies defaults: INTERVAL=1, WKST=MO", () => {
    expect(parseRrule("FREQ=DAILY")).toEqual({
      freq: "DAILY",
      interval: 1,
      count: undefined,
      until: undefined,
      byDay: undefined,
      byMonthDay: undefined,
      byMonth: undefined,
      bySetPos: undefined,
      wkst: "MO"
    });
  });

  it("parses a typical Outlook weekly rule", () => {
    const rule = parseRrule("FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2;WKST=SU;COUNT=10");
    expect(rule.freq).toBe("WEEKLY");
    expect(rule.interval).toBe(2);
    expect(rule.count).toBe(10);
    expect(rule.wkst).toBe("SU");
    expect(rule.byDay).toEqual([{ weekday: "TU" }, { weekday: "TH" }]);
  });

  it("parses BYDAY ordinal prefixes for MONTHLY", () => {
    expect(parseRrule("FREQ=MONTHLY;BYDAY=2TU").byDay).toEqual([{ weekday: "TU", ordinal: 2 }]);
    expect(parseRrule("FREQ=MONTHLY;BYDAY=-1FR").byDay).toEqual([{ weekday: "FR", ordinal: -1 }]);
    expect(parseRrule("FREQ=MONTHLY;BYDAY=+1MO").byDay).toEqual([{ weekday: "MO", ordinal: 1 }]);
  });

  it("parses BYSETPOS, BYMONTH and BYMONTHDAY lists", () => {
    const rule = parseRrule("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2");
    expect(rule.bySetPos).toEqual([2]);
    expect(parseRrule("FREQ=YEARLY;BYMONTH=3,6,9").byMonth).toEqual([3, 6, 9]);
    expect(parseRrule("FREQ=MONTHLY;BYMONTHDAY=15,-1").byMonthDay).toEqual([15, -1]);
  });

  it("parses all three UNTIL forms", () => {
    const utcForm = parseRrule("FREQ=DAILY;UNTIL=20261231T045959Z").until;
    expect(utcForm).toEqual({ year: 2026, month: 12, day: 31, hour: 4, minute: 59, second: 59, isUtc: true, isDateOnly: false });

    const localForm = parseRrule("FREQ=DAILY;UNTIL=20261231T235959").until;
    expect(localForm).toMatchObject({ year: 2026, month: 12, day: 31, hour: 23, isUtc: false, isDateOnly: false });

    const dateForm = parseRrule("FREQ=DAILY;UNTIL=20261231").until;
    expect(dateForm).toMatchObject({ year: 2026, month: 12, day: 31, isUtc: false, isDateOnly: true });
  });

  it("tolerates lowercase input and a leading RRULE: prefix", () => {
    expect(parseRrule("freq=weekly;byday=mo").byDay).toEqual([{ weekday: "MO" }]);
    expect(parseRrule("RRULE:FREQ=DAILY;COUNT=3").count).toBe(3);
  });

  it("throws for missing or invalid FREQ", () => {
    expect(() => parseRrule("COUNT=3")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=FORTNIGHTLY")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=HOURLY")).toThrow(/HOURLY/);
  });

  it("throws for unsupported BYxxx parts, naming the part", () => {
    expect(() => parseRrule("FREQ=YEARLY;BYWEEKNO=20")).toThrow(/BYWEEKNO/);
    expect(() => parseRrule("FREQ=DAILY;BYSECOND=0")).toThrow(/BYSECOND/);
    expect(() => parseRrule("FREQ=DAILY;BYMINUTE=30")).toThrow(/BYMINUTE/);
    expect(() => parseRrule("FREQ=DAILY;BYHOUR=9")).toThrow(/BYHOUR/);
    expect(() => parseRrule("FREQ=YEARLY;BYYEARDAY=100")).toThrow(/BYYEARDAY/);
  });

  it("throws for unknown parts and duplicates", () => {
    expect(() => parseRrule("FREQ=DAILY;X-FOO=1")).toThrow(/X-FOO/);
    expect(() => parseRrule("FREQ=DAILY;COUNT=1;COUNT=2")).toThrow(/Duplicate/);
  });

  it("rejects invalid combinations and values", () => {
    expect(() => parseRrule("FREQ=DAILY;COUNT=5;UNTIL=20261231T000000Z")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=2TU")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=YEARLY;BYDAY=3TU")).toThrow(/BYMONTH/);
    expect(() => parseRrule("FREQ=DAILY;INTERVAL=0")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=MONTHLY;BYMONTH=13")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=MONTHLY;BYDAY=TU;BYSETPOS=0")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=MONTHLY;BYSETPOS=2")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=DAILY;UNTIL=2026-12-31")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=WEEKLY;WKST=XX")).toThrow(RecurrenceError);
    expect(() => parseRrule("FREQ=WEEKLY;BYDAY=MONDAY")).toThrow(RecurrenceError);
  });
});
