import { addDays, sameDay, startOfDay, startOfWeek, toDate, toDayKey } from "./date-utils.js";

const MONTH_GRID_WEEKS = 6;
const DAYS_IN_WEEK = 7;

function hasSpecificTime(date) {
  return date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0;
}

export function buildMonthGrid(monthDate, weekStartsOn = 0) {
  const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = startOfWeek(monthStart, weekStartsOn);

  const days = [];
  for (let index = 0; index < MONTH_GRID_WEEKS * DAYS_IN_WEEK; index += 1) {
    const date = addDays(gridStart, index);
    days.push({
      date,
      dayKey: toDayKey(date),
      inMonth: date.getMonth() === monthDate.getMonth(),
      isToday: sameDay(date, new Date()),
    });
  }

  return days;
}

export function buildWeekDays(focusedDate, weekStartsOn = 0) {
  const weekStart = startOfWeek(focusedDate, weekStartsOn);
  const days = [];

  for (let index = 0; index < DAYS_IN_WEEK; index += 1) {
    const date = addDays(weekStart, index);
    days.push({
      date,
      dayKey: toDayKey(date),
      isToday: sameDay(date, new Date()),
    });
  }

  return days;
}

export function normalizeCalendarItems(tasks, leads, promotionEvents = []) {
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
        dayKey: toDayKey(date),
        hasTime: hasSpecificTime(date),
        path: `#task/${task.id}`,
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
        dayKey: toDayKey(date),
        hasTime: hasSpecificTime(date),
        path: `#lead/${lead.id}`,
      };
    })
    .filter(Boolean);

  const promotionItems = promotionEvents
    .map((event) => {
      const date = toDate(event.scheduledFor || event.nextActionAt);
      if (!date) return null;
      const itemType = event.type === "promotion_touchpoint" ? "promotion_touchpoint" : event.type === "sequence_step" ? "sequence_step" : event.type === "sequence" ? "sequence" : "promotion";
      return {
        id: event.id,
        type: itemType,
        title: event.title || event.name || "Promotion",
        secondary: itemType === "sequence" || itemType === "sequence_step" ? "Sequence" : "Promotion",
        date,
        dayKey: toDayKey(date),
        hasTime: hasSpecificTime(date),
        path: itemType === "sequence" || itemType === "sequence_step" ? `#sequence-event/${event.id}` : `#promotion-event/${event.id}`,
      };
    })
    .filter(Boolean);

  return [...taskItems, ...leadItems, ...promotionItems].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function buildPromotionReplacementIndex(promotionEvents = []) {
  return promotionEvents.reduce((acc, event) => {
    if (!event?.leadId || !event?.snappedStageId || event.completed || event.archived || event.deleted === true) {
      return acc;
    }

    const key = `${event.leadId}:${event.snappedStageId}`;
    acc.add(key);
    return acc;
  }, new Set());
}

export function buildProjectedLeadItems(leads, pipelineSettings, rangeStart, rangeEnd, promotionEvents = []) {
  if (!Array.isArray(leads) || !Array.isArray(pipelineSettings?.stages)) return [];
  if (!(rangeStart instanceof Date) || Number.isNaN(rangeStart.getTime())) return [];
  if (!(rangeEnd instanceof Date) || Number.isNaN(rangeEnd.getTime())) return [];

  const stages = pipelineSettings.stages;
  const replacedStageKeys = buildPromotionReplacementIndex(promotionEvents);

  return leads.flatMap((lead) => {
    const anchorDate = toDate(lead.nextActionAt);
    if (!anchorDate) return [];

    const anchorStageIndex = stages.findIndex((stage) => stage.id === lead.stageId);
    if (anchorStageIndex < 0) return [];

    const anchorStage = stages[anchorStageIndex];

    return stages
      .slice(anchorStageIndex + 1)
      .map((stage) => {
        const deltaDays = Math.max(0, Number(stage.offsetDays) - Number(anchorStage.offsetDays));
        const projectedDate = new Date(anchorDate.getTime());
        projectedDate.setDate(projectedDate.getDate() + deltaDays);

        if (projectedDate < rangeStart || projectedDate >= rangeEnd) return null;
        if (replacedStageKeys.has(`${lead.id}:${stage.id}`)) return null;

        return {
          id: `lead:${lead.id}:projStage:${stage.id}`,
          sourceLeadId: lead.id,
          type: "lead",
          title: lead.name || lead.company || lead.email || "Unnamed Lead",
          secondary: `Planned · ${stage.label || stage.id}`,
          date: projectedDate,
          dayKey: toDayKey(projectedDate),
          hasTime: hasSpecificTime(projectedDate),
          path: `#lead/${lead.id}`,
          isProjected: true,
          projectedStageId: stage.id,
        };
      })
      .filter(Boolean);
  });
}

export function groupItemsByDay(items) {
  return items.reduce((acc, item) => {
    if (!acc[item.dayKey]) acc[item.dayKey] = [];
    acc[item.dayKey].push(item);
    return acc;
  }, {});
}

export function splitDayItems(items, selectedDay) {
  const dayStart = startOfDay(selectedDay);
  const nextDay = addDays(dayStart, 1);

  const dayItems = items.filter((item) => item.date >= dayStart && item.date < nextDay);
  const timed = [];
  const allDay = [];

  dayItems.forEach((item) => {
    if (item.hasTime) {
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

export function computeTimedBlockStyle(item, timedItems, startHour, endHour) {
  const sameSlot = timedItems.filter(
    (candidate) => candidate.date.getHours() === item.date.getHours() && candidate.date.getMinutes() === item.date.getMinutes()
  );
  const lane = sameSlot.findIndex((candidate) => candidate.id === item.id && candidate.type === item.type);
  const laneCount = Math.max(1, sameSlot.length);
  const width = 100 / laneCount;
  const left = lane * width;

  return {
    top: computeTimePositionPercent(item.date, startHour, endHour),
    left,
    width,
  };
}
