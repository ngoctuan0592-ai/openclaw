// Tests prepared reply queue state resolution before get-reply starts a run.
import { describe, expect, it, vi } from "vitest";
import { waitForPreparedReplyQueue } from "./get-reply-run-queue.js";

describe("waitForPreparedReplyQueue", () => {
  it("waits for the active session before refreshing and rechecking admission", async () => {
    const order: string[] = [];
    const interruptActiveRun = vi.fn();
    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-active",
      queueMode: "followup",
      interruptActiveRun,
      waitForActiveRunEnd: async (sessionId) => {
        order.push(`wait:${sessionId}`);
      },
      refreshPreparedState: async () => {
        order.push("refresh");
      },
      resolveBusyState: () => {
        order.push("recheck");
        return { isActive: false };
      },
    });
    expect(result).toBeUndefined();
    expect(order).toEqual(["wait:session-active", "refresh", "recheck"]);
    expect(interruptActiveRun).not.toHaveBeenCalled();
  });

  it("aborts and waits for interrupt mode before continuing", async () => {
    const interruptActiveRun = vi.fn(async () => true);
    const waitForActiveRunEnd = vi.fn(async () => {
      throw new Error("interrupt mode must use session-work admission settling");
    });
    const refreshPreparedState = vi.fn(async () => undefined);
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-active",
      queueMode: "interrupt",
      interruptActiveRun,
      waitForActiveRunEnd,
      refreshPreparedState,
      resolveBusyState,
    });

    expect(interruptActiveRun).toHaveBeenCalledOnce();
    expect(waitForActiveRunEnd).not.toHaveBeenCalled();
    expect(refreshPreparedState).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("rechecks after wait and returns shutdown reply when still busy", async () => {
    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-active",
      queueMode: "interrupt",
      interruptActiveRun: vi.fn(async () => true),
      waitForActiveRunEnd: vi.fn(async () => undefined),
      refreshPreparedState: vi.fn(async () => undefined),
      resolveBusyState: () => ({
        activeSessionId: "session-after-wait",
        isActive: true,
        isStreaming: false,
      }),
    });

    expect(result).toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 6C Checkpoint B2a: interrupt retires active A through the real admission
// seam without manufacturing any synthetic causal identity for the next request.
// ---------------------------------------------------------------------------
describe("Phase 6C B2a interrupt admission causal", () => {
  it("interrupts active A once, refreshes AFTER the interrupt, and lets B proceed with no synthetic identity", async () => {
    const order: string[] = [];
    const interruptActiveRun = vi.fn(async () => {
      order.push("interrupt");
      return true;
    });
    const waitForActiveRunEnd = vi.fn(async () => {
      order.push("wait");
    });
    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-A",
      queueMode: "interrupt",
      interruptActiveRun,
      waitForActiveRunEnd,
      refreshPreparedState: async () => {
        order.push("refresh");
      },
      resolveBusyState: () => {
        order.push("recheck");
        // A is fully retired: no active run remains to be reused as B's source.
        return { isActive: false };
      },
    });
    expect(interruptActiveRun).toHaveBeenCalledOnce();
    // Refresh must happen only after the interrupt request.
    expect(order).toEqual(["interrupt", "refresh", "recheck"]);
    expect(order.indexOf("refresh")).toBeGreaterThan(order.indexOf("interrupt"));
    // Interrupt mode never falls back to waiting on the old run.
    expect(waitForActiveRunEnd).not.toHaveBeenCalled();
    // No payload / no synthetic identity: B continues from its own source.
    expect(result).toBeUndefined();
  });

  it("still-busy after interrupt returns the shutdown reply and starts no replacement B", async () => {
    const interruptActiveRun = vi.fn(async () => true);
    const refreshPreparedState = vi.fn(async () => undefined);
    const result = await waitForPreparedReplyQueue({
      activeSessionId: "session-A",
      queueMode: "interrupt",
      interruptActiveRun,
      waitForActiveRunEnd: vi.fn(async () => undefined),
      refreshPreparedState,
      resolveBusyState: () => ({ isActive: true }),
    });
    expect(interruptActiveRun).toHaveBeenCalledOnce();
    expect(refreshPreparedState).toHaveBeenCalledOnce();
    // Execution stops here: the shutdown reply is produced instead of starting B.
    expect(result).toEqual({
      text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
    });
  });
});
