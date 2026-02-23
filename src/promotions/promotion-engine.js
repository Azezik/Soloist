import { addDoc, collection, doc, serverTimestamp, setDoc, Timestamp } from "../data/firestore-service.js";
import { computeTouchpointDate, findSnapMatch } from "./snap-engine.js";
import { toPromotionDate } from "./presets.js";

function clampString(value, maxLen) {
  const normalized = String(value || "");
  return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

function permissionError(step, error) {
  const message = error?.message || "Unknown Firestore error";
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`Promotion save failed at ${step}${code}: ${message}`);
}

function buildPromotionEvents(promotionId, lead, touchpoints, endDate, snappedStageId = null, snapMode = null) {
  return touchpoints.map((touchpoint) => {
    const scheduledDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    const scheduledFor = Timestamp.fromDate(scheduledDate);
    const event = {
      promotionId,
      leadId: lead.id,
      offsetDays: touchpoint.offsetDays,
      touchpointId: touchpoint.id,
      touchpointOrder: touchpoint.order,
      touchpointName: touchpoint.name || `Touchpoint ${Number(touchpoint.order || 0) + 1}`,
      template: touchpoint.template,
      templateConfig: touchpoint.templateConfig || touchpoint.template,
      scheduledFor,
      // Keep this aligned with lead/task scheduling shape so downstream consumers
      // that expect nextActionAt-style fields can treat promotion events the same way.
      nextActionAt: scheduledFor,
      completed: false,
      archived: false,
      deleted: false,
      status: "open",
      type: "promotion",
      title: clampString(touchpoint.name || "Promotion touchpoint", 200),
      summary: clampString(`${lead.name || lead.product || "Lead"} • ${touchpoint.name || "Promotion"}`, 5000),
      name: clampString(`${lead.name || lead.product || "Lead"} – ${touchpoint.name || "Promo"}`, 500),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (lead.contactId) event.contactId = lead.contactId;
    if (lead.stageId) event.stageId = lead.stageId;
    if (snappedStageId) event.snappedStageId = snappedStageId;
    if (snapMode) event.snapMode = snapMode;

    return event;
  });
}

async function createPromotion({
  db,
  userId,
  promotion,
  selectedLeads,
  snapWindowDays = 2,
  pipelineStages = [],
  presetLabel = "Custom",
  snapModeByLead = {},
  selectionSourcesByLead = {},
}) {
  const endDate = toPromotionDate(promotion.endDate);
  if (!endDate) throw new Error("Invalid end date");

  let promotionRef;
  try {
    promotionRef = await addDoc(collection(db, "users", userId, "promotions"), {
      name: clampString(promotion.name, 500),
      endDate: Timestamp.fromDate(endDate),
      touchpoints: promotion.touchpoints,
      targeting: promotion.targeting,
      leadIds: selectedLeads.map((lead) => lead.id),
      snapModeByLead,
      selectionSourcesByLead,
      presetKey: promotion.presetKey || "custom",
      presetLabel,
      status: "active",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      configSnapshot: promotion,
    });
  } catch (error) {
    throw permissionError("promotion document create", error);
  }

  for (const lead of selectedLeads) {
    const snapMatch = findSnapMatch(lead, promotion.touchpoints, endDate, snapWindowDays, pipelineStages);
    if (snapMatch) {
      const snapshotPayload = {
        leadId: lead.id,
        originalScheduledDate: snapMatch.candidateDay ? Timestamp.fromDate(new Date(snapMatch.candidateDay)) : lead.nextActionAt || null,
        snappedAt: serverTimestamp(),
      };
      if (snapMatch.stageId) snapshotPayload.originalStageId = snapMatch.stageId;
      try {
        await setDoc(doc(db, "users", userId, "promotions", promotionRef.id, "snapshots", lead.id), snapshotPayload);
      } catch (error) {
        throw permissionError(`promotion snapshot create for lead ${lead.id}`, error);
      }
    }

    const leadSnapMode = snapModeByLead?.[lead.id] || null;
    const events = buildPromotionEvents(promotionRef.id, lead, promotion.touchpoints, endDate, snapMatch?.stageId || null, leadSnapMode);
    for (const event of events) {
      try {
        await addDoc(collection(db, "users", userId, "events"), event);
      } catch (error) {
        throw permissionError(`promotion event create for lead ${lead.id}`, error);
      }
    }
  }

  return promotionRef.id;
}

export { createPromotion };
