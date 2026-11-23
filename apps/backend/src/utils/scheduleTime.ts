import { CronExpressionParser } from 'cron-parser';
import { DateTime, IANAZone } from 'luxon';
import { BadRequestError } from './errors.js';

/**
 * Regex matching a local wall-clock ISO datetime WITHOUT explicit timezone offset/Z,
 * e.g. "2026-12-01T16:00:00" or "2026-12-01T16:00:00.000".
 */
const WALL_CLOCK_ISO_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/**
 * Validates an IANA timezone identifier (e.g. "UTC", "Asia/Kolkata", "America/New_York").
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') {
    return false;
  }
  const trimmed = timezone.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    return false;
  }
  return IANAZone.isValidZone(trimmed);
}

/**
 * Parses a one-time scheduled timestamp into a canonical UTC Date.
 *
 * Supported formats:
 * 1. ISO-8601 with explicit offset or `Z` (e.g. "2026-12-01T10:30:00Z", "2026-12-01T16:00:00+05:30"):
 *    Converted directly to canonical UTC.
 * 2. Local wall-clock ISO datetime without offset (e.g. "2026-12-01T16:00:00"):
 *    Interpreted in the specified IANA `timezone` and converted to canonical UTC.
 *
 * Daylight-Saving Time (DST) policy:
 * - Nonexistent local times (spring-forward gap, e.g. 02:30 in America/New_York on DST start day):
 *   Rejected with HTTP 400 so schedules never silently shift by 1 hour.
 * - Ambiguous local times (fall-back overlap, e.g. 01:30 in America/New_York on DST end day):
 *   Deterministically resolved by Luxon to the standard-time (second) occurrence when no
 *   explicit offset is supplied; callers needing the earlier daylight-saving occurrence may
 *   supply an explicit ISO-8601 offset (e.g. "2027-11-07T01:30:00-04:00").
 */
export function parseScheduledTimestamp(
  input: string,
  timezone: string = 'UTC',
  now: Date = new Date(),
): Date {
  if (!isValidTimezone(timezone)) {
    throw new BadRequestError(`Invalid IANA timezone identifier "${timezone}"`);
  }

  const trimmed = input.trim();
  const wallClockMatch = WALL_CLOCK_ISO_REGEX.exec(trimmed);

  let dt: DateTime;

  if (wallClockMatch) {
    const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr = '0', msStr = '0'] =
      wallClockMatch;
    const reqYear = parseInt(yearStr, 10);
    const reqMonth = parseInt(monthStr, 10);
    const reqDay = parseInt(dayStr, 10);
    const reqHour = parseInt(hourStr, 10);
    const reqMinute = parseInt(minuteStr, 10);
    const reqSecond = parseInt(secondStr, 10);
    const reqMs = parseInt(msStr.padEnd(3, '0'), 10);

    dt = DateTime.fromObject(
      {
        year: reqYear,
        month: reqMonth,
        day: reqDay,
        hour: reqHour,
        minute: reqMinute,
        second: reqSecond,
        millisecond: reqMs,
      },
      { zone: timezone },
    );

    if (!dt.isValid) {
      throw new BadRequestError(
        `Invalid scheduled timestamp "${input}": ${dt.invalidReason ?? 'malformed date'}`,
      );
    }

    // Detect nonexistent DST spring-forward local time (Luxon shifts skipped hour forward)
    if (
      dt.year !== reqYear ||
      dt.month !== reqMonth ||
      dt.day !== reqDay ||
      dt.hour !== reqHour ||
      dt.minute !== reqMinute
    ) {
      throw new BadRequestError(
        `The local time "${input}" does not exist in timezone "${timezone}" due to a daylight-saving spring-forward transition`,
      );
    }
  } else {
    // Parse ISO-8601 with explicit offset / Z
    dt = DateTime.fromISO(trimmed, { setZone: true });
    if (!dt.isValid) {
      throw new BadRequestError(
        `Invalid scheduled timestamp "${input}". Provide a valid ISO-8601 date-time string.`,
      );
    }
  }

  const utcDate = dt.toUTC().toJSDate();

  if (utcDate.getTime() <= now.getTime()) {
    throw new BadRequestError('Scheduled execution time must be in the future');
  }

  return utcDate;
}

/**
 * Validates a cron expression (5-field, 6-field, or predefined macro like @hourly/@daily/@weekly)
 * in the specified IANA timezone.
 */
export function validateCronExpression(expression: string, timezone: string = 'UTC'): void {
  if (!isValidTimezone(timezone)) {
    throw new BadRequestError(`Invalid IANA timezone identifier "${timezone}"`);
  }

  const trimmed = expression.trim();
  if (!trimmed) {
    throw new BadRequestError('Cron expression cannot be empty');
  }

  try {
    const parsed = CronExpressionParser.parse(trimmed, {
      tz: timezone,
      currentDate: new Date(),
    });
    // Ensure at least one valid future occurrence can be computed
    parsed.next();
  } catch (err) {
    throw new BadRequestError(
      `Invalid cron expression "${expression}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Computes the next canonical UTC execution timestamp for a cron expression in the
 * specified IANA timezone strictly after `fromDate`.
 */
export function computeNextCronRun(
  expression: string,
  timezone: string = 'UTC',
  fromDate: Date = new Date(),
): Date {
  validateCronExpression(expression, timezone);

  const parsed = CronExpressionParser.parse(expression.trim(), {
    tz: timezone,
    currentDate: fromDate,
  });

  return parsed.next().toDate();
}

/**
 * Computes the next `count` upcoming UTC execution timestamps for previewing schedules.
 */
export function computeUpcomingCronRuns(
  expression: string,
  timezone: string = 'UTC',
  count: number = 5,
  fromDate: Date = new Date(),
): Date[] {
  validateCronExpression(expression, timezone);

  const parsed = CronExpressionParser.parse(expression.trim(), {
    tz: timezone,
    currentDate: fromDate,
  });

  const results: Date[] = [];
  const safeCount = Math.max(1, Math.min(20, count));
  for (let i = 0; i < safeCount; i++) {
    results.push(parsed.next().toDate());
  }
  return results;
}

/**
 * Formats a UTC Date in the schedule's IANA timezone as an ISO-8601 string with offset
 * (e.g. "2026-12-01T16:00:00.000+05:30").
 */
export function formatInTimezone(utcDate: Date, timezone: string): string {
  return (
    DateTime.fromJSDate(utcDate, { zone: 'utc' }).setZone(timezone).toISO() ?? utcDate.toISOString()
  );
}
