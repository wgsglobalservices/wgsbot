import { RecurrenceError, expandRecurrence, occurrenceKeyFromIcsDateTime, occurrenceKeyFromUtc } from "./index";
import type { ExpandedOccurrence, IcsDateTimeLike, RecurrenceExpansionInput } from "./index";

const HOUR_MS = 3_600_000;

const utcStart = (utc: string): IcsDateTimeLike => ({ utc });

const expand = (input: Partial<RecurrenceExpansionInput> & Pick<RecurrenceExpansionInput, "seriesStart">): ExpandedOccurrence[] =>
  expandRecurrence({
    durationMs: HOUR_MS,
    windowStart: "2020-01-01T00:00:00.000Z",
    windowEnd: "2030-01-01T00:00:00.000Z",
    ...input
  });

const starts = (occurrences: ExpandedOccurrence[]): string[] => occurrences.map((occurrence) => occurrence.start);

describe("expandRecurrence", () => {
  describe("no rule", () => {
    it("returns just the series start when no rrule and no rdates", () => {
      const result = expand({ seriesStart: utcStart("2026-06-15T14:00:00.000Z") });
      expect(result).toEqual([
        {
          occurrenceKey: "20260615T140000Z",
          start: "2026-06-15T14:00:00.000Z",
          end: "2026-06-15T15:00:00.000Z"
        }
      ]);
    });

    it("returns nothing when the series start is outside the window", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-15T14:00:00.000Z"),
        windowStart: "2026-07-01T00:00:00.000Z",
        windowEnd: "2026-08-01T00:00:00.000Z"
      });
      expect(result).toEqual([]);
    });
  });

  describe("daily", () => {
    it("expands COUNT instances", () => {
      const result = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;COUNT=5" });
      expect(starts(result)).toEqual([
        "2026-06-01T14:00:00.000Z",
        "2026-06-02T14:00:00.000Z",
        "2026-06-03T14:00:00.000Z",
        "2026-06-04T14:00:00.000Z",
        "2026-06-05T14:00:00.000Z"
      ]);
      expect(result[0].occurrenceKey).toBe("20260601T140000Z");
      expect(result[0].end).toBe("2026-06-01T15:00:00.000Z");
    });

    it("treats UNTIL (Z form) as inclusive", () => {
      const onBoundary = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;UNTIL=20260605T140000Z" });
      expect(starts(onBoundary)).toHaveLength(5);
      expect(starts(onBoundary)[4]).toBe("2026-06-05T14:00:00.000Z");

      const justBefore = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;UNTIL=20260605T135959Z" });
      expect(starts(justBefore)).toHaveLength(4);
    });

    it("treats UNTIL date form as inclusive of the whole day", () => {
      const result = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;UNTIL=20260605" });
      expect(starts(result)).toHaveLength(5);
      expect(starts(result)[4]).toBe("2026-06-05T14:00:00.000Z");
    });

    it("supports local-time UNTIL", () => {
      const result = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;UNTIL=20260603T140000" });
      expect(starts(result)).toHaveLength(3);
    });

    it("respects INTERVAL", () => {
      const result = expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=DAILY;INTERVAL=3;COUNT=3" });
      expect(starts(result)).toEqual(["2026-06-01T14:00:00.000Z", "2026-06-04T14:00:00.000Z", "2026-06-07T14:00:00.000Z"]);
    });
  });

  describe("weekly", () => {
    it("expands multiple BYDAY values across a window", () => {
      // 2026-06-02 is a Tuesday.
      const result = expand({
        seriesStart: utcStart("2026-06-02T15:00:00.000Z"),
        rrule: "FREQ=WEEKLY;BYDAY=TU,TH",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-06-19T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "2026-06-02T15:00:00.000Z",
        "2026-06-04T15:00:00.000Z",
        "2026-06-09T15:00:00.000Z",
        "2026-06-11T15:00:00.000Z",
        "2026-06-16T15:00:00.000Z",
        "2026-06-18T15:00:00.000Z"
      ]);
    });

    it("INTERVAL=2 honors WKST=MO week boundaries (RFC 5545 example)", () => {
      // DTSTART 1997-08-05 is a Tuesday.
      const result = expand({
        seriesStart: utcStart("1997-08-05T09:00:00.000Z"),
        rrule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO",
        windowStart: "1997-08-01T00:00:00.000Z",
        windowEnd: "1997-10-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "1997-08-05T09:00:00.000Z",
        "1997-08-10T09:00:00.000Z",
        "1997-08-19T09:00:00.000Z",
        "1997-08-24T09:00:00.000Z"
      ]);
    });

    it("INTERVAL=2 honors WKST=SU week boundaries (RFC 5545 example)", () => {
      const result = expand({
        seriesStart: utcStart("1997-08-05T09:00:00.000Z"),
        rrule: "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU",
        windowStart: "1997-08-01T00:00:00.000Z",
        windowEnd: "1997-10-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "1997-08-05T09:00:00.000Z",
        "1997-08-17T09:00:00.000Z",
        "1997-08-19T09:00:00.000Z",
        "1997-08-31T09:00:00.000Z"
      ]);
    });

    it("includes a DTSTART that does not match the pattern as the first instance", () => {
      // 2026-06-03 is a Wednesday; the rule only generates Mondays.
      const result = expand({ seriesStart: utcStart("2026-06-03T14:00:00.000Z"), rrule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3" });
      expect(starts(result)).toEqual(["2026-06-03T14:00:00.000Z", "2026-06-08T14:00:00.000Z", "2026-06-15T14:00:00.000Z"]);
    });
  });

  describe("monthly", () => {
    it("expands BYDAY=2TU (second Tuesday)", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-09T16:00:00.000Z"),
        rrule: "FREQ=MONTHLY;BYDAY=2TU",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "2026-06-09T16:00:00.000Z",
        "2026-07-14T16:00:00.000Z",
        "2026-08-11T16:00:00.000Z",
        "2026-09-08T16:00:00.000Z"
      ]);
    });

    it("expands BYDAY=TU;BYSETPOS=2 identically to BYDAY=2TU", () => {
      const input = {
        seriesStart: utcStart("2026-06-09T16:00:00.000Z"),
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z"
      };
      const viaSetPos = expand({ ...input, rrule: "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2" });
      const viaOrdinal = expand({ ...input, rrule: "FREQ=MONTHLY;BYDAY=2TU" });
      expect(starts(viaSetPos)).toEqual(starts(viaOrdinal));
    });

    it("expands BYSETPOS=-1 (last Friday)", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-26T17:00:00.000Z"),
        rrule: "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual(["2026-06-26T17:00:00.000Z", "2026-07-31T17:00:00.000Z", "2026-08-28T17:00:00.000Z"]);
    });

    it("BYMONTHDAY=31 skips months without a 31st", () => {
      const result = expand({
        seriesStart: utcStart("2026-01-31T10:00:00.000Z"),
        rrule: "FREQ=MONTHLY;BYMONTHDAY=31",
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2027-01-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "2026-01-31T10:00:00.000Z",
        "2026-03-31T10:00:00.000Z",
        "2026-05-31T10:00:00.000Z",
        "2026-07-31T10:00:00.000Z",
        "2026-08-31T10:00:00.000Z",
        "2026-10-31T10:00:00.000Z",
        "2026-12-31T10:00:00.000Z"
      ]);
    });

    it("falls back to DTSTART's day-of-month and skips short months", () => {
      const result = expand({ seriesStart: utcStart("2026-01-31T10:00:00.000Z"), rrule: "FREQ=MONTHLY;COUNT=3" });
      expect(starts(result)).toEqual(["2026-01-31T10:00:00.000Z", "2026-03-31T10:00:00.000Z", "2026-05-31T10:00:00.000Z"]);
    });
  });

  describe("yearly", () => {
    it("expands a simple yearly anniversary", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-15T14:00:00.000Z"),
        rrule: "FREQ=YEARLY",
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2029-01-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual(["2026-06-15T14:00:00.000Z", "2027-06-15T14:00:00.000Z", "2028-06-15T14:00:00.000Z"]);
    });

    it("expands BYMONTH with BYDAY ordinal", () => {
      // Third Tuesday of June: 2026-06-16, 2027-06-15.
      const result = expand({
        seriesStart: utcStart("2026-06-16T14:00:00.000Z"),
        rrule: "FREQ=YEARLY;BYMONTH=6;BYDAY=3TU",
        windowStart: "2026-01-01T00:00:00.000Z",
        windowEnd: "2028-01-01T00:00:00.000Z"
      });
      expect(starts(result)).toEqual(["2026-06-16T14:00:00.000Z", "2027-06-15T14:00:00.000Z"]);
    });
  });

  describe("DST correctness (America/New_York)", () => {
    const weeklyNineAm = {
      seriesStart: {
        utc: "2026-03-02T14:00:00.000Z",
        wallClock: "2026-03-02T09:00:00",
        timeZone: "America/New_York"
      },
      rrule: "FREQ=WEEKLY;BYDAY=MO"
    };

    it("keeps 09:00 local across the 2026-03-08 spring-forward (UTC shifts -05 to -04)", () => {
      const result = expand({
        ...weeklyNineAm,
        windowStart: "2026-03-01T00:00:00.000Z",
        windowEnd: "2026-03-20T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "2026-03-02T14:00:00.000Z",
        "2026-03-09T13:00:00.000Z",
        "2026-03-16T13:00:00.000Z"
      ]);
      expect(result.map((occurrence) => occurrence.occurrenceKey)).toEqual([
        "20260302T140000Z",
        "20260309T130000Z",
        "20260316T130000Z"
      ]);
    });

    it("keeps 09:00 local across the 2026-11-01 fall-back (UTC shifts -04 to -05)", () => {
      const result = expand({
        ...weeklyNineAm,
        windowStart: "2026-10-20T00:00:00.000Z",
        windowEnd: "2026-11-10T00:00:00.000Z"
      });
      expect(starts(result)).toEqual([
        "2026-10-26T13:00:00.000Z",
        "2026-11-02T14:00:00.000Z",
        "2026-11-09T14:00:00.000Z"
      ]);
    });

    it("shifts a nonexistent spring-forward local time forward by the gap", () => {
      // 02:30 does not exist on 2026-03-08; it becomes 03:30 EDT = 07:30Z.
      const result = expand({
        seriesStart: {
          utc: "2026-03-07T07:30:00.000Z",
          wallClock: "2026-03-07T02:30:00",
          timeZone: "America/New_York"
        },
        rrule: "FREQ=DAILY;COUNT=3"
      });
      expect(starts(result)).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
    });

    it("resolves an ambiguous fall-back local time to the first (pre-transition) occurrence", () => {
      // 01:30 occurs twice on 2026-11-01; the first is EDT = 05:30Z.
      const result = expand({
        seriesStart: {
          utc: "2026-10-31T05:30:00.000Z",
          wallClock: "2026-10-31T01:30:00",
          timeZone: "America/New_York"
        },
        rrule: "FREQ=DAILY;COUNT=3"
      });
      expect(starts(result)).toEqual(["2026-10-31T05:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    });
  });

  describe("EXDATE and RDATE", () => {
    it("EXDATE removes an instance without extending COUNT", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY;COUNT=5",
        exdates: [utcStart("2026-06-03T14:00:00.000Z")]
      });
      expect(starts(result)).toEqual([
        "2026-06-01T14:00:00.000Z",
        "2026-06-02T14:00:00.000Z",
        "2026-06-04T14:00:00.000Z",
        "2026-06-05T14:00:00.000Z"
      ]);
    });

    it("RDATE adds an instance marked isRdate, merged in sorted order", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY;COUNT=3",
        rdates: [utcStart("2026-06-02T09:00:00.000Z")]
      });
      expect(starts(result)).toEqual([
        "2026-06-01T14:00:00.000Z",
        "2026-06-02T09:00:00.000Z",
        "2026-06-02T14:00:00.000Z",
        "2026-06-03T14:00:00.000Z"
      ]);
      expect(result.map((occurrence) => occurrence.isRdate)).toEqual([undefined, true, undefined, undefined]);
    });

    it("dedupes an RDATE that matches a rule-generated instance", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY;COUNT=3",
        rdates: [utcStart("2026-06-02T14:00:00.000Z")]
      });
      expect(starts(result)).toHaveLength(3);
      expect(result.every((occurrence) => occurrence.isRdate === undefined)).toBe(true);
    });
  });

  describe("windowing and caps", () => {
    it("window clipping preserves COUNT semantics computed from the true series start", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY;COUNT=10",
        windowStart: "2026-06-06T00:00:00.000Z",
        windowEnd: "2026-07-01T00:00:00.000Z"
      });
      // Instances 6 through 10 only — COUNT is not restarted at the window edge.
      expect(starts(result)).toEqual([
        "2026-06-06T14:00:00.000Z",
        "2026-06-07T14:00:00.000Z",
        "2026-06-08T14:00:00.000Z",
        "2026-06-09T14:00:00.000Z",
        "2026-06-10T14:00:00.000Z"
      ]);
    });

    it("caps returned instances at maxOccurrences", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2026-08-01T00:00:00.000Z",
        maxOccurrences: 5
      });
      expect(starts(result)).toHaveLength(5);
      expect(starts(result)[0]).toBe("2026-06-01T14:00:00.000Z");
    });

    it("defaults maxOccurrences to 1000", () => {
      const result = expand({
        seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
        rrule: "FREQ=DAILY",
        windowStart: "2026-06-01T00:00:00.000Z",
        windowEnd: "2030-01-01T00:00:00.000Z"
      });
      expect(result).toHaveLength(1000);
    });

    it("throws when a pathological rule exceeds the internal iteration cap", () => {
      expect(() =>
        expand({
          seriesStart: utcStart("2026-06-01T14:00:00.000Z"),
          rrule: "FREQ=DAILY",
          windowStart: "2026-06-01T00:00:00.000Z",
          windowEnd: "9999-01-01T00:00:00.000Z"
        })
      ).toThrow(RecurrenceError);
    });
  });

  describe("errors", () => {
    it("throws RecurrenceError for unsupported BYWEEKNO", () => {
      expect(() => expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=YEARLY;BYWEEKNO=20" })).toThrow(RecurrenceError);
      expect(() => expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), rrule: "FREQ=YEARLY;BYWEEKNO=20" })).toThrow(/BYWEEKNO/);
    });

    it("throws for invalid window and series inputs", () => {
      expect(() => expand({ seriesStart: utcStart("not-a-date") })).toThrow(RecurrenceError);
      expect(() =>
        expand({ seriesStart: utcStart("2026-06-01T14:00:00.000Z"), windowStart: "garbage", windowEnd: "2026-07-01T00:00:00.000Z" })
      ).toThrow(RecurrenceError);
    });
  });
});

describe("occurrenceKey helpers", () => {
  it("formats a UTC ISO instant as a basic-format key", () => {
    expect(occurrenceKeyFromUtc("2026-06-15T14:00:00.000Z")).toBe("20260615T140000Z");
    expect(occurrenceKeyFromUtc("2026-01-05T04:09:03.000Z")).toBe("20260105T040903Z");
  });

  it("derives the key from an ICS date-time's utc field", () => {
    expect(
      occurrenceKeyFromIcsDateTime({ utc: "2026-03-09T13:00:00.000Z", wallClock: "2026-03-09T09:00:00", timeZone: "America/New_York" })
    ).toBe("20260309T130000Z");
  });

  it("throws for an unparsable instant", () => {
    expect(() => occurrenceKeyFromUtc("nope")).toThrow(RecurrenceError);
  });
});
