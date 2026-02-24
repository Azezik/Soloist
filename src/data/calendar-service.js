import { Timestamp, collection, db, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc } from "./firestore-service.js";

function isPromotionEvent(event = {}) {
  return event?.type === "promotion" || event?.type === "promotion_touchpoint" || Boolean(event?.promotionId);
}


async function upsertLeadEvent(currentUserId, leadId) {
  const leadRef = doc(db, "users", currentUserId, "leads", leadId);
  const leadSnapshot = await getDoc(leadRef);
  if (!leadSnapshot.exists()) return;

  const lead = leadSnapshot.data();
  await setDoc(doc(db, "users", currentUserId, "events", `lead_${leadId}`), {
    type: "lead",
    sourceId: leadId,
    contactId: lead.contactId || null,
    scheduledFor: lead.nextActionAt || null,
    nextActionAt: lead.nextActionAt || null,
    title: lead.title || "Lead",
    status: lead.status || "open",
    completed: Boolean(lead.archived || lead.stageStatus === "completed"),
    archived: Boolean(lead.archived),
    deleted: lead.deleted === true,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

async function upsertTaskEvent(currentUserId, taskId) {
  const taskRef = doc(db, "users", currentUserId, "tasks", taskId);
  const taskSnapshot = await getDoc(taskRef);
  if (!taskSnapshot.exists()) return;

  const task = taskSnapshot.data();
  await setDoc(doc(db, "users", currentUserId, "events", `task_${taskId}`), {
    type: "task",
    sourceId: taskId,
    contactId: task.contactId || null,
    scheduledFor: task.scheduledFor || null,
    title: task.title || "Untitled Task",
    status: task.status || "open",
    completed: Boolean(task.completed),
    archived: Boolean(task.archived),
    deleted: task.deleted === true,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function rescheduleLeadAction(currentUserId, leadId, nextDate) {
  if (!currentUserId || !leadId || !(nextDate instanceof Date)) return;

  const leadRef = doc(db, "users", currentUserId, "leads", leadId);
  await updateDoc(leadRef, {
    nextActionAt: Timestamp.fromDate(nextDate),
    lastActionAt: Timestamp.now(),
    lastActionSource: "schedule_adjustment",
    updatedAt: serverTimestamp(),
  });

  await upsertLeadEvent(currentUserId, leadId);
}

export async function getCalendarData(currentUserId) {
  const [contactsSnapshot, tasksSnapshot, leadsSnapshot, eventsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUserId, "contacts")),
    getDocs(collection(db, "users", currentUserId, "tasks")),
    getDocs(collection(db, "users", currentUserId, "leads")),
    getDocs(collection(db, "users", currentUserId, "events")),
  ]);

  const contactsById = contactsSnapshot.docs.reduce((acc, docItem) => {
    acc[docItem.id] = { id: docItem.id, ...docItem.data() };
    return acc;
  }, {});

  const tasks = tasksSnapshot.docs
    .map((taskDoc) => ({ id: taskDoc.id, ...taskDoc.data() }))
    .filter((task) => task.deleted !== true && !task.completed && !task.archived);

  const leads = leadsSnapshot.docs
    .map((leadDoc) => ({ id: leadDoc.id, ...leadDoc.data() }))
    .filter((lead) => lead.deleted !== true && lead.stageStatus !== "completed" && !lead.archived)
    .map((lead) => {
      const linkedContact = lead.contactId ? contactsById[lead.contactId] : null;
      return {
        ...lead,
        name: linkedContact?.name || lead.name || "",
        company: linkedContact?.company || lead.company || "",
        email: linkedContact?.email || lead.email || "",
      };
    });

  const promotionEvents = eventsSnapshot.docs
    .map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() }))
    .filter((event) => isPromotionEvent(event) && event.deleted !== true && !event.completed && !event.archived);

  return { tasks, leads, promotionEvents };
}

export async function updateCalendarItemSchedule(currentUserId, calendarItem, nextDate) {
  if (!currentUserId || !calendarItem?.id || !calendarItem?.type || !(nextDate instanceof Date)) return;

  if (calendarItem.type === "lead") {
    await rescheduleLeadAction(currentUserId, calendarItem.id, nextDate);
    return;
  }

  if (calendarItem.type === "promotion" || calendarItem.type === "promotion_touchpoint") {
    return;
  }

  const itemRef = doc(db, "users", currentUserId, "tasks", calendarItem.id);

  await updateDoc(itemRef, {
    scheduledFor: Timestamp.fromDate(nextDate),
    updatedAt: serverTimestamp(),
  });

  await upsertTaskEvent(currentUserId, calendarItem.id);
}
