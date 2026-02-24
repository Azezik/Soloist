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
import { computeNextActionAt, computeOffsetDeltaDays } from "../domain/settings.js";
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

function buildPromotionTouchpointEvent({ promotionId, promotionName, touchpoint, endDate }) {
  const scheduledDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
  const scheduledFor = Timestamp.fromDate(scheduledDate);
  const touchpointName = touchpoint.name || `Touchpoint ${Number(touchpoint.order || 0) + 1}`;
  const title = clampString(`${promotionName || "Promotion"} — ${touchpointName}`, 200);

  return {
    id: `promotion_${promotionId}_touchpoint_${touchpoint.id}`,
    type: "promotion_touchpoint",
    promotionId,
    touchpointId: touchpoint.id,
    touchpointOrder: touchpoint.order,
    touchpointName,
    template: touchpoint.template,
    templateConfig: touchpoint.templateConfig || touchpoint.template,
    offsetDays: touchpoint.offsetDays,
    title,
    name: title,
    summary: clampString(`${promotionName || "Promotion"} · ${touchpointName}`, 5000),
    scheduledFor,
    nextActionAt: scheduledFor,
    completed: false,
    archived: false,
    deleted: false,
    status: "open",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function toSnapshotTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value;
  const parsed = toPromotionDate(value);
  return parsed ? Timestamp.fromDate(parsed) : null;
}

function normalizeSelectionSources(selectionSourcesByLead = {}, leadId) {
  const rawSources = selectionSourcesByLead?.[leadId];
  if (Array.isArray(rawSources)) return rawSources;
  if (typeof rawSources === "string" && rawSources) return [rawSources];
  return [];
}

function wasAddedViaSnapActive(selectionSourcesByLead = {}, leadId) {
  return normalizeSelectionSources(selectionSourcesByLead, leadId).includes("snap_active");
}

function getStageIndexById(pipelineStages = [], stageId = null) {
  if (!stageId) return -1;
  return pipelineStages.findIndex((stage) => stage?.id === stageId);
}

function computePipelineSettingsHash(pipelineSettings = null) {
  if (!pipelineSettings || typeof pipelineSettings !== "object") return "";
  const canonicalPayload = {
    stages: Array.isArray(pipelineSettings?.stages)
      ? pipelineSettings.stages.map((stage) => ({
          id: stage?.id || "",
          offsetDays: Number(stage?.offsetDays) || 0,
        }))
      : [],
  };
  const serialized = JSON.stringify(canonicalPayload);
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash << 5) - hash + serialized.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

function isDevMode() {
  if (typeof window === "undefined") return false;
  const host = String(window.location?.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

function logRestoreDecision({
  leadId,
  promotionId,
  shouldRecompute,
  leadLastActionAt,
  prePromoLastActionAt,
  pipelineHashMismatch,
}) {
  if (!isDevMode()) return;
  console.info("[promotion-restore-decision]", {
    leadId,
    promotionId,
    shouldRecompute,
    leadLastActionAt: leadLastActionAt || null,
    prePromoLastActionAt: prePromoLastActionAt || null,
    pipelineHashMismatch: Boolean(pipelineHashMismatch),
  });
}

function logSnapOverwrite({ leadId, promotionId, snapMatch }) {
  if (!isDevMode()) return;
  console.info("[promotion-snap-overwrite]", {
    leadId,
    promotionId,
    stageId: snapMatch?.stageId || null,
    stageIndex: Number.isInteger(snapMatch?.stageIndex) ? snapMatch.stageIndex : null,
    candidateDay: Number.isFinite(snapMatch?.candidateDay) ? snapMatch.candidateDay : null,
    touchpointId: snapMatch?.touchpointId || null,
    touchpointDay: Number.isFinite(snapMatch?.touchpointDay) ? snapMatch.touchpointDay : null,
    dayDiff: Number.isFinite(snapMatch?.dayDiff) ? snapMatch.dayDiff : null,
  });
}

function logSnapRestore({ leadId, promotionId, snapshot }) {
  if (!isDevMode()) return;
  console.info("[promotion-snap-restore]", {
    leadId,
    promotionId,
    replacedStageId: snapshot?.replacedStageId || snapshot?.expectedSnapStageId || null,
    replacedStageIndex: Number.isInteger(snapshot?.replacedStageIndex) ? snapshot.replacedStageIndex : null,
    replacedCandidateDay: Number.isFinite(snapshot?.replacedCandidateDay)
      ? snapshot.replacedCandidateDay
      : Number.isFinite(snapshot?.matchedCandidateDay)
      ? snapshot.matchedCandidateDay
      : null,
    matchedTouchpointId: snapshot?.matchedTouchpointId || null,
    matchedTouchpointDay: Number.isFinite(snapshot?.matchedTouchpointDay) ? snapshot.matchedTouchpointDay : null,
  });
}

function normalizeSnapMatchForPersistence(rawMatch = {}, pipelineStages = []) {
  if (!rawMatch || typeof rawMatch !== "object") return null;
  const stageId = rawMatch.stageId || null;
  const stageIndexFromMatch = Number.isInteger(rawMatch.stageIndex) ? rawMatch.stageIndex : getStageIndexById(pipelineStages, stageId);
  const stageIndex = Number.isInteger(stageIndexFromMatch) && stageIndexFromMatch >= 0 ? stageIndexFromMatch : -1;
  const candidateDay = Number.isFinite(rawMatch.candidateDay) ? rawMatch.candidateDay : null;
  const touchpointDay = Number.isFinite(rawMatch.touchpointDay) ? rawMatch.touchpointDay : null;
  const touchpointOrder = Number.isFinite(rawMatch.touchpointOrder) ? rawMatch.touchpointOrder : 0;
  const dayDiff = Number.isFinite(rawMatch.dayDiff) ? rawMatch.dayDiff : null;

  if (!stageId || !Number.isFinite(candidateDay) || !rawMatch.touchpointId || !Number.isFinite(touchpointDay)) {
    return null;
  }

  return {
    leadId: rawMatch.leadId || null,
    stageId,
    stageIndex,
    candidateDay,
    touchpointId: rawMatch.touchpointId,
    touchpointDay,
    touchpointOrder,
    dayDiff,
  };
}

function computeRecalculatedStageTimestamp({
  pipelineSettings,
  replacedStageId,
  replacedStageIndex,
  previousStageId,
  anchorTimestamp,
}) {
  const anchorDate = toPromotionDate(anchorTimestamp) || new Date();
  if (!Array.isArray(pipelineSettings?.stages) || !pipelineSettings.stages.length || !replacedStageId) {
    return Timestamp.fromDate(anchorDate);
  }

  const stages = pipelineSettings.stages;
  const index = Number.isInteger(replacedStageIndex) && replacedStageIndex >= 0 ? replacedStageIndex : getStageIndexById(stages, replacedStageId);
  if (index < 0) return Timestamp.fromDate(anchorDate);

  const fallbackPreviousStageId = index > 0 ? stages[index - 1]?.id || null : null;
  const sourceStageId = previousStageId || fallbackPreviousStageId || replacedStageId;
  const deltaDays = Math.max(0, computeOffsetDeltaDays(pipelineSettings, sourceStageId, replacedStageId));
  return computeNextActionAt(anchorDate, deltaDays, pipelineSettings.dayStartTime);
}

async function restoreLeadFromPromotionSnapshot({ leadRef, leadData = {}, snapshot = {}, pipelineSettings = null, reason = "" }) {
  const replacedStageId = snapshot.replacedStageId || snapshot.expectedSnapStageId || null;
  if (!replacedStageId) return false;

  const leadLastActionAtDate = toPromotionDate(leadData.lastActionAt);
  const prePromoLastActionAtDate = toPromotionDate(snapshot.prePromoLastActionAt);
  const prePromoNextActionAt = toSnapshotTimestamp(snapshot.prePromoNextActionAt);

  const currentPipelineHash = computePipelineSettingsHash(pipelineSettings);
  const snapshotPipelineHash = String(snapshot.prePromoPipelineHash || "");
  const pipelineHashMismatch = Boolean(snapshotPipelineHash) && currentPipelineHash !== snapshotPipelineHash;

  const nonPromoAnchorDriftDetected =
    leadLastActionAtDate &&
    prePromoLastActionAtDate &&
    leadLastActionAtDate.getTime() > prePromoLastActionAtDate.getTime() &&
    String(leadData.lastActionSource || "") !== "promotion_touchpoint";

  const shouldRecompute = pipelineHashMismatch || nonPromoAnchorDriftDetected || !prePromoNextActionAt;

  const recalculatedNextActionAt = computeRecalculatedStageTimestamp({
    pipelineSettings,
    replacedStageId,
    replacedStageIndex: snapshot.replacedStageIndex,
    previousStageId: snapshot.previousStageId,
    anchorTimestamp: snapshot.lastCompletedNonPromoStageAt || leadData.lastActionAt,
  });

  logRestoreDecision({
    leadId: snapshot.leadId || null,
    promotionId: snapshot.promotionId || leadData.snappedPromotionId || null,
    shouldRecompute,
    leadLastActionAt: leadLastActionAtDate?.toISOString?.() || null,
    prePromoLastActionAt: prePromoLastActionAtDate?.toISOString?.() || null,
    pipelineHashMismatch,
  });

  logSnapRestore({
    leadId: snapshot.leadId || null,
    promotionId: snapshot.promotionId || leadData.snappedPromotionId || null,
    snapshot,
  });

  await updateDoc(leadRef, {
    stageId: replacedStageId,
    stageStatus: "pending",
    status: "open",
    archived: false,
    nextActionAt: shouldRecompute ? recalculatedNextActionAt : prePromoNextActionAt,
    snapMode: deleteField(),
    snappedPromotionId: deleteField(),
    snapMetadata: deleteField(),
    snapTemporaryFlags: deleteField(),
    updatedAt: serverTimestamp(),
  });

  return Boolean(reason);
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
  snapMatchByLead = {},
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
      snapMatchByLead,
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

  const pipelineSettingsHash = computePipelineSettingsHash({ stages: pipelineStages });

  for (const touchpoint of promotion.touchpoints) {
    const touchpointEvent = buildPromotionTouchpointEvent({
      promotionId: promotionRef.id,
      promotionName: promotion.name,
      touchpoint,
      endDate,
    });

    try {
      const { id, ...payload } = touchpointEvent;
      await setDoc(doc(db, "users", userId, "events", id), payload, { merge: true });
      await setDoc(
        doc(db, "users", userId, "promotions", promotionRef.id, "touchpoints", touchpoint.id),
        {
          promotionId: promotionRef.id,
          touchpointId: touchpoint.id,
          touchpointOrder: touchpoint.order,
          touchpointName: touchpoint.name || `Touchpoint ${Number(touchpoint.order || 0) + 1}`,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      throw permissionError(`promotion touchpoint event create for ${touchpoint.id}`, error);
    }
  }

  for (const lead of selectedLeads) {
    const snapEligible = wasAddedViaSnapActive(selectionSourcesByLead, lead.id);
    const persistedSnapMatch = normalizeSnapMatchForPersistence(snapMatchByLead?.[lead.id], pipelineStages);
    const computedSnapMatch = snapEligible
      ? normalizeSnapMatchForPersistence(findSnapMatch(lead, promotion.touchpoints, endDate, snapWindowDays, pipelineStages), pipelineStages)
      : null;
    const snapMatch = persistedSnapMatch || computedSnapMatch;
    if (snapEligible && snapMatch) {
      const replacedStageIndex = Number.isInteger(snapMatch.stageIndex) && snapMatch.stageIndex >= 0
        ? snapMatch.stageIndex
        : getStageIndexById(pipelineStages, snapMatch.stageId);
      const previousStageId = replacedStageIndex > 0 ? pipelineStages[replacedStageIndex - 1]?.id || null : null;
      const snapshotPayload = {
        leadId: lead.id,
        promotionId: promotionRef.id,
        addedViaSnapActive: true,
        replacedStageId: snapMatch.stageId || null,
        replacedStageIndex,
        previousStageId,
        replacedCandidateDay: snapMatch.candidateDay,
        matchedTouchpointId: snapMatch.touchpointId,
        matchedTouchpointDay: snapMatch.touchpointDay,
        snapMatchDayDiff: snapMatch.dayDiff,
        originalStageId: lead.stageId || null,
        originalScheduledDate: toSnapshotTimestamp(lead.nextActionAt),
        lastCompletedNonPromoStageAt: toSnapshotTimestamp(lead.lastActionAt),
        completedTouchpointCount: 0,
        zeroTouchpointsCompleted: true,
        lastCompletedPromotionTouchpointAt: null,
        prePromoStageId: snapMatch.stageId || null,
        prePromoNextActionAt: toSnapshotTimestamp(lead.nextActionAt),
        prePromoLastActionAt: toSnapshotTimestamp(lead.lastActionAt),
        prePromoCreatedAt: serverTimestamp(),
        prePromoPipelineHash: pipelineSettingsHash,
        snappedAt: serverTimestamp(),
      };
      if (snapMatch.stageId) snapshotPayload.expectedSnapStageId = snapMatch.stageId;
      if (snapMatch.candidateDay) snapshotPayload.expectedSnapScheduledDate = Timestamp.fromDate(new Date(snapMatch.candidateDay));
      logSnapOverwrite({ leadId: lead.id, promotionId: promotionRef.id, snapMatch });
      try {
        await setDoc(doc(db, "users", userId, "promotions", promotionRef.id, "snapshots", lead.id), snapshotPayload);
        await updateDoc(doc(db, "users", userId, "leads", lead.id), {
          snapMetadata: {
            promotionId: promotionRef.id,
            replacedStageId: snapMatch.stageId || null,
            replacedStageIndex,
            replacedCandidateDay: snapMatch.candidateDay,
            matchedTouchpointId: snapMatch.touchpointId,
            matchedTouchpointDay: snapMatch.touchpointDay,
            previousStageId,
            snapWindowDays: Math.max(0, Number(snapWindowDays) || 0),
            addedViaSnapActive: true,
          },
          snappedPromotionId: promotionRef.id,
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        throw permissionError(`promotion snapshot create for lead ${lead.id}`, error);
      }
    }

    for (const touchpoint of promotion.touchpoints) {
      const statusRef = doc(
        db,
        "users",
        userId,
        "promotions",
        promotionRef.id,
        "touchpoints",
        touchpoint.id,
        "statuses",
        lead.id
      );

      try {
        await setDoc(
          statusRef,
          {
            leadId: lead.id,
            touchpointId: touchpoint.id,
            promotionId: promotionRef.id,
            status: "open",
            completed: false,
            skipped: false,
            snapEligible,
            snapMode: snapModeByLead?.[lead.id] || null,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (error) {
        throw permissionError(`promotion status create for lead ${lead.id}`, error);
      }
    }
  }

  return promotionRef.id;
}

async function restoreSnappedLeadsAndDeletePromotion({ db, userId, promotionId }) {
  const promotionRef = doc(db, "users", userId, "promotions", promotionId);
  const promotionSnapshot = await getDoc(promotionRef);
  if (!promotionSnapshot.exists()) return { existed: false, restoredLeadCount: 0, deletedEvents: 0 };

  const [snapshotDocs, eventDocs, pipelineSettingsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", userId, "promotions", promotionId, "snapshots")),
    getDocs(query(collection(db, "users", userId, "events"), where("promotionId", "==", promotionId))),
    getDoc(doc(db, "users", userId, "settings", "pipeline")),
  ]);
  const pipelineSettings = pipelineSettingsSnapshot.exists() ? pipelineSettingsSnapshot.data() : null;

  for (const snapshotDoc of snapshotDocs.docs) {
    const snapshot = snapshotDoc.data() || {};
    if (snapshot.addedViaSnapActive !== true) {
      await deleteDoc(snapshotDoc.ref);
      continue;
    }
    const leadId = snapshot.leadId || snapshotDoc.id;
    if (!leadId) continue;

    const leadRef = doc(db, "users", userId, "leads", leadId);
    const leadSnapshot = await getDoc(leadRef);
    if (!leadSnapshot.exists()) {
      await deleteDoc(snapshotDoc.ref);
      continue;
    }

    try {
      await restoreLeadFromPromotionSnapshot({
        leadRef,
        leadData: leadSnapshot.data() || {},
        snapshot,
        pipelineSettings,
        reason: "promotion_deleted",
      });
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

  const touchpointsSnapshot = await getDocs(collection(db, "users", userId, "promotions", promotionId, "touchpoints"));
  for (const touchpointDoc of touchpointsSnapshot.docs) {
    const statusesSnapshot = await getDocs(collection(touchpointDoc.ref, "statuses"));
    for (const statusDoc of statusesSnapshot.docs) {
      try {
        await deleteDoc(statusDoc.ref);
      } catch (error) {
        throw deletionError(`promotion status delete ${statusDoc.id}`, error);
      }
    }

    try {
      await deleteDoc(touchpointDoc.ref);
    } catch (error) {
      throw deletionError(`promotion touchpoint delete ${touchpointDoc.id}`, error);
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

async function restoreExpiredPromotionStageReplacements({ db, userId, asOfDate = new Date() }) {
  const promotionsSnapshot = await getDocs(query(collection(db, "users", userId, "promotions"), where("status", "==", "active")));
  if (!promotionsSnapshot.size) return 0;

  const pipelineSettingsSnapshot = await getDoc(doc(db, "users", userId, "settings", "pipeline"));
  const pipelineSettings = pipelineSettingsSnapshot.exists() ? pipelineSettingsSnapshot.data() : null;
  const restoreStart = new Date(asOfDate);
  restoreStart.setHours(0, 0, 0, 0);

  let restoredCount = 0;

  for (const promotionDoc of promotionsSnapshot.docs) {
    const promotion = promotionDoc.data() || {};
    const endDate = toPromotionDate(promotion.endDate);
    if (!endDate) continue;

    const touchpoints = Array.isArray(promotion.touchpoints) ? promotion.touchpoints : [];
    if (!touchpoints.length) continue;

    const lastTouchpointDate = touchpoints.reduce((latest, touchpoint) => {
      const touchpointDate = computeTouchpointDate(endDate, touchpoint.offsetDays);
      return !latest || touchpointDate > latest ? touchpointDate : latest;
    }, null);

    if (!lastTouchpointDate) continue;

    const restoreEligibleDate = new Date(lastTouchpointDate);
    restoreEligibleDate.setHours(0, 0, 0, 0);
    restoreEligibleDate.setDate(restoreEligibleDate.getDate() + 1);
    if (restoreStart.getTime() < restoreEligibleDate.getTime()) continue;

    const snapshots = await getDocs(collection(db, "users", userId, "promotions", promotionDoc.id, "snapshots"));
    for (const snapshotDoc of snapshots.docs) {
      const snapshot = snapshotDoc.data() || {};
      if (snapshot.addedViaSnapActive !== true) continue;
      if (Number(snapshot.completedTouchpointCount || 0) > 0) continue;
      if (snapshot.zeroTouchpointsCompleted === false) continue;
      if (snapshot.restoredAt) continue;

      const leadId = snapshot.leadId || snapshotDoc.id;
      if (!leadId) continue;
      const leadRef = doc(db, "users", userId, "leads", leadId);
      const leadSnapshot = await getDoc(leadRef);
      if (!leadSnapshot.exists()) {
        await deleteDoc(snapshotDoc.ref);
        continue;
      }

      await restoreLeadFromPromotionSnapshot({
        leadRef,
        leadData: leadSnapshot.data() || {},
        snapshot,
        pipelineSettings,
        reason: "promotion_expired_no_touchpoints",
      });

      await updateDoc(snapshotDoc.ref, {
        restoredAt: serverTimestamp(),
        restoreReason: "promotion_expired_no_touchpoints",
        updatedAt: serverTimestamp(),
      });
      restoredCount += 1;
    }
  }

  return restoredCount;
}

async function syncPromotionTouchpointContainers({ db, userId, promotionId, promotion }) {
  const endDate = toPromotionDate(promotion?.endDate);
  if (!endDate) throw new Error("Invalid end date");

  const touchpoints = Array.isArray(promotion?.touchpoints) ? promotion.touchpoints : [];
  const leadIds = Array.isArray(promotion?.leadIds) ? promotion.leadIds : [];

  const existingEventsSnapshot = await getDocs(
    query(collection(db, "users", userId, "events"), where("promotionId", "==", promotionId))
  );
  const existingTouchpointEvents = existingEventsSnapshot.docs
    .map((docItem) => ({ id: docItem.id, ...docItem.data() }))
    .filter((event) => event.type === "promotion_touchpoint");

  const desiredIds = new Set();

  for (const touchpoint of touchpoints) {
    const touchpointEvent = buildPromotionTouchpointEvent({
      promotionId,
      promotionName: promotion?.name,
      touchpoint,
      endDate,
    });

    desiredIds.add(touchpointEvent.id);
    const { id, ...payload } = touchpointEvent;
    await setDoc(doc(db, "users", userId, "events", id), payload, { merge: true });
    await setDoc(
      doc(db, "users", userId, "promotions", promotionId, "touchpoints", touchpoint.id),
      {
        promotionId,
        touchpointId: touchpoint.id,
        touchpointOrder: touchpoint.order,
        touchpointName: touchpoint.name || `Touchpoint ${Number(touchpoint.order || 0) + 1}`,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    const statusCollectionRef = collection(
      db,
      "users",
      userId,
      "promotions",
      promotionId,
      "touchpoints",
      touchpoint.id,
      "statuses"
    );
    const existingStatusesSnapshot = await getDocs(statusCollectionRef);
    const existingByLeadId = new Map(
      existingStatusesSnapshot.docs.map((statusDoc) => [statusDoc.id, { ref: statusDoc.ref, ...statusDoc.data() }])
    );

    for (const leadId of leadIds) {
      await setDoc(
        doc(statusCollectionRef, leadId),
        {
          leadId,
          touchpointId: touchpoint.id,
          promotionId,
          status: existingByLeadId.get(leadId)?.status || "open",
          completed: existingByLeadId.get(leadId)?.completed === true,
          skipped: existingByLeadId.get(leadId)?.status === "skipped" || existingByLeadId.get(leadId)?.skipped === true,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    for (const [statusLeadId, existingStatus] of existingByLeadId.entries()) {
      if (leadIds.includes(statusLeadId)) continue;
      await deleteDoc(existingStatus.ref);
    }
  }

  for (const existingEvent of existingTouchpointEvents) {
    if (desiredIds.has(existingEvent.id)) continue;
    await deleteDoc(doc(db, "users", userId, "events", existingEvent.id));
  }

  const touchpointsSnapshot = await getDocs(collection(db, "users", userId, "promotions", promotionId, "touchpoints"));
  const desiredTouchpointIds = new Set(touchpoints.map((touchpoint) => touchpoint.id));
  for (const touchpointDoc of touchpointsSnapshot.docs) {
    if (desiredTouchpointIds.has(touchpointDoc.id)) continue;
    const statusesSnapshot = await getDocs(collection(touchpointDoc.ref, "statuses"));
    for (const statusDoc of statusesSnapshot.docs) {
      await deleteDoc(statusDoc.ref);
    }
    await deleteDoc(touchpointDoc.ref);
  }
}

export { createPromotion, restoreSnappedLeadsAndDeletePromotion, restoreExpiredPromotionStageReplacements, syncPromotionTouchpointContainers };
