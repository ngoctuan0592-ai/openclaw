// Phase 6C B1: queue causal-identity isolation (focused sibling).
// Extracted from queue.collect.test.ts to satisfy the line-cap ratchet without
// reducing coverage. Executes the REAL queue machinery via the shared helpers.
import { describe, expect, it } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import type { FollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("Phase 6C B1 queue causal isolation", () => {
  const withCausal = (
    params: Parameters<typeof createRun>[0],
    causalMessageId?: string,
    runOverrides?: Partial<FollowupRun["run"]>,
  ): FollowupRun => {
    const run = createRun(params);
    if (causalMessageId !== undefined) {
      run.causalMessageId = causalMessageId;
    }
    if (runOverrides) {
      Object.assign(run.run, runOverrides);
    }
    return run;
  };

  it("B1-D: multi-source collect keeps representative messageId and clears causal", async () => {
    const q = createQueueCase({}, 1);
    q.add(withCausal({ prompt: "work B", messageId: "provider-B" }, "causal-B"));
    q.add(withCausal({ prompt: "work C", messageId: "provider-C" }, "causal-C"));
    await q.drain();
    expect(q.calls).toHaveLength(1);
    const run = q.calls[0]!;
    // Real collect aggregation: both sources' work is present.
    expect(run.prompt).toContain("work B");
    expect(run.prompt).toContain("work C");
    // Existing representative/group messageId semantics unchanged (last source).
    expect(run.messageId).toBe("provider-C");
    // Multi-source causal is fail-closed undefined.
    expect(run.causalMessageId).toBeUndefined();
  });

  it("B1-E: single-source collect preserves its own causal id", async () => {
    const q = createQueueCase({}, 1);
    q.add(withCausal({ prompt: "solo work", messageId: "provider-B" }, "causal-B"));
    await q.drain();
    expect(q.calls).toHaveLength(1);
    expect(q.calls[0]!.messageId).toBe("provider-B");
    expect(q.calls[0]!.causalMessageId).toBe("causal-B");
  });

  it("B1-G: synthetic overflow summaries never carry a causal id (ordinary + grouped)", async () => {
    const q = createQueueCase({ cap: 3 }, 6);
    const queued = [
      ["discarded context", "discarded"],
      ["dropped A", "A"],
      ["dropped B", "B"],
      ["dropped C1", "C"],
      ["dropped C2", "C"],
      ["dropped D", "D"],
      ["dropped E", "E"],
      ["survivor 1", "survivor"],
      ["survivor 2", "survivor"],
      ["survivor 3", "survivor"],
    ] as const;
    queued.forEach(([prompt, target], index) => {
      const run = createRun({
        prompt,
        originatingChannel: "slack",
        originatingTo: `channel:${target}`,
        originatingChatType: "channel",
      });
      run.causalMessageId = `cm-${index}`;
      q.add(run);
    });
    await q.drain();
    expect(q.calls).toHaveLength(6);
    const overflowCalls = q.calls.filter((call) => call.prompt.includes("[Queue overflow]"));
    expect(overflowCalls.length).toBe(5);
    // Every synthetic overflow summary is fail-closed: no causal identity.
    for (const call of overflowCalls) {
      expect(call.causalMessageId).toBeUndefined();
    }
    // Grouped (multi-source) overflow is exercised ("Dropped 2 messages").
    expect(overflowCalls.some((call) => call.prompt.includes("Dropped 2 messages"))).toBe(true);
    // The live survivor aggregate is multi-source => also fail-closed undefined.
    const survivor = q.calls[5]!;
    expect(survivor.prompt).toContain("survivor 1");
    expect(survivor.causalMessageId).toBeUndefined();
  });

  it("B1-I: drop:new rejects the incoming source and never causes it to drain", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy: "new" }, 1);
    expect(q.add(withCausal({ prompt: "A", messageId: "m-A" }, "A"))).toBe(true);
    expect(q.add(withCausal({ prompt: "D", messageId: "m-D" }, "D"))).toBe(false);
    await q.drain();
    expect(q.calls.map((call) => call.prompt)).toEqual(["A"]);
    expect(q.calls[0]!.causalMessageId).toBe("A");
    // Later allowed source E keeps its own causal id and never D.
    const q2 = createQueueCase({ mode: "followup", cap: 1, dropPolicy: "new" }, 1);
    q2.add(withCausal({ prompt: "E", messageId: "m-E" }, "E"));
    await q2.drain();
    expect(q2.calls.map((call) => call.prompt)).toEqual(["E"]);
    expect(q2.calls[0]!.causalMessageId).toBe("E");
  });

  it("B1-J: drop:old eviction does not leak the evicted causal id onto the survivor", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy: "old" }, 1);
    expect(q.add(withCausal({ prompt: "D", messageId: "m-D" }, "D"))).toBe(true);
    expect(q.add(withCausal({ prompt: "E", messageId: "m-E" }, "E"))).toBe(true);
    await q.drain();
    expect(q.calls.map((call) => call.prompt)).toEqual(["E"]);
    expect(q.calls[0]!.causalMessageId).toBe("E");
    expect(q.calls[0]!.causalMessageId).not.toBe("D");
  });

  it("B1-N: a later clean run Z keeps its own causal id (no stale leak)", async () => {
    // Exercise the leak-prone paths first, then a clean run on a fresh queue.
    const collect = createQueueCase({}, 1);
    collect.add(withCausal({ prompt: "b work", messageId: "provider-B" }, "causal-B"));
    collect.add(withCausal({ prompt: "c work", messageId: "provider-C" }, "causal-C"));
    await collect.drain();

    const overflow = createQueueCase({ cap: 1 }, 2);
    overflow.add(withCausal({ prompt: "drop", messageId: "pm-1" }, "cm-1"));
    overflow.add(withCausal({ prompt: "alive", messageId: "pm-2" }, "cm-2"));
    await overflow.drain();

    const q = createQueueCase({ mode: "followup", cap: 1, dropPolicy: "new" }, 1);
    q.add(withCausal({ prompt: "Z", messageId: "m-Z" }, "Z"));
    await q.drain();
    expect(q.calls[0]!.causalMessageId).toBe("Z");
  });
});
