import { RecurrenceError } from "./errors";
import type { IcsDateTimeLike } from "./types";

/** Formats a UTC instant as the canonical occurrence key, e.g. "20260615T140000Z". */
export function occurrenceKeyFromUtc(utcIso: string): string {
  const millis = Date.parse(utcIso);
  if (Number.isNaN(millis)) {
    throw new RecurrenceError(`Invalid UTC instant for occurrence key: ${utcIso}`);
  }
  return occurrenceKeyFromMillis(millis);
}

export function occurrenceKeyFromIcsDateTime(dt: IcsDateTimeLike): string {
  return occurrenceKeyFromUtc(dt.utc);
}

export function occurrenceKeyFromMillis(utcMillis: number): string {
  const date = new Date(utcMillis);
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}` +
    `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`
  );
}
