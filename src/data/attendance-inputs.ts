import type { AttendanceRequestStatus, AttendanceRequestType, AttendanceSessionSource, AttendanceShiftStatus, AttendanceShiftTemplateKind } from "@/domain/types";

export type CreateAttendanceShiftInput = {
  profileId: string;
  templateId?: string | null;
  dateLocal: string;
  plannedStartAt: string;
  plannedEndAt: string;
  notes?: string;
  publish?: boolean;
};

export type UpdateAttendanceShiftInput = Partial<CreateAttendanceShiftInput> & {
  status?: AttendanceShiftStatus;
};

export type AttendanceDecisionInput = {
  note?: string;
};

export type StartAttendanceSessionInput = {
  profileId: string;
  shiftId?: string | null;
  source?: AttendanceSessionSource;
  startedAt?: string;
  notes?: string;
};

export type EndAttendanceSessionInput = {
  endedAt?: string;
  notes?: string;
};

export type CopyAttendanceInput = {
  sourceDateLocal: string;
  targetDateLocal: string;
  mode: "day" | "week";
};

export type CreateAttendanceRequestInput = {
  profileId: string;
  type: AttendanceRequestType;
  status?: Extract<AttendanceRequestStatus, "draft" | "pending">;
  startDateLocal: string;
  endDateLocal: string;
  startTimeLocal?: string | null;
  endTimeLocal?: string | null;
  reason?: string;
};

export type UpdateAttendanceRequestInput = Partial<CreateAttendanceRequestInput> & {
  status?: Extract<AttendanceRequestStatus, "draft" | "pending" | "cancelled">;
};

export type BulkAttendanceShiftAssignmentInput = {
  dateLocal: string;
  templateId: string;
  profileId: string;
  startTimeLocal?: string;
  endTimeLocal?: string;
  notes?: string;
};

export type CreateBulkAttendanceShiftsInput = {
  name?: string;
  shiftMode: AttendanceShiftTemplateKind;
  assignments: BulkAttendanceShiftAssignmentInput[];
  publish?: boolean;
  overridePendingRequests?: boolean;
  notes?: string;
};

export type PublishScheduleBatchInput = {
  publish?: boolean;
};

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function isTimeLocal(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
