import { Timestamp } from "../data/firestore-service.js";
import { DEFAULT_STAGE_TEMPLATE, DEFAULT_STAGE_TEMPLATE_NAME, normalizeStageTemplates } from "../templates/module.js";

const DEFAULT_PIPELINE_SETTINGS = {
  dayStartTime: "08:30",
  stages: [
    { id: "stage1", label: "Stage 1", offsetDays: 0, templates: [{ id: "stage1-template-1", name: DEFAULT_STAGE_TEMPLATE_NAME, order: 0, ...DEFAULT_STAGE_TEMPLATE }] },
    { id: "stage2", label: "Stage 2", offsetDays: 2, templates: [{ id: "stage2-template-1", name: DEFAULT_STAGE_TEMPLATE_NAME, order: 0, ...DEFAULT_STAGE_TEMPLATE }] },
    { id: "stage3", label: "Stage 3", offsetDays: 7, templates: [{ id: "stage3-template-1", name: DEFAULT_STAGE_TEMPLATE_NAME, order: 0, ...DEFAULT_STAGE_TEMPLATE }] },
    { id: "stage4", label: "Stage 4", offsetDays: 15, templates: [{ id: "stage4-template-1", name: DEFAULT_STAGE_TEMPLATE_NAME, order: 0, ...DEFAULT_STAGE_TEMPLATE }] },
    { id: "stage5", label: "Stage 5", offsetDays: 30, templates: [{ id: "stage5-template-1", name: DEFAULT_STAGE_TEMPLATE_NAME, order: 0, ...DEFAULT_STAGE_TEMPLATE }] },
  ],
};

const DEFAULT_PUSH_PRESETS = [
  { label: "+1 hour", behavior: { type: "addHours", hours: 1 } },
  { label: "+3 hours", behavior: { type: "addHours", hours: 3 } },
  { label: "Next 12:00 (noon)", behavior: { type: "nextTime", time: "12:00" } },
  { label: "Next 16:00 (4:00 PM)", behavior: { type: "nextTime", time: "16:00" } },
  {
    label: "Next Monday 08:30",
    behavior: { type: "nextWeekdayTime", weekday: 1, time: "08:30" },
  },
];

function cloneDefaultPushPresets() {
  return DEFAULT_PUSH_PRESETS.map((preset) => ({
    label: preset.label,
    behavior: { ...preset.behavior },
  }));
}

function cloneDefaultPipelineSettings() {
  return {
    dayStartTime: DEFAULT_PIPELINE_SETTINGS.dayStartTime,
    stages: DEFAULT_PIPELINE_SETTINGS.stages.map((stage) => ({ ...stage, templates: stage.templates.map((template) => ({ ...template })) })),
  };
}

function cloneDefaultAppSettings() {
  return {
    pipeline: cloneDefaultPipelineSettings(),
    pushPresets: cloneDefaultPushPresets(),
    snapWindowDays: 2,
  };
}

