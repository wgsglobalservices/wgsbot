import { z } from "zod";

export const meetingRecapTypes = ["weekly_spqrc", "weekly_sales", "plant_meeting", "general"] as const;

export type MeetingRecapType = (typeof meetingRecapTypes)[number];

export const meetingRecapTypeSchema = z.enum(meetingRecapTypes);

export const meetingRecapTypeLabels: Record<MeetingRecapType, string> = {
  weekly_spqrc: "Weekly SPQRC",
  weekly_sales: "Weekly Sales",
  plant_meeting: "Individual Plant Meeting",
  general: "General"
};
