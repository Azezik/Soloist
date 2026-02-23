import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "../data/firestore-service.js";
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

function deletionError(step, error) {
  const message = error?.message || "Unknown Firestore error";
  const code = error?.code ? ` (${error.code})` : "";
  return new Error(`Promotion deletion failed at ${step}${code}: ${message}`);
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

function toSnapshotTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value;
  const parsed = toPromotionDate(value);
  return parsed ? Timestamp.fromDate(parsed) : null;
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
        originalStageId: lead.stageId || null,
        originalScheduledDate: toSnapshotTimestamp(lead.nextActionAt),
        snappedAt: serverTimestamp(),
      };
      if (snapMatch.stageId) snapshotPayload.expectedSnapStageId = snapMatch.stageId;
      if (snapMatch.candidateDay) snapshotPayload.expectedSnapScheduledDate = Timestamp.fromDate(new Date(snapMatch.candidateDay));
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

async function restoreSnappedLeadsAndDeletePromotion({ db, userId, promotionId }) {
  const promotionRef = doc(db, "users", userId, "promotions", promotionId);
  const promotionSnapshot = await getDoc(promotionRef);
  if (!promotionSnapshot.exists()) return { existed: false, restoredLeadCount: 0, deletedEvents: 0 };

  const [snapshotDocs, eventDocs] = await Promise.all([
    getDocs(collection(db, "users", userId, "promotions", promotionId, "snapshots")),
    getDocs(query(collection(db, "users", userId, "events"), where("promotionId", "==", promotionId))),
  ]);

  for (const snapshotDoc of snapshotDocs.docs) {
    const snapshot = snapshotDoc.data() || {};
    const leadId = snapshot.leadId || snapshotDoc.id;
    if (!leadId) continue;

    const leadRef = doc(db, "users", userId, "leads", leadId);
    const leadSnapshot = await getDoc(leadRef);
    if (!leadSnapshot.exists()) {
      await deleteDoc(snapshotDoc.ref);
      continue;
    }

    const updates = {
      updatedAt: serverTimestamp(),
      snapMode: deleteField(),
      snappedPromotionId: deleteField(),
      snapMetadata: deleteField(),
      snapTemporaryFlags: deleteField(),
    };

    if (Object.prototype.hasOwnProperty.call(snapshot, "originalStageId")) {
      updates.stageId = snapshot.originalStageId || null;
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, "originalScheduledDate")) {
      updates.nextActionAt = snapshot.originalScheduledDate || null;
    }

    try {
      await updateDoc(leadRef, updates);
      await deleteDoc(snapshotDoc.ref);
    } catch (error) {
      throw deletionError(`lead restoration for ${leadId}`, error);
    }
  }

  for (const eventDoc of eventDocs.docs) {
    try {
      await deleteDoc(eventDoc.ref);
    } catch (error) {
      throw deletionError(`promotion event delete ${eventDoc.id}`, error);
    }
  }

  try {
    await deleteDoc(promotionRef);
  } catch (error) {
    throw deletionError("promotion document delete", error);
  }

  return {
    existed: true,
    restoredLeadCount: snapshotDocs.size,
    deletedEvents: eventDocs.size,
  };
}

export { createPromotion, restoreSnappedLeadsAndDeletePromotion };
