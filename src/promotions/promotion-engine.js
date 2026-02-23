import { addDoc, collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc } from "../data/firestore-service.js";
import { computeTouchpointDate, qualifiesForSnap } from "./snap-engine.js";
import { toPromotionDate } from "./presets.js";

function clampString(value, maxLen) {
  const normalized = String(value || "");
  return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

function buildPromotionEvents(promotionId, lead, touchpoints, endDate) {
  return touchpoints.map((touchpoint) => {
    const scheduledDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    const event = {
      promotionId,
      leadId: lead.id,
      offsetDays: touchpoint.offsetDays,
      touchpointId: touchpoint.id,
      touchpointOrder: touchpoint.order,
      touchpointName: touchpoint.name || `Touchpoint ${Number(touchpoint.order || 0) + 1}`,
      template: touchpoint.template,
      templateConfig: touchpoint.templateConfig || touchpoint.template,
      scheduledFor: Timestamp.fromDate(scheduledDate),
      completed: false,
      archived: false,
      status: "open",
      type: "promotion",
      name: clampString(`${lead.name || lead.product || "Lead"} – ${touchpoint.name || "Promo"}`, 500),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (lead.contactId) event.contactId = lead.contactId;
    if (lead.stageId) event.stageId = lead.stageId;

    return event;
  });
}

async function createPromotion({ db, userId, promotion, selectedLeads, snapWindowDays = 2, pipelineStages = [], presetLabel = "Custom" }) {
  const endDate = toPromotionDate(promotion.endDate);
  if (!endDate) throw new Error("Invalid end date");

  const promotionRef = await addDoc(collection(db, "users", userId, "promotions"), {
    name: clampString(promotion.name, 500),
    endDate: Timestamp.fromDate(endDate),
    touchpoints: promotion.touchpoints,
    targeting: promotion.targeting,
    leadIds: selectedLeads.map((lead) => lead.id),
    presetKey: promotion.presetKey || "custom",
    presetLabel,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    configSnapshot: promotion,
  });

  for (const lead of selectedLeads) {
    const snapped = qualifiesForSnap(lead, promotion.touchpoints, endDate, snapWindowDays, pipelineStages);
    if (snapped) {
      const snapshotPayload = {
        leadId: lead.id,
        originalScheduledDate: lead.nextActionAt || null,
        snappedAt: serverTimestamp(),
      };
      if (lead.stageId) snapshotPayload.originalStageId = lead.stageId;
      await setDoc(doc(db, "users", userId, "promotions", promotionRef.id, "snapshots", lead.id), snapshotPayload);
      await updateDoc(doc(db, "users", userId, "leads", lead.id), {
        nextActionAt: null,
        updatedAt: serverTimestamp(),
      });
    }

    const events = buildPromotionEvents(promotionRef.id, lead, promotion.touchpoints, endDate);
    for (const event of events) {
      await addDoc(collection(db, "users", userId, "promotionEvents"), event);
    }
  }

  return promotionRef.id;
}

export { createPromotion };
