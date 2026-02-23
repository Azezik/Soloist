import { normalizePromotionTemplateConfig, toPromotionTemplatePayload } from "../templates/module.js";

const PROMOTION_PRESETS = {
  precision_strike: {
    key: "precision_strike",
    label: "Precision Strike",
    touchpoints: [2],
    targeting: ["snap_active"],
  },
  deadline_push: {
    key: "deadline_push",
    label: "Deadline Push",
    touchpoints: [5, 1],
    targeting: ["snap_active", "all_active"],
  },
  high_impact: {
    key: "high_impact",
    label: "High Impact",
    touchpoints: [7, 2, 0],
    targeting: ["all_active", "drop_out"],
  },
  revival: {
    key: "revival",
    label: "Revival",
    touchpoints: [2],
    targeting: ["drop_out"],
  },
  custom: {
    key: "custom",
    label: "Custom",
    touchpoints: [],
    targeting: [],
  },
};

const TARGETING_OPTIONS = [
  { id: "snap_active", label: "Snap Active Leads" },
  { id: "drop_out", label: "All Drop-Off Leads" },
  { id: "all_active", label: "All Active" },
  { id: "custom_search", label: "Custom Search" },
];

function toPromotionDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildPromotionTouchpoints(rawTouchpoints = []) {
  return rawTouchpoints
    .map((entry, index) => {
      const offsetDays = Number.parseInt(entry?.offsetDays, 10);
      const templateSource = entry?.templateConfig || entry?.template || {};
      const normalizedTemplate = normalizePromotionTemplateConfig(templateSource);
      const touchpointOrder = Number.isInteger(entry?.order) ? entry.order : index;
      return {
        id: String(entry?.id || `touchpoint-${index + 1}`),
        name: String(entry?.name || `Touchpoint ${touchpointOrder + 1}`),
        order: touchpointOrder,
        offsetDays: Number.isNaN(offsetDays) ? 0 : Math.max(0, offsetDays),
        template: toPromotionTemplatePayload(normalizedTemplate),
        templateConfig: normalizedTemplate,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export { PROMOTION_PRESETS, TARGETING_OPTIONS, toPromotionDate, buildPromotionTouchpoints };
