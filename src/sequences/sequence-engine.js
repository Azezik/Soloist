import { addDoc, collection, doc, serverTimestamp, setDoc, Timestamp, updateDoc } from "../data/firestore-service.js";
import { normalizePromotionTemplateConfig, toPromotionTemplatePayload } from "../templates/module.js";

function clampString(value, maxLen) {
  const normalized = String(value || "");
  return normalized.length <= maxLen ? normalized : normalized.slice(0, maxLen);
}

function normalizeSequenceSteps(rawSteps = []) {
  return rawSteps
    .map((step, index) => {
      const order = Number.isInteger(step?.order) ? step.order : index;
      const delayDays = Number.parseInt(step?.delayDaysFromPrevious, 10);
      const templateConfig = normalizePromotionTemplateConfig(step?.templateConfig || step?.template || {});
      return {
        id: String(step?.id || `step-${index + 1}`),
        order,
        name: String(step?.name || `Step ${order + 1}`) || `Step ${order + 1}`,
        delayDaysFromPrevious: order === 0 ? 0 : (Number.isNaN(delayDays) ? 0 : Math.max(0, delayDays)),
        toEmail: String(step?.toEmail || "").trim(),
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

function computeSequenceStepDates(steps = [], startDate = null) {
  const dates = [];
  let cursor = startDate ? new Date(startDate) : new Date();
  steps.forEach((step, index) => {
    if (index === 0) {
      dates.push(new Date(cursor));
      return;
    }
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + Math.max(0, Number(step.delayDaysFromPrevious) || 0));
    dates.push(new Date(cursor));
  });
  return dates;
}

export async function createSequence({ db, userId, sequence, contactId = null }) {
  const startDate = toSequenceDate(sequence.startDate);
  const steps = normalizeSequenceSteps(sequence.steps || []);

  const sequenceRef = await addDoc(collection(db, "users", userId, "sequences"), {
    name: clampString(sequence.name || "Untitled Sequence", 500),
    startDate: startDate ? Timestamp.fromDate(startDate) : null,
    steps,
    contactId: contactId || null,
    status: "active",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    configSnapshot: {
      ...sequence,
      steps,
      contactId: contactId || null,
    },
  });

  const scheduledDates = computeSequenceStepDates(steps, startDate);

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const scheduledFor = Timestamp.fromDate(scheduledDates[index] || new Date());
    const eventId = `sequence_${sequenceRef.id}_step_${step.id}`;
    await setDoc(doc(db, "users", userId, "events", eventId), {
      type: "sequence_step",
      sequenceId: sequenceRef.id,
      stepId: step.id,
      stepOrder: step.order,
      stepName: step.name || `Step ${step.order + 1}`,
      toEmail: step.toEmail || "",
      template: step.template,
      templateConfig: step.templateConfig || step.template,
      title: clampString(`${sequence.name || "Sequence"} — ${step.name || `Step ${step.order + 1}`}`, 200),
      name: clampString(`${sequence.name || "Sequence"} — ${step.name || `Step ${step.order + 1}`}`, 500),
      summary: clampString(`${sequence.name || "Sequence"} · ${step.name || `Step ${step.order + 1}`}`, 5000),
      scheduledFor,
      nextActionAt: scheduledFor,
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
}
