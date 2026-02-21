export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    const converted = value.toDate();
    return Number.isNaN(converted.getTime()) ? null : converted;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function startOfWeek(date, weekStartsOn = 0) {
  const dayStart = startOfDay(date);
  const offset = (dayStart.getDay() - weekStartsOn + 7) % 7;
  return addDays(dayStart, -offset);
}

export function addWeeks(date, delta) {
  return addDays(date, delta * 7);
}

export function addDays(date, delta) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function toDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromDayKey(dayKey) {
  return toDate(`${dayKey}T00:00:00`);
}

export function formatMonthTitle(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function formatWeekRangeTitle(weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const startMonth = weekStart.toLocaleDateString(undefined, { month: "short" });
  const endMonth = weekEnd.toLocaleDateString(undefined, { month: "short" });
  const startDay = weekStart.getDate();
  const endDay = weekEnd.getDate();
  const endYear = weekEnd.getFullYear();

  if (weekStart.getFullYear() === weekEnd.getFullYear() && weekStart.getMonth() === weekEnd.getMonth()) {
    return `${startMonth} ${startDay}–${endDay}, ${endYear}`;
  }

  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${endYear}`;
}

export function formatDayTitle(date) {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTimeLabel(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
