import { sameDay, startOfDay, toDate, toDayKey } from "./date-utils.js";

const MONTH_GRID_WEEKS = 6;
const DAYS_IN_WEEK = 7;

export function buildMonthGrid(monthDate, weekStartsOn = 0) {
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const dayOfWeek = monthStart.getDay();
  const offset = (dayOfWeek - weekStartsOn + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const gridStart = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - offset);

  const days = [];
  for (let index = 0; index < MONTH_GRID_WEEKS * DAYS_IN_WEEK; index += 1) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    days.push({
      date,
      dayKey: toDayKey(date),
      inMonth: date.getMonth() === monthDate.getMonth(),
      isToday: sameDay(date, new Date()),
    });
  }

  return days;
}

export function normalizeCalendarItems(tasks, leads) {
  const taskItems = tasks
    .map((task) => {
      const date = toDate(task.scheduledFor);
      if (!date) return null;
      return {
        id: task.id,
        type: "task",
        title: task.title || "Untitled Task",
        secondary: task.category || "",
        date,
      };
    })
    .filter(Boolean);

  const leadItems = leads
    .map((lead) => {
      const date = toDate(lead.nextActionAt);
      if (!date) return null;
      return {
        id: lead.id,
        type: "lead",
        title: lead.name || lead.company || lead.email || "Unnamed Lead",
        secondary: lead.stageStatus || "",
        date,
      };
    })
    .filter(Boolean);

  return [...taskItems, ...leadItems].sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function groupItemsByDay(items) {
  return items.reduce((acc, item) => {
    const key = toDayKey(item.date);
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
}

export function splitDayItems(items, selectedDay) {
  const dayStart = startOfDay(selectedDay);
  const nextDay = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);

  const dayItems = items.filter((item) => item.date >= dayStart && item.date < nextDay);
  const timed = [];
  const allDay = [];

  dayItems.forEach((item) => {
    const hasSpecificTime = item.date.getHours() !== 0 || item.date.getMinutes() !== 0;
    if (hasSpecificTime) {
      timed.push(item);
      return;
    }

    allDay.push(item);
  });

  return { timed, allDay };
}

export function computeTimePositionPercent(date, startHour, endHour) {
  const startMinutes = startHour * 60;
  const endMinutes = endHour * 60;
  const total = endMinutes - startMinutes;
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const clamped = Math.min(Math.max(minuteOfDay, startMinutes), endMinutes);
  return ((clamped - startMinutes) / total) * 100;
}
