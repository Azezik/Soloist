import { toPromotionDate } from "./presets.js";

const BASE_TARGETING_KEYS = ["snap_active", "all_active", "drop_out"];

function computeTouchpointDate(endDate, offsetDays) {
  const base = new Date(endDate);
  base.setDate(base.getDate() - Math.max(0, Number(offsetDays) || 0));
  return base;
}

function isLeadActive(lead = {}) {
  const state = String(lead.state || "open").toLowerCase();
  if (state === "closed_won" || state === "closed_lost" || state === "drop_out") return false;
  if (lead.archived || lead.deleted === true) return false;
  return true;
}

function isLeadDropOut(lead = {}) {
  const state = String(lead.state || "").toLowerCase();
  return state === "drop_out";
}

function qualifiesForSnap(lead, touchpoints, endDate, snapWindowDays = 2) {
  if (!isLeadActive(lead)) return false;
  const scheduledAt = toPromotionDate(lead.nextActionAt);
  if (!scheduledAt) return false;
  const touchpointList = Array.isArray(touchpoints) ? touchpoints : [];
  if (!touchpointList.length) return false;

  const dayMs = 24 * 60 * 60 * 1000;
  const windowDays = Math.max(0, Number(snapWindowDays) || 0);
  const scheduledDay = Date.UTC(scheduledAt.getFullYear(), scheduledAt.getMonth(), scheduledAt.getDate());

  return touchpointList.some((touchpoint) => {
    const touchpointDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    const touchpointDay = Date.UTC(touchpointDate.getFullYear(), touchpointDate.getMonth(), touchpointDate.getDate());
    const dayDiff = Math.abs(scheduledDay - touchpointDay) / dayMs;
    return dayDiff <= windowDays;
  });
}

function computeTargetLeads({ leads, promotion, snapWindowDays = 2, searchText = "" }) {
  const endDate = toPromotionDate(promotion.endDate);
  if (!endDate) return [];
  const targeting = Array.isArray(promotion.targeting) ? promotion.targeting : [];
  const text = String(searchText || "").trim().toLowerCase();

  return leads.filter((lead) => {
    const active = isLeadActive(lead);
    const dropOut = isLeadDropOut(lead);
    const snapActive = qualifiesForSnap(lead, promotion.touchpoints || [], endDate, snapWindowDays);
    const eligibleForSearch = active || dropOut;

    const selectedBaseFilters = BASE_TARGETING_KEYS.filter((key) => targeting.includes(key));
    const customSearchSelected = targeting.includes("custom_search");

    let includeByToggle = false;
    if (selectedBaseFilters.length) {
      includeByToggle =
        (selectedBaseFilters.includes("all_active") && active) ||
        (selectedBaseFilters.includes("drop_out") && dropOut) ||
        (selectedBaseFilters.includes("snap_active") && snapActive);
    } else if (customSearchSelected || text) {
      includeByToggle = eligibleForSearch;
    }

    if (!includeByToggle) return false;
    if (!text) return true;

    const haystack = `${lead.name || ""} ${lead.product || ""}`.toLowerCase();
    return haystack.includes(text);
  });
}

export { computeTouchpointDate, isLeadActive, isLeadDropOut, qualifiesForSnap, computeTargetLeads };
