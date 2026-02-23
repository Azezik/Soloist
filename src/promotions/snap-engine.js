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

function getLeadSnapCandidateDays(lead, pipelineStages = []) {
  const scheduledAt = toPromotionDate(lead?.nextActionAt);
  if (!scheduledAt) return [];

  const scheduledDay = Date.UTC(scheduledAt.getFullYear(), scheduledAt.getMonth(), scheduledAt.getDate());

  if (!Array.isArray(pipelineStages) || !pipelineStages.length) return [scheduledDay];

  const stageIndex = pipelineStages.findIndex((stage) => stage.id === lead?.stageId);
  if (stageIndex < 0) return [scheduledDay];

  const anchorOffsetDays = Number(pipelineStages[stageIndex]?.offsetDays) || 0;

  const projectedDays = pipelineStages
    .slice(stageIndex)
    .map((stage) => {
      const stageOffsetDays = Number(stage?.offsetDays);
      if (Number.isNaN(stageOffsetDays)) return null;
      const deltaDays = Math.max(0, stageOffsetDays - anchorOffsetDays);
      return scheduledDay + deltaDays * 24 * 60 * 60 * 1000;
    })
    .filter((day) => Number.isFinite(day));

  return projectedDays.length ? projectedDays : [scheduledDay];
}

function getLeadSnapCandidates(lead, pipelineStages = []) {
  const scheduledAt = toPromotionDate(lead?.nextActionAt);
  if (!scheduledAt) return [];

  const scheduledDay = Date.UTC(scheduledAt.getFullYear(), scheduledAt.getMonth(), scheduledAt.getDate());

  if (!Array.isArray(pipelineStages) || !pipelineStages.length) {
    return [{ day: scheduledDay, stageId: lead?.stageId || null }];
  }

  const stageIndex = pipelineStages.findIndex((stage) => stage.id === lead?.stageId);
  if (stageIndex < 0) {
    return [{ day: scheduledDay, stageId: lead?.stageId || null }];
  }

  const anchorOffsetDays = Number(pipelineStages[stageIndex]?.offsetDays) || 0;
  const candidates = pipelineStages
    .slice(stageIndex)
    .map((stage) => {
      const stageOffsetDays = Number(stage?.offsetDays);
      if (Number.isNaN(stageOffsetDays)) return null;
      const deltaDays = Math.max(0, stageOffsetDays - anchorOffsetDays);
      return {
        day: scheduledDay + deltaDays * 24 * 60 * 60 * 1000,
        stageId: stage?.id || null,
      };
    })
    .filter((entry) => Number.isFinite(entry?.day));

  return candidates.length ? candidates : [{ day: scheduledDay, stageId: lead?.stageId || null }];
}

function findSnapMatch(lead, touchpoints, endDate, snapWindowDays = 2, pipelineStages = []) {
  if (!isLeadActive(lead)) return null;
  const candidateEntries = getLeadSnapCandidates(lead, pipelineStages);
  if (!candidateEntries.length) return null;
  const touchpointList = Array.isArray(touchpoints) ? touchpoints : [];
  if (!touchpointList.length) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  const windowDays = Math.max(0, Number(snapWindowDays) || 0);

  for (const touchpoint of touchpointList) {
    const touchpointDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    const touchpointDay = Date.UTC(touchpointDate.getFullYear(), touchpointDate.getMonth(), touchpointDate.getDate());

    for (const candidate of candidateEntries) {
      const dayDiff = Math.abs(candidate.day - touchpointDay) / dayMs;
      if (dayDiff <= windowDays) {
        return {
          stageId: candidate.stageId,
          candidateDay: candidate.day,
          touchpointId: touchpoint.id,
          touchpointDay,
        };
      }
    }
  }

  return null;
}

function qualifiesForSnap(lead, touchpoints, endDate, snapWindowDays = 2, pipelineStages = []) {
  return Boolean(findSnapMatch(lead, touchpoints, endDate, snapWindowDays, pipelineStages));
}

function computeTargetLeads({ leads, promotion, snapWindowDays = 2, searchText = "", pipelineStages = [] }) {
  const endDate = toPromotionDate(promotion.endDate);
  if (!endDate) return [];
  const targeting = Array.isArray(promotion.targeting) ? promotion.targeting : [];
  const text = String(searchText || "").trim().toLowerCase();

  return leads.filter((lead) => {
    const active = isLeadActive(lead);
    const dropOut = isLeadDropOut(lead);
    const snapActive = qualifiesForSnap(lead, promotion.touchpoints || [], endDate, snapWindowDays, pipelineStages);
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

export { computeTouchpointDate, isLeadActive, isLeadDropOut, qualifiesForSnap, computeTargetLeads, getLeadSnapCandidateDays, findSnapMatch };
