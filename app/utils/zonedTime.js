/**
 * Converts between UTC instants and wall-clock date/time in the shop's IANA
 * time zone, so start/end times are entered and shown the way the merchant
 * thinks of them (Shopify's own discount form does the same).
 */

function partsInZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

// Milliseconds the zone is ahead of UTC at `timestamp`.
function zoneOffset(timestamp, timeZone) {
  const p = partsInZone(timestamp, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (timestamp - (timestamp % 1000));
}

const pad = (n) => String(n).padStart(2, "0");

/** ISO instant -> { date: "YYYY-MM-DD", time: "HH:MM" } in `timeZone`. */
export function toZonedParts(iso, timeZone) {
  if (!iso) return { date: "", time: "" };
  const p = partsInZone(new Date(iso).getTime(), timeZone);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** "YYYY-MM-DD" + "HH:MM" in `timeZone` -> ISO instant, or null without a date. */
export function fromZonedParts(date, time, timeZone) {
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = (time || "00:00").split(":").map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset across DST transitions.
  let instant = wallClock - zoneOffset(wallClock, timeZone);
  instant = wallClock - zoneOffset(instant, timeZone);
  return new Date(instant).toISOString();
}

/** "13:30" -> "1:30 PM" */
export function formatTime(value) {
  const [hour, minute] = value.split(":").map(Number);
  return `${hour % 12 || 12}:${pad(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

/** Half-hour options for a time select, plus 11:59 PM for end-of-day. */
export const TIME_OPTIONS = [
  ...Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? "30" : "00"}`),
  "23:59",
].map((value) => ({ value, label: formatTime(value) }));
