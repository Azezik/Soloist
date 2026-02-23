import { toPromotionDate } from "./presets.js";

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

  const windowMs = Math.max(0, Number(snapWindowDays) || 0) * 24 * 60 * 60 * 1000;
  return touchpoints.some((touchpoint) => {
    const touchpointDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    return Math.abs(scheduledAt.getTime() - touchpointDate.getTime()) <= windowMs;
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

    const includeByToggle =
      (targeting.includes("all_active") && active) ||
      (targeting.includes("drop_out") && dropOut) ||
      (targeting.includes("snap_active") && snapActive);

    if (!includeByToggle) return false;
    if (!targeting.includes("custom_search") || !text) return true;

    const haystack = `${lead.name || ""} ${lead.product || ""}`.toLowerCase();
    return haystack.includes(text);
  });
}

export { computeTouchpointDate, isLeadActive, isLeadDropOut, qualifiesForSnap, computeTargetLeads };
