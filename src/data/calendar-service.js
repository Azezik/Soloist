import { Timestamp, collection, db, doc, getDocs, serverTimestamp, updateDoc } from "./firestore-service.js";

export async function rescheduleLeadAction(currentUserId, leadId, nextDate) {
  if (!currentUserId || !leadId || !(nextDate instanceof Date)) return;

  const leadRef = doc(db, "users", currentUserId, "leads", leadId);
  await updateDoc(leadRef, {
    nextActionAt: Timestamp.fromDate(nextDate),
    lastActionAt: Timestamp.now(),
    updatedAt: serverTimestamp(),
  });
}

export async function getCalendarData(currentUserId) {
  const [contactsSnapshot, tasksSnapshot, leadsSnapshot, promotionEventsSnapshot] = await Promise.all([
    getDocs(collection(db, "users", currentUserId, "contacts")),
    getDocs(collection(db, "users", currentUserId, "tasks")),
    getDocs(collection(db, "users", currentUserId, "leads")),
    getDocs(collection(db, "users", currentUserId, "promotionEvents")),
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

  const promotionEvents = promotionEventsSnapshot.docs
    .map((eventDoc) => ({ id: eventDoc.id, ...eventDoc.data() }))
    .filter((event) => event.deleted !== true && !event.completed && !event.archived);

  return { tasks, leads, promotionEvents };
}

export async function updateCalendarItemSchedule(currentUserId, calendarItem, nextDate) {
  if (!currentUserId || !calendarItem?.id || !calendarItem?.type || !(nextDate instanceof Date)) return;

  if (calendarItem.type === "lead") {
    await rescheduleLeadAction(currentUserId, calendarItem.id, nextDate);
    return;
  }

  if (calendarItem.type === "promotion") {
    const eventRef = doc(db, "users", currentUserId, "promotionEvents", calendarItem.id);
    await updateDoc(eventRef, {
      scheduledFor: Timestamp.fromDate(nextDate),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const itemRef = doc(db, "users", currentUserId, "tasks", calendarItem.id);

  await updateDoc(itemRef, {
    scheduledFor: Timestamp.fromDate(nextDate),
    updatedAt: serverTimestamp(),
  });
}
