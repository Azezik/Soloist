import { addDoc, collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc } from "../data/firestore-service.js";
import { computeTouchpointDate, qualifiesForSnap } from "./snap-engine.js";
import { toPromotionDate } from "./presets.js";

function buildPromotionEvents(promotionId, lead, touchpoints, endDate) {
  return touchpoints.map((touchpoint) => {
    const scheduledDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
    return {
      promotionId,
      leadId: lead.id,
      contactId: lead.contactId || null,
      stageId: lead.stageId || null,
      offsetDays: touchpoint.offsetDays,
      touchpointId: touchpoint.id,
      touchpointOrder: touchpoint.order,
      template: touchpoint.template,
      scheduledFor: Timestamp.fromDate(scheduledDate),
      completed: false,
      archived: false,
      status: "open",
      type: "promotion",
      name: `${lead.name || lead.product || "Lead"} – ${touchpoint.name || "Promo"}`,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
  });
}

async function createPromotion({ db, userId, promotion, selectedLeads, snapWindowDays = 2, presetLabel = "Custom" }) {
  const endDate = toPromotionDate(promotion.endDate);
  if (!endDate) throw new Error("Invalid end date");

  const promotionRef = await addDoc(collection(db, "users", userId, "promotions"), {
    name: promotion.name,
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
    const snapped = qualifiesForSnap(lead, promotion.touchpoints, endDate, snapWindowDays);
    if (snapped) {
      await setDoc(doc(db, "users", userId, "promotions", promotionRef.id, "snapshots", lead.id), {
        leadId: lead.id,
        originalStageId: lead.stageId || null,
        originalScheduledDate: lead.nextActionAt || null,
        snappedAt: serverTimestamp(),
      });
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
