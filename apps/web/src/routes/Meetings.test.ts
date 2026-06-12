import { describe, expect, it, vi } from "vitest";
import { removeMeetingFromHistory } from "./Meetings";

type Meeting = Record<string, string | number | null | undefined>;

describe("meetings history removal", () => {
  it("removes a meeting immediately without opening a confirmation dialog", async () => {
    const confirm = vi.fn(() => {
      throw new Error("confirm should not be called");
    });
    vi.stubGlobal("confirm", confirm);

    const setMeetings = vi.fn();
    const deleteMeeting = vi.fn(async () => ({ ok: true }));

    await removeMeetingFromHistory({
      meeting: { id: "mtg_1", subject: "Daily Standup" },
      deleteMeeting,
      setMeetings,
      setDeletingId: vi.fn(),
      setError: vi.fn()
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(deleteMeeting).toHaveBeenCalledWith("mtg_1");
    const updater = setMeetings.mock.calls[0]?.[0] as ((current: Meeting[]) => Meeting[]) | undefined;
    expect(updater?.([{ id: "mtg_1" }, { id: "mtg_2" }])).toEqual([{ id: "mtg_2" }]);
  });
});
