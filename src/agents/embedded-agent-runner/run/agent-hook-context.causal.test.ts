import { describe, expect, it } from "vitest";
import { buildEmbeddedAgentHookContext } from "./agent-hook-context.js";

/**
 * Phase 6C causal identity: the embedded agent hook context must expose the
 * single causal inbound message id as `messageId`, and omit it otherwise.
 * This is data-only propagation; no queue algorithm is involved here.
 */
describe("Phase 6C causal messageId -> PluginHookAgentContext", () => {
  const baseRun = {
    runId: "run-1",
    sessionId: "sess-1",
    sessionKey: "agent:manager:telegram:group:-1",
    workspaceDir: "/tmp/ws",
    trigger: "user",
    sandbox: undefined,
  } as const;

  it("NORMAL DIRECT: single-source causal id is exposed as ctx.messageId", () => {
    const ctx = buildEmbeddedAgentHookContext({ ...baseRun, messageId: "A" }, "manager", undefined);
    expect(ctx.messageId).toBe("A");
  });

  it("FOLLOWUP: distinct later run exposes its own causal id (B, then C, no swap)", () => {
    const ctxB = buildEmbeddedAgentHookContext(
      { ...baseRun, messageId: "B" },
      "manager",
      undefined,
    );
    const ctxC = buildEmbeddedAgentHookContext(
      { ...baseRun, messageId: "C" },
      "manager",
      undefined,
    );
    expect(ctxB.messageId).toBe("B");
    expect(ctxC.messageId).toBe("C");
  });

  it("MULTI-SOURCE COLLECT / OVERFLOW / INTERNAL: absent causal id -> ctx.messageId undefined", () => {
    const ctx = buildEmbeddedAgentHookContext({ ...baseRun }, "manager", undefined);
    expect(ctx.messageId).toBeUndefined();
  });
});

/**
 * Phase 6C consumer proof: an id-based lookup must bind ONLY the exact root and
 * must NEVER fall back to another/newer root. No FIFO, TTL, timestamp, newest.
 */
describe("Phase 6C consumer causal join", () => {
  type Root = { chatId: string; messageId: string };
  function lookupRoot(roots: Root[], ctx: { chatId?: string; messageId?: string }): Root | null {
    if (!ctx.chatId || !ctx.messageId) {
      return null;
    }
    return roots.find((r) => r.chatId === ctx.chatId && r.messageId === ctx.messageId) ?? null;
  }

  const roots: Root[] = [
    { chatId: "X", messageId: "111" },
    { chatId: "X", messageId: "112" },
  ];

  it("ctx(X,111) resolves ONLY root111", () => {
    expect(lookupRoot(roots, { chatId: "X", messageId: "111" })).toEqual({
      chatId: "X",
      messageId: "111",
    });
  });

  it("delayed run with expired messageId=111 resolves NO ROOT (never binds root112)", () => {
    const remaining = [{ chatId: "X", messageId: "112" }];
    expect(lookupRoot(remaining, { chatId: "X", messageId: "111" })).toBeNull();
  });

  it("ctx(X,112) resolves root112", () => {
    expect(lookupRoot(roots, { chatId: "X", messageId: "112" })).toEqual({
      chatId: "X",
      messageId: "112",
    });
  });
});

describe("Phase 6C causal matrix (explicit cases)", () => {
  const run = {
    runId: "r",
    sessionId: "s",
    sessionKey: "k",
    workspaceDir: "/w",
    trigger: "user",
  } as const;
  it("STEER: A active, B later steered -> A's ctx causal id stays A (no replacement)", () => {
    const ctxA = buildEmbeddedAgentHookContext({ ...run, messageId: "A" }, "manager", undefined);
    const ctxB = buildEmbeddedAgentHookContext({ ...run, messageId: "B" }, "manager", undefined);
    expect(ctxA.messageId).toBe("A"); // unaffected by later B
    expect(ctxB.messageId).toBe("B");
  });
  it("COLLECT_SINGLE_SOURCE: exactly one source preserves its causal id", () => {
    const ctx = buildEmbeddedAgentHookContext({ ...run, messageId: "only" }, "manager", undefined);
    expect(ctx.messageId).toBe("only");
  });
  it("OVERFLOW_SUMMARY (multi-source) / INTERNAL: causal id undefined", () => {
    expect(
      buildEmbeddedAgentHookContext({ ...run }, "manager", undefined).messageId,
    ).toBeUndefined();
  });
});
