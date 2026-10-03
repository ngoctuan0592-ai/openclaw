import { describe, expect, it, vi } from "vitest";
import { isFreshChannelCronAuthorityTurn } from "../../agents/cron-creator-authority-context.js";
import { withGroupThreadTurn } from "../group-thread-context.js";
import { executePreparedReplyRun } from "./get-reply-run-execute.js";

const BASE = {
  messageProvider: "telegram",
  senderId: "owner-1",
  isHeartbeat: false,
  isRoomEvent: false,
};

describe("fresh channel cron authority turn", () => {
  it("recognizes a fresh authenticated turn without channel-specific policy", () => {
    expect(isFreshChannelCronAuthorityTurn({ ...BASE, messageProvider: "custom-channel" })).toBe(
      true,
    );
  });

  it.each([
    { name: "missing provider", overrides: { messageProvider: undefined } },
    { name: "missing sender", overrides: { senderId: undefined } },
    { name: "heartbeat", overrides: { isHeartbeat: true } },
    { name: "room event", overrides: { isRoomEvent: true } },
    { name: "continuation provenance", overrides: { inputProvenance: { kind: "continuation" } } },
    { name: "spawned session", overrides: { spawnedBy: "agent:parent" } },
    { name: "replayed turn", overrides: { suppressNextUserMessagePersistence: true } },
  ])("rejects $name", ({ overrides }) => {
    expect(isFreshChannelCronAuthorityTurn({ ...BASE, ...overrides })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 6C Checkpoint A1: inbound sourceMessageId -> FollowupRun.causalMessageId
//
// Exercises the REAL production function `executePreparedReplyRun`. The fixture
// builds the minimum PreparedReplyRunAdmission needed to reach the supplied
// `runReplyAgent` dependency (no model / no Telegram / no network). The final
// FollowupRun is NOT hand-constructed; it is whatever production builds.
// ---------------------------------------------------------------------------

type CausalCase = {
  label: string;
  messageSidFull?: string;
  messageSid?: string;
};

function buildAdmission(
  runReplyAgent: ReturnType<typeof vi.fn>,
  messageSidFull?: string,
  messageSid?: string,
  extras: { isHeartbeat?: boolean; inputProvenance?: Record<string, unknown> } = {},
) {
  const sessionCtx: Record<string, unknown> = {
    Provider: undefined,
    Surface: undefined,
    MessageSidFull: messageSidFull,
    MessageSid: messageSid,
    SenderId: "owner-1",
    ChatType: "direct",
    ...(extras.inputProvenance ? { InputProvenance: extras.inputProvenance } : {}),
  };
  const ctx: Record<string, unknown> = { Provider: undefined, Surface: undefined };
  const preparedSessionState = {
    sessionId: "sess-1",
    sessionFile: "/tmp/p6c-sess.json",
    sessionEntry: {},
  };
  const params: Record<string, unknown> = {
    ctx,
    sessionCtx,
    cfg: {},
    agentId: "agent-1",
    agentDir: "/tmp/p6c-agent",
    directives: {},
    modelState: {},
    provider: "openai",
    model: "gpt-4o-mini",
    perMessageQueueOptions: {},
    typing: {},
    opts: {},
    command: { senderIsOwner: false, senderId: "owner-1", ownerList: [] },
    isNewSession: false,
    sessionKey: "sess-1",
    sessionId: "sess-1",
    storePath: "/tmp/p6c-store",
    sessionEntryHandle: {},
    sessionStore: {},
    resolvedThinkLevel: undefined,
    requestedRouteResolution: undefined,
    timeoutMs: undefined,
    resolvedBlockStreamingBreak: undefined,
    autoFallbackPrimaryProbe: undefined,
  };
  const state: Record<string, unknown> = {
    context: {
      params,
      runtimePolicySessionKey: "sess-1",
      isHeartbeat: extras.isHeartbeat ?? false,
      traceRunPhase: (_name: string, fn: () => unknown) => fn(),
      promptSessionCtx: sessionCtx,
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: undefined,
      silentReplyPromptMode: undefined,
      useFastReplyRuntime: true,
      fullAccessState: { available: false },
      extraSystemPromptParts: [],
      sourceConversationContextByMode: {},
      sourceConversationContextPromptOffset: 0,
      extraSystemPromptStatic: undefined,
      cliSessionBindingFacts: undefined,
      baseBodyTrimmedRaw: "hi",
      effectiveResetTriggered: false,
      isBareSessionReset: false,
      workspaceDir: "/tmp/p6c-ws",
      hasUserBody: true,
      shouldInjectGroupIntro: false,
      typingMode: "off",
      terminalReplyExpectation: undefined,
    },
    resolvedThinkLevel: undefined,
    thinkLevelOverride: undefined,
    thinkingCatalog: undefined,
    skillsSnapshot: undefined,
    prefixedCommandBody: "hi",
    queuedBody: "hi",
    transcriptBody: undefined,
    transcriptCommandBody: undefined,
    promptMedia: [],
    inboundMediaIndexes: [],
    currentInboundContext: undefined,
    isRoomEvent: false,
    providedReplyOperation: undefined,
    preparedSessionState,
    resolvedQueue: undefined,
    embeddedAgentRuntime: undefined,
    resolveActiveEmbeddedSessionId: () => undefined,
    resolvePreparedSessionState: () => preparedSessionState,
    runReplyAgent,
    queueKey: "q-1",
    shouldSteer: false,
    shouldFollowup: false,
    hasQueuedFollowups: false,
    isActive: false,
    authProfileId: undefined,
    authProfileIdSource: undefined,
  };
  return state;
}

async function captureFollowupRun(c: CausalCase) {
  const runReplyAgent = vi.fn(async (_args: unknown) => ({ ok: true }));
  const state = buildAdmission(runReplyAgent, c.messageSidFull, c.messageSid);
  const result = await executePreparedReplyRun(state as never);
  expect(runReplyAgent).toHaveBeenCalledTimes(1);
  const arg = (runReplyAgent.mock.calls[0] as unknown[])[0] as {
    followupRun: Record<string, unknown>;
  };
  return { followupRun: arg.followupRun, result };
}

describe("Phase 6C A1: sourceMessageId -> FollowupRun.causalMessageId (real executePreparedReplyRun)", () => {
  it("D1: MessageSidFull wins over MessageSid", async () => {
    const { followupRun } = await captureFollowupRun({
      label: "D1",
      messageSidFull: "full-A",
      messageSid: "short-A",
    });
    expect(followupRun.causalMessageId).toBe("full-A");
    // Pre-candidate semantics untouched: messageId still uses MessageSidFull ?? MessageSid.
    expect(followupRun.messageId).toBe("full-A");
  });

  it("D2: falls back to MessageSid when MessageSidFull absent", async () => {
    const { followupRun } = await captureFollowupRun({
      label: "D2",
      messageSidFull: undefined,
      messageSid: "short-B",
    });
    expect(followupRun.causalMessageId).toBe("short-B");
    expect(followupRun.messageId).toBe("short-B");
  });

  it("D3: no source id -> causalMessageId undefined (no synthetic identity)", async () => {
    const { followupRun } = await captureFollowupRun({
      label: "D3",
      messageSidFull: undefined,
      messageSid: undefined,
    });
    expect(followupRun.causalMessageId).toBeUndefined();
    expect(followupRun.messageId).toBeUndefined();
  });

  it("H: group round>1 keeps existing messageId=groupTurn.messageId while causalMessageId stays the current source id", async () => {
    let captured: { followupRun: Record<string, unknown> } | undefined;
    await withGroupThreadTurn(
      {
        turn: { agentId: "agent-1", name: "Agent", round: 2, messageId: "group-round-2" },
        recordReply: () => {},
      },
      async () => {
        captured = await captureFollowupRun({
          label: "H",
          messageSidFull: "full-H",
          messageSid: "short-H",
        });
      },
    );
    // Existing semantics: later group rounds adopt the group-turn messageId.
    expect(captured?.followupRun.messageId).toBe("group-round-2");
    // Causal identity is the CURRENT single inbound source message, NOT the group turn.
    expect(captured?.followupRun.causalMessageId).toBe("full-H");
  });
});

// ---------------------------------------------------------------------------
// Phase 6C Checkpoint B2b: synthetic/internal turns must NOT receive a false
// external causal identity from their technical MessageSid/MessageSidFull.
// Uses the canonical isSyntheticSourceReplyTurn semantics (heartbeat /
// inter_session / internal_system).
// ---------------------------------------------------------------------------
async function captureWith(extras: {
  messageSidFull?: string;
  messageSid?: string;
  isHeartbeat?: boolean;
  inputProvenance?: Record<string, unknown>;
}) {
  const runReplyAgent = vi.fn(async (_args: unknown) => ({ ok: true }));
  const state = buildAdmission(runReplyAgent, extras.messageSidFull, extras.messageSid, {
    isHeartbeat: extras.isHeartbeat,
    inputProvenance: extras.inputProvenance,
  });
  await executePreparedReplyRun(state as never);
  const arg = (runReplyAgent.mock.calls[0] as unknown[])[0] as {
    followupRun: Record<string, unknown>;
  };
  return arg.followupRun;
}

describe("Phase 6C B2b synthetic/internal no-causal-leak", () => {
  it("E: external_user provenance keeps its external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "external-A",
      inputProvenance: { kind: "external_user" },
    });
    expect(f.causalMessageId).toBe("external-A");
  });

  it("F: heartbeat never becomes an external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "synthetic-heartbeat-id",
      isHeartbeat: true,
    });
    expect(f.causalMessageId).toBeUndefined();
    // Existing messageId semantics remain production-owned.
    expect(f.messageId).toBe("synthetic-heartbeat-id");
  });

  it("G1: internal_system (cron) never becomes an external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "synthetic-cron-id",
      inputProvenance: { kind: "internal_system", sourceTool: "cron" },
    });
    expect(f.causalMessageId).toBeUndefined();
  });

  it("G2: internal_system (other tool) never becomes an external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "synthetic-internal-id",
      inputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
    });
    expect(f.causalMessageId).toBeUndefined();
  });

  it("H1: inter_session subagent_announce never becomes an external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "subagent-announce-id",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceRole: "subagent",
      },
    });
    expect(f.causalMessageId).toBeUndefined();
  });

  it("H2: inter_session sessions_send never becomes an external causal id", async () => {
    const f = await captureWith({
      messageSidFull: "subagent-session-send-id",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceRole: "subagent",
      },
    });
    expect(f.causalMessageId).toBeUndefined();
  });

  it("L: external A then synthetic heartbeat => synthetic undefined, never external-A", async () => {
    const a = await captureWith({
      messageSidFull: "external-A",
      inputProvenance: { kind: "external_user" },
    });
    expect(a.causalMessageId).toBe("external-A");
    const s = await captureWith({ messageSidFull: "synthetic-leak-id", isHeartbeat: true });
    expect(s.causalMessageId).toBeUndefined();
    expect(s.causalMessageId).not.toBe("external-A");
    expect(s.causalMessageId).not.toBe("synthetic-leak-id");
  });

  it("M: synthetic then external B => B keeps its own external causal id", async () => {
    await captureWith({ messageSidFull: "synthetic-x", isHeartbeat: true });
    const b = await captureWith({
      messageSidFull: "external-B",
      inputProvenance: { kind: "external_user" },
    });
    expect(b.causalMessageId).toBe("external-B");
  });

  it("P: ordinary external ingress with no provenance keeps causal id", async () => {
    const f = await captureWith({ messageSidFull: "external-plain" });
    expect(f.causalMessageId).toBe("external-plain");
  });
});