function sanitizeTimeString(rawValue) {
  if (typeof rawValue !== "string") return DEFAULT_PIPELINE_SETTINGS.dayStartTime;
  const match = rawValue.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return DEFAULT_PIPELINE_SETTINGS.dayStartTime;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_PIPELINE_SETTINGS.dayStartTime;
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function normalizePipelineSettings(input) {
  const fallback = cloneDefaultPipelineSettings();
  const stages = Array.isArray(input?.stages) ? input.stages : fallback.stages;

  return {
    dayStartTime: sanitizeTimeString(input?.dayStartTime),
    stages: stages.map((stage, index) => {
      const fallbackStage = fallback.stages[index] || {
        id: `stage${index + 1}`,
        label: `Stage ${index + 1}`,
        offsetDays: index,
        templates: normalizeStageTemplates({ id: `stage${index + 1}` }),
      };

      const parsedOffset = Number.parseInt(stage?.offsetDays, 10);

      const templates = normalizeStageTemplates(stage, fallbackStage);

      return {
        id: String(stage?.id || fallbackStage.id),
        label: String(stage?.label || fallbackStage.label),
        offsetDays: Number.isNaN(parsedOffset) ? fallbackStage.offsetDays : parsedOffset,
        templates,
      };
    }),
  };
}

function normalizePushPresetBehavior(inputBehavior, fallbackBehavior) {
  const type = String(inputBehavior?.type || fallbackBehavior.type);

  if (type === "addHours") {
    const parsedHours = Number.parseInt(inputBehavior?.hours, 10);
    return {
      type,
      hours: Number.isNaN(parsedHours) || parsedHours < 1 ? fallbackBehavior.hours : parsedHours,
    };
  }

  if (type === "nextWeekdayTime") {
    const parsedWeekday = Number.parseInt(inputBehavior?.weekday, 10);
    return {
      type,
      weekday:
        Number.isNaN(parsedWeekday) || parsedWeekday < 0 || parsedWeekday > 6
          ? fallbackBehavior.weekday
          : parsedWeekday,
      time: sanitizeTimeString(inputBehavior?.time || fallbackBehavior.time),
    };
  }

  return {
    type: "nextTime",
    time: sanitizeTimeString(inputBehavior?.time || fallbackBehavior.time),
  };
}

function normalizePushPresets(inputPresets) {
  const fallback = cloneDefaultPushPresets();
  const source = Array.isArray(inputPresets) ? inputPresets : [];

  return fallback.map((fallbackPreset, index) => {
    const incoming = source[index] || {};
    return {
      label: String(incoming.label || fallbackPreset.label),
      behavior: normalizePushPresetBehavior(incoming.behavior, fallbackPreset.behavior),
    };
  });
}

function normalizeAppSettings(input) {
  const pipelineSource = input?.pipeline || input;
  const snapRaw = Number.parseInt(input?.snapWindowDays, 10);
  return {
    pipeline: normalizePipelineSettings(pipelineSource),
    pushPresets: normalizePushPresets(input?.pushPresets),
    snapWindowDays: Number.isNaN(snapRaw) ? 2 : Math.max(0, snapRaw),
  };
}

function getStageById(pipelineSettings, stageId) {
  return pipelineSettings.stages.find((stage) => stage.id === stageId) || null;
}

function getNextStage(pipelineSettings, stageId) {
  const index = pipelineSettings.stages.findIndex((stage) => stage.id === stageId);
  if (index < 0 || index + 1 >= pipelineSettings.stages.length) return null;
  return pipelineSettings.stages[index + 1];
}

function computeOffsetDeltaDays(pipelineSettings, currentStageId, nextStageId) {
  const currentStage = getStageById(pipelineSettings, currentStageId);
  const nextStage = getStageById(pipelineSettings, nextStageId);

  if (!currentStage || !nextStage) return 0;

  return Math.max(0, nextStage.offsetDays - currentStage.offsetDays);
}

function computeNextActionAt(baseNow, deltaDays, dayStartTime) {
  const [hourPart, minutePart] = sanitizeTimeString(dayStartTime).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  const baseDate = new Date(baseNow);
  const targetDate = new Date(baseDate);
  targetDate.setSeconds(0, 0);

  if (
    deltaDays === 0 &&
    (baseDate.getHours() > hours || (baseDate.getHours() === hours && baseDate.getMinutes() > minutes))
  ) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else {
    targetDate.setDate(targetDate.getDate() + deltaDays);
  }

  targetDate.setHours(hours, minutes, 0, 0);
  return Timestamp.fromDate(targetDate);
}

function resolveStageOffsetMilliseconds(stage) {
  if (!stage) return null;

  const minuteOffset = Number.parseInt(stage.defaultFollowUpOffsetMinutes, 10);
  if (!Number.isNaN(minuteOffset) && minuteOffset >= 0) return minuteOffset * 60 * 1000;

  const hourOffset = Number.parseInt(stage.defaultFollowUpOffsetHours, 10);
  if (!Number.isNaN(hourOffset) && hourOffset >= 0) return hourOffset * 60 * 60 * 1000;

  const dayOffset = Number.parseInt(stage.defaultFollowUpOffsetDays, 10);
  if (!Number.isNaN(dayOffset) && dayOffset >= 0) return dayOffset * 24 * 60 * 60 * 1000;

  const legacyDayOffset = Number.parseInt(stage.offsetDays, 10);
  if (!Number.isNaN(legacyDayOffset) && legacyDayOffset >= 0) return legacyDayOffset * 24 * 60 * 60 * 1000;

  return null;
}

function computeInitialLeadNextActionAt(pipelineSettings, stageId, baseNow = new Date()) {
  const selectedStage = getStageById(pipelineSettings, stageId);
  const offsetMilliseconds = resolveStageOffsetMilliseconds(selectedStage);
  if (offsetMilliseconds === null) return null;
  return Timestamp.fromDate(new Date(baseNow.getTime() + offsetMilliseconds));
}


function isLeadDropOutState(lead) {
  return String(lead?.state || "").trim().toLowerCase() === "drop_out";
}

function computePushedTimestamp(baseNow, preset) {
  const behavior = preset?.behavior || {};
  const nowDate = new Date(baseNow);
  const targetDate = new Date(nowDate);
  targetDate.setSeconds(0, 0);

  if (behavior.type === "addHours") {
    targetDate.setHours(targetDate.getHours() + behavior.hours);
    return Timestamp.fromDate(targetDate);
  }

  const [hourPart, minutePart] = sanitizeTimeString(behavior.time).split(":");
  const hours = Number(hourPart);
  const minutes = Number(minutePart);

  if (behavior.type === "nextWeekdayTime") {
    const targetWeekday = Number.parseInt(behavior.weekday, 10);
    const currentWeekday = targetDate.getDay();
    let daysUntil = (targetWeekday - currentWeekday + 7) % 7;
    if (daysUntil === 0) daysUntil = 7;
    targetDate.setDate(targetDate.getDate() + daysUntil);
    targetDate.setHours(hours, minutes, 0, 0);
    return Timestamp.fromDate(targetDate);
  }

  targetDate.setHours(hours, minutes, 0, 0);
  if (targetDate.getTime() <= nowDate.getTime()) {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  return Timestamp.fromDate(targetDate);
}

export {
  cloneDefaultAppSettings,
  computeInitialLeadNextActionAt,
  computeNextActionAt,
  computeOffsetDeltaDays,
  computePushedTimestamp,
  getNextStage,
  getStageById,
  normalizeAppSettings,
  sanitizeTimeString,
  isLeadDropOutState,
};
