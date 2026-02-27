import { addDoc, collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "../data/firestore-service.js";
import { normalizePromotionTemplateConfig, toPromotionTemplatePayload } from "../templates/module.js";
import { sanitizeTimeString } from "../domain/settings.js";

function clampString(value, maxLen) {
  const normalized = String(value || "");
  return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

export function composeSequenceDisplayName({ name, instanceName } = {}) {
  const baseName = String(name || "Untitled Sequence").trim() || "Untitled Sequence";
  const suffix = String(instanceName || "").trim();
  if (!suffix) return baseName;
  return `${baseName} — ${suffix}`;
}

function normalizeSequenceSteps(rawSteps = []) {
  return rawSteps
    .map((step, index) => {
      const order = Number.isInteger(step?.order) ? step.order : index;
      const delayDays = Number.parseInt(step?.delayDaysFromPrevious, 10);
      const templateConfig = normalizePromotionTemplateConfig(step?.templateConfig || step?.template || {});
      const stepType = step?.stepType === "task_reminder" ? "task_reminder" : "email";
      const taskConfig = {
        title: clampString(step?.taskConfig?.title || step?.taskTitle || "", 500),
        notes: clampString(step?.taskConfig?.notes || step?.taskNotes || "", 5000),
      };
      return {
        id: String(step?.id || `step-${index + 1}`),
        order,
        name: String(step?.name || `Step ${order + 1}`) || `Step ${order + 1}`,
        delayDaysFromPrevious: order === 0 ? 0 : (Number.isNaN(delayDays) ? 0 : Math.max(0, delayDays)),
        triggerImmediatelyAfterPrevious: order > 0 && step?.triggerImmediatelyAfterPrevious === true,
        useContactEmail: step?.useContactEmail === true,
        toEmail: String(step?.toEmail || "").trim(),
        stepType,
        taskConfig,
        taskTitle: taskConfig.title,
        taskNotes: taskConfig.notes,
        template: toPromotionTemplatePayload(templateConfig),
        templateConfig,
      };
    })
    .sort((a, b) => a.order - b.order);
}

function toSequenceDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function applyTimeToDate(dateValue, timeValue) {
  const [hourPart, minutePart] = sanitizeTimeString(timeValue).split(":");
  const result = new Date(dateValue);
  result.setHours(Number.parseInt(hourPart, 10), Number.parseInt(minutePart, 10), 0, 0);
  return result;
}

function computeSequenceStepDates(steps = [], startDate = null, dayStartTime = "08:30") {
  const dates = [];
  const hasStartDate = Boolean(startDate);
  let cursor = startDate ? new Date(startDate) : new Date();
  steps.forEach((step, index) => {
    if (index === 0) {
      dates.push(new Date(cursor));
      return;
    }
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + Math.max(0, Number(step.delayDaysFromPrevious) || 0));
    if (!hasStartDate) {
      cursor = applyTimeToDate(cursor, dayStartTime);
    }
    dates.push(new Date(cursor));
  });
  return dates;
}

export async function createSequence({ db, userId, sequence, contactId = null, dayStartTime = "08:30" }) {
  const startDate = toSequenceDate(sequence.startDate);
  const steps = normalizeSequenceSteps(sequence.steps || []);
  const baseSequenceName = clampString(sequence.name || "Untitled Sequence", 500);
  const sequenceInstanceName = clampString(sequence.instanceName || "", 500).trim();
  const sequenceDisplayName = composeSequenceDisplayName({
    name: baseSequenceName,
    instanceName: sequenceInstanceName,
  });

  const sequenceRef = await addDoc(collection(db, "users", userId, "sequences"), {
    name: baseSequenceName,
    instanceName: sequenceInstanceName || null,
    displayName: clampString(sequenceDisplayName, 500),
    startDate: startDate ? Timestamp.fromDate(startDate) : null,
    steps,
    contactId: contactId || null,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    configSnapshot: {
      ...sequence,
      instanceName: sequenceInstanceName || null,
      steps,
      contactId: contactId || null,
    },
  });

  const scheduledDates = computeSequenceStepDates(steps, startDate, dayStartTime);

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const previousStep = index > 0 ? steps[index - 1] : null;
    const isLockedUntilPreviousComplete = index > 0 && previousStep?.triggerImmediatelyAfterPrevious === true;
    const scheduledForDate = scheduledDates[index] || new Date();
    const scheduledFor = isLockedUntilPreviousComplete ? null : Timestamp.fromDate(scheduledForDate);
    const eventId = `sequence_${sequenceRef.id}_step_${step.id}`;
    await setDoc(doc(db, "users", userId, "events", eventId), {
      type: "sequence_step",
      sequenceId: sequenceRef.id,
      stepId: step.id,
      stepOrder: step.order,
      stepName: step.name || `Step ${step.order + 1}`,
      toEmail: step.toEmail || "",
      useContactEmail: step.useContactEmail === true,
      triggerImmediatelyAfterPrevious: step.triggerImmediatelyAfterPrevious === true,
      template: step.template,
      templateConfig: step.templateConfig || step.template,
      stepType: step.stepType || "email",
      taskConfig: step.taskConfig || { title: "", notes: "" },
      taskTitle: step.taskTitle || step.taskConfig?.title || "",
      taskNotes: step.taskNotes || step.taskConfig?.notes || "",
      title: clampString(`${sequenceDisplayName} — ${step.name || `Step ${step.order + 1}`}`, 200),
      name: clampString(`${sequenceDisplayName} — ${step.name || `Step ${step.order + 1}`}`, 500),
      summary: clampString(`${sequenceDisplayName} · ${step.name || `Step ${step.order + 1}`}`, 5000),
      scheduledFor,
      nextActionAt: scheduledFor,
      blockedUntilPreviousComplete: isLockedUntilPreviousComplete,
      completed: false,
      archived: false,
      deleted: false,
      status: "open",
      contactId: contactId || null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }, { merge: true });

    await setDoc(doc(db, "users", userId, "sequences", sequenceRef.id, "steps", step.id), {
      stepId: step.id,
      stepOrder: step.order,
      stepName: step.name || `Step ${step.order + 1}`,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    await setDoc(doc(db, "users", userId, "sequences", sequenceRef.id, "steps", step.id, "statuses", "single"), {
      status: "open",
      completed: false,
      skipped: false,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    }, { merge: true });
  }

  return sequenceRef.id;
}

export async function markSequenceStepStatus({ db, userId, event, status }) {
  if (!event?.sequenceId || !event?.stepId) return;
  const eventRef = doc(db, "users", userId, "events", event.id);
  const now = serverTimestamp();
  const payload = {
    status,
    completed: status === "completed",
    archived: status === "completed" || status === "skipped",
    updatedAt: now,
  };
  if (status === "completed") payload.completedAt = now;
  if (status === "skipped") payload.skippedAt = now;
  await updateDoc(eventRef, payload);

  await setDoc(doc(db, "users", userId, "sequences", event.sequenceId, "steps", event.stepId, "statuses", "single"), {
    status,
    completed: status === "completed",
    skipped: status === "skipped",
    completedAt: status === "completed" ? now : null,
    skippedAt: status === "skipped" ? now : null,
    updatedAt: now,
  }, { merge: true });

  if (status !== "completed") return;

  const sequenceSnapshot = await getDoc(doc(db, "users", userId, "sequences", event.sequenceId));
  const sequence = sequenceSnapshot.exists() ? sequenceSnapshot.data() : null;
  const orderedSteps = normalizeSequenceSteps(sequence?.steps || []);
  const currentIndex = orderedSteps.findIndex((entry) => entry.id === event.stepId);
  if (currentIndex < 0 || currentIndex >= orderedSteps.length - 1) return;
  const nextStep = orderedSteps[currentIndex + 1];
  if (nextStep?.triggerImmediatelyAfterPrevious !== true) return;

  const nextEventId = `sequence_${event.sequenceId}_step_${nextStep.id}`;
  const nowTimestamp = Timestamp.now();
  await updateDoc(doc(db, "users", userId, "events", nextEventId), {
    scheduledFor: nowTimestamp,
    nextActionAt: nowTimestamp,
    blockedUntilPreviousComplete: false,
    updatedAt: serverTimestamp(),
  });
}

export async function truncateSequenceInstanceFromStep({ db, userId, event }) {
  if (!event?.sequenceId) return;
  const sequenceId = event.sequenceId;
  const targetStepOrder = Number(event.stepOrder);
  if (Number.isNaN(targetStepOrder)) return;

  const eventsSnapshot = await getDocs(query(collection(db, "users", userId, "events"), where("sequenceId", "==", sequenceId)));
  const sequenceEvents = eventsSnapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }));
  const eventsToDelete = sequenceEvents.filter((entry) => Number(entry.stepOrder) >= targetStepOrder && entry.deleted !== true);
  const now = serverTimestamp();

  await Promise.all(eventsToDelete.map((entry) => updateDoc(doc(db, "users", userId, "events", entry.id), {
    status: "truncated",
    archived: true,
    deleted: true,
    truncatedAt: now,
    updatedAt: now,
  })));

  await Promise.all(eventsToDelete
    .filter((entry) => entry.stepId)
    .map((entry) => setDoc(doc(db, "users", userId, "sequences", sequenceId, "steps", entry.stepId, "statuses", "single"), {
      status: "truncated",
      completed: false,
      skipped: false,
      truncatedAt: now,
      updatedAt: now,
    }, { merge: true })));

  await updateDoc(doc(db, "users", userId, "sequences", sequenceId), {
    status: "completed",
    endedAt: now,
    truncatedFromStepOrder: targetStepOrder,
    updatedAt: now,
  });
}
