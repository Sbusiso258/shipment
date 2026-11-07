import type { Announcement, Message, Task, TaskStatus } from "@/types/domain";

import { fail } from "./fail";
import {
  mapAnnouncement,
  mapMessage,
  mapTask,
  type AnnouncementRow,
  type MessageRow,
  type TaskRow,
} from "./mappers";
import { supabaseServer } from "./supabase/server";

/**
 * Announcements, messages and tasks.
 *
 * No organisation filter and no role check anywhere: RLS decides what these
 * return and whether the writes land. A filter here would look like defence
 * in depth and would actually hide a broken policy during testing.
 *
 * The writes are the interesting part. `sender_org_id` and `posted_by` are
 * set from the SESSION by the caller, never from a form field — a client that
 * could name its own sender could impersonate the carrier to its customer.
 */

const ANNOUNCEMENT_COLUMNS =
  "id, org_id, title, body, pinned, published_at, expires_at, retracted_at, posted_by";

const MESSAGE_COLUMNS =
  "id, org_id, shipment_id, counterparty_org_id, sender_org_id, sender_user_id, body, retracted_at, created_at, shipments(reference), organisations!messages_sender_org_id_fkey(name)";

const TASK_COLUMNS =
  "id, org_id, shipment_id, title, detail, status, priority, due_at, assigned_to, completed_at, created_at, shipments(reference)";

export interface WriteResult {
  ok: boolean;
  error: string | null;
}

function describe(message: string, fallback: string): string {
  if (message.includes("row-level security")) {
    return "You do not have permission to do that here.";
  }
  if (message.includes("_body_check") || message.includes("body")) {
    return "Write something first.";
  }
  if (message.includes("tasks_guard_assignee")) {
    return "That person is not in this organisation.";
  }
  return fallback;
}

/* ------------------------------------------------------------------------ */
/* Reads                                                                      */
/* ------------------------------------------------------------------------ */

export async function loadAnnouncements(limit = 20): Promise<Announcement[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("announcements")
    .select(ANNOUNCEMENT_COLUMNS)
    .is("retracted_at", null)
    .order("published_at", { ascending: false })
    .limit(limit);

  if (error) fail("load announcements", error);
  return ((data ?? []) as unknown as AnnouncementRow[]).map(mapAnnouncement);
}

export async function loadMessages(limit = 30): Promise<Message[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) fail("load messages", error);
  return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
}

export async function loadTasks(limit = 30): Promise<Task[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    // Unfinished work first, then by when it is due. A task with no due date
    // sorts last rather than first — `nullsFirst: false` is the whole
    // difference between a useful list and a confusing one.
    .order("status", { ascending: true })
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) fail("load tasks", error);
  return ((data ?? []) as unknown as TaskRow[]).map(mapTask);
}

/* ------------------------------------------------------------------------ */
/* Writes                                                                     */
/* ------------------------------------------------------------------------ */

export async function postAnnouncement(input: {
  orgId: string;
  title: string;
  body: string;
  postedBy: string;
}): Promise<WriteResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) return { ok: false, error: "Give the notice a title and a body." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("announcements").insert({
    org_id: input.orgId,
    title,
    body,
    posted_by: input.postedBy,
  });

  if (error) return { ok: false, error: describe(error.message, "Could not post the notice.") };
  return { ok: true, error: null };
}

/**
 * Send a message.
 *
 * `senderOrgId` and `senderUserId` come from the session. The insert policy
 * checks both against `auth.uid()` as well, so a forged sender is refused by
 * the database even if this function were called wrongly — but passing them
 * from the session means that never has to be the last line of defence.
 */
export async function sendMessage(input: {
  orgId: string;
  shipmentId: string | null;
  counterpartyOrgId: string | null;
  senderOrgId: string;
  senderUserId: string;
  body: string;
}): Promise<WriteResult> {
  const body = input.body.trim();
  if (!body) return { ok: false, error: "Write something first." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("messages").insert({
    org_id: input.orgId,
    shipment_id: input.shipmentId,
    counterparty_org_id: input.counterpartyOrgId,
    sender_org_id: input.senderOrgId,
    sender_user_id: input.senderUserId,
    body,
  });

  if (error) {
    if (error.message.includes("messages_counterparty_needs_shipment")) {
      return { ok: false, error: "A message to a customer has to be about a shipment." };
    }
    return { ok: false, error: describe(error.message, "Could not send the message.") };
  }

  return { ok: true, error: null };
}

export async function createTask(input: {
  orgId: string;
  title: string;
  shipmentId: string | null;
  assignedTo: string | null;
  createdBy: string;
}): Promise<WriteResult> {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give the task a title." };

  const supabase = await supabaseServer();
  const { error } = await supabase.from("tasks").insert({
    org_id: input.orgId,
    title,
    shipment_id: input.shipmentId,
    assigned_to: input.assignedTo,
    assigned_by: input.createdBy,
    created_by: input.createdBy,
  });

  if (error) return { ok: false, error: describe(error.message, "Could not create the task.") };
  return { ok: true, error: null };
}

/**
 * Move a task's status.
 *
 * Completion timestamps are NOT sent: a trigger stamps them, because the
 * point of `completed_at` is to record when the system was told, and a caller
 * is not a reliable witness to that.
 */
export async function setTaskStatus(input: {
  taskId: string;
  status: TaskStatus;
}): Promise<WriteResult> {
  const supabase = await supabaseServer();

  const { error } = await supabase
    .from("tasks")
    .update({ status: input.status })
    .eq("id", input.taskId);

  if (error) return { ok: false, error: describe(error.message, "Could not update the task.") };
  return { ok: true, error: null };
}
