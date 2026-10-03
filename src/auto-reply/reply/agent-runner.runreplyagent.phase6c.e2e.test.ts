// E2E tests for run-reply-agent execution and generated session artifacts.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runFallbackModelAttempt,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TypingMode } from "../../config/types.js";
import type { TemplateContext } from "../templating.js";
import { createReplyAgentSessionFixture } from "./agent-runner.runreplyagent.fixture.test-support.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
  scheduleFollowupDrain,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import { clearFollowupQueueForTest } from "./queue.test-helpers.js";
import {
  createReplyOperation,
  type ReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { buildChannelSourceTurnId, setChannelSourceTurnId } from "./source-turn-id.js";
import { createMockTypingController } from "./test-helpers.js";

const state = vi.hoisted(() => ({
  beforeAgentReplyHasHooksMock: vi.fn(),
  beforeAgentReplyRunMock: vi.fn(),
  compactEmbeddedAgentSessionMock: vi.fn(),
  getChannelPluginMock: vi.fn(),
  materializeMcpAppChannelPresentationMock: vi.fn(),
  queueEmbeddedAgentMessageMock: vi.fn(),
  activeBackendCancelMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
}));
const parkedSteer = vi.hoisted(() => {
  const admit = vi.fn(async () => "steer" as const);
  const accepted = vi.fn();
  const fallback = vi.fn();
  const consume = vi.fn();
  return {
    admit,
    accepted,
    fallback,
    consume,
    park: vi.fn(() => ({ admit, accepted, fallback, consume })),
  };
});

const { sessionKeys } = createReplyAgentSessionFixture();

function mockCallArgs(mock: ReturnType<typeof vi.fn>, label: string, callIndex = 0): unknown[] {
  const call = mock.mock.calls[callIndex] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected ${label} mock call ${callIndex}`);
  }
  return call;
}

let modelFallbackModule: typeof import("../../agents/model-fallback-runner.js");

let runReplyAgentPromise:
  | Promise<(typeof import("./agent-runner.js"))["runReplyAgent"]>
  | undefined;

async function getRunReplyAgent() {
  if (!runReplyAgentPromise) {
    runReplyAgentPromise = import("./agent-runner.js").then((m) => m.runReplyAgent);
  }
  return await runReplyAgentPromise;
}

vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: async (params: TestModelFallbackRunnerParams) => ({
    outcome: "completed" as const,
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/runtime-plan/build.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/runtime-plan/build.js")>()),
  buildAgentRuntimeDeliveryPlan: () => ({
    isSilentPayload: () => false,
    resolveFollowupRoute: () => undefined,
  }),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: state.beforeAgentReplyHasHooksMock,
    runBeforeAgentReply: state.beforeAgentReplyRunMock,
  }),
}));

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (params: unknown) => state.compactEmbeddedAgentSessionMock(params),
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: (channel: unknown) => state.getChannelPluginMock(channel),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", async (importOriginal) => {
  const { clearActiveEmbeddedRun, setActiveEmbeddedRun } =
    await importOriginal<typeof import("../../agents/embedded-agent-runner/runs.js")>();
  return {
    // Queue admission is controlled here; logical-turn registration and retirement stay real.
    clearActiveEmbeddedRun,
    setActiveEmbeddedRun,
    formatEmbeddedAgentQueueFailureSummary: () => "test queue rejection",
    queueEmbeddedAgentMessageWithOutcomeAsync: async (
      sessionId: string,
      prompt: string,
      options: unknown,
    ) => {
      const result = state.queueEmbeddedAgentMessageMock(sessionId, prompt, options);
      if (typeof result === "object") {
        return result;
      }
      return result
        ? {
            queued: true,
            sessionId,
            target: "embedded_run",
            gatewayHealth: "live",
            enqueuedAtMs: Date.now(),
          }
        : {
            queued: false,
            sessionId,
            reason: "no_active_run",
            target: "none",
            gatewayHealth: "live",
          };
    },
  };
});

vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: (params: unknown) =>
    state.materializeMcpAppChannelPresentationMock(params),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: vi.fn(),
  parkSteerCandidate: parkedSteer.park,
  refreshQueuedFollowupSession: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

beforeAll(async () => {
  // Avoid attributing the initial agent-runner import cost to the first test case.
  modelFallbackModule = await import("../../agents/model-fallback-runner.js");
  await getRunReplyAgent();
});

beforeEach(() => {
  clearFollowupQueueForTest("main");
  replyRunTesting.resetReplyRunRegistry();
  state.compactEmbeddedAgentSessionMock.mockReset();
  state.compactEmbeddedAgentSessionMock.mockResolvedValue({
    ok: true,
    compacted: false,
    reason: "test-default",
  });
  state.runEmbeddedAgentMock.mockReset();
  state.runEmbeddedAgentMock.mockResolvedValue({
    payloads: [{ text: "final" }],
    meta: { agentMeta: { usage: { input: 1, output: 1 } } },
  });
  state.queueEmbeddedAgentMessageMock.mockReset();
  state.activeBackendCancelMock.mockReset();
  state.beforeAgentReplyHasHooksMock.mockReset().mockReturnValue(false);
  state.beforeAgentReplyRunMock.mockReset();
  state.queueEmbeddedAgentMessageMock.mockReturnValue(false);
  state.getChannelPluginMock.mockReset();
  state.materializeMcpAppChannelPresentationMock.mockReset();
  parkedSteer.admit.mockReset().mockResolvedValue("steer");
  parkedSteer.accepted.mockReset();
  parkedSteer.fallback.mockReset();
  parkedSteer.consume.mockReset();
  parkedSteer.park.mockReset();
  parkedSteer.park.mockReturnValue({
    admit: parkedSteer.admit,
    accepted: parkedSteer.accepted,
    fallback: parkedSteer.fallback,
    consume: parkedSteer.consume,
  });
  vi.mocked(enqueueFollowupRun).mockReset().mockReturnValue(true);
  vi.mocked(refreshQueuedFollowupSession).mockReset();
  vi.mocked(scheduleFollowupDrain).mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
});

function createMinimalRun(params?: {
  opts?: InternalGetReplyOptions;
  resolvedVerboseLevel?: "off" | "on";
  sessionStore?: Record<string, SessionEntry>;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  typingMode?: TypingMode;
  blockStreamingEnabled?: boolean;
  isActive?: boolean;
  isRunActive?: () => boolean;
  shouldSteer?: boolean;
  shouldFollowup?: boolean;
  resolvedQueueMode?: string;
  replyOperation?: ReplyOperation;
  currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
  sessionCtx?: Partial<TemplateContext>;
  sourceTurnId?: string;
  runOverrides?: Partial<FollowupRun["run"]>;
  bindActiveAuthority?: boolean;
  attachSteerBackend?: boolean;
  activeBackendRunId?: string;
}) {
  const typing = createMockTypingController();
  const opts = params?.opts;
  const sessionCtx = {
    Provider: "whatsapp",
    MessageSid: "msg",
    ...params?.sessionCtx,
  } as unknown as TemplateContext;
  const sourceTurnId =
    params?.sourceTurnId ??
    buildChannelSourceTurnId({
      provider: sessionCtx.Provider,
      accountId: sessionCtx.AccountId,
      conversationId: sessionCtx.OriginatingTo,
      messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    });
  setChannelSourceTurnId(sessionCtx, sourceTurnId);
  const resolvedQueue = {
    mode: params?.resolvedQueueMode ?? "interrupt",
  } as unknown as QueueSettings;
  const sessionKey = params?.sessionKey ?? "main";
  sessionKeys.add(sessionKey);
  const followupRun = {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    turnAdoptionLifecycle: opts?.turnAdoptionLifecycle,
    currentInboundEventKind: params?.currentInboundEventKind,
    originatingChannel: sessionCtx.OriginatingChannel ?? sessionCtx.Provider,
    originatingTo: sessionCtx.OriginatingTo,
    originatingChatId: sessionCtx.NativeChannelId ?? sessionCtx.ChatId,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: "whatsapp",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      // Mocked reply routes already have prepared input facts; discovery has its own vision tests.
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text"] },
        { provider: "openai", id: "gpt-5.5", input: ["text"] },
        { provider: "openai", id: "gpt-5.6-sol", input: ["text"] },
        { provider: "google", id: "gemini-2.5-flash", input: ["text"] },
        { provider: "deepinfra", id: "moonshotai/Kimi-K2.5", input: ["text"] },
        { provider: "lmstudio", id: "gemma-4-e4b-it", input: ["text"] },
      ],
      thinkLevel: "low",
      verboseLevel: params?.resolvedVerboseLevel ?? "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints: process.env.OPENCLAW_TEST_FAST === "1",
      ...params?.runOverrides,
    },
  } as unknown as FollowupRun;
  const activeOperation = replyRunRegistry.get(sessionKey);
  if (activeOperation && params?.isActive && params.bindActiveAuthority !== false) {
    activeOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
  }

  return {
    followupRun,
    sourceTurnId,
    typing,
    opts,
    run: async () => {
      const runReplyAgent = await getRunReplyAgent();
      const operation = replyRunRegistry.get(sessionKey);
      if (operation && params?.attachSteerBackend !== false) {
        operation.attachBackend({
          kind: "embedded",
          runId: params?.activeBackendRunId,
          cancel: state.activeBackendCancelMock,
          claimPendingUserInputAnswer: async (prompt, options) => {
            const result = (await state.queueEmbeddedAgentMessageMock(
              operation.sessionId,
              prompt,
              options,
            )) as boolean | { queued: boolean };
            return result === true || (typeof result === "object" && result.queued);
          },
          messageInjection: {
            isAvailable: () => true,
            queueMessage: async (prompt, options) => {
              const result = (await state.queueEmbeddedAgentMessageMock(
                operation.sessionId,
                prompt,
                options,
              )) as
                | boolean
                | {
                    queued: boolean;
                    reason?: string;
                    transcriptCommit?: "unconfirmed";
                    errorMessage?: string;
                  };
              if (result === false || (typeof result === "object" && !result.queued)) {
                throw new Error(typeof result === "object" ? result.reason : "queue rejected");
              }
              return typeof result === "object" && result.transcriptCommit === "unconfirmed"
                ? {
                    transcriptCommit: result.transcriptCommit,
                    errorMessage: result.errorMessage ?? "commit unconfirmed",
                  }
                : undefined;
            },
          },
        });
      }
      return runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: params?.shouldSteer ?? false,
        shouldFollowup: params?.shouldFollowup ?? false,
        isActive: params?.isActive ?? false,
        isRunActive: params?.isRunActive,
        opts,
        typing,
        sessionEntry: params?.sessionEntry,
        sessionStore: params?.sessionStore,
        sessionKey,
        storePath: params?.storePath,
        sessionCtx,
        defaultModel: "anthropic/claude-opus-4-6",
        resolvedVerboseLevel: params?.resolvedVerboseLevel ?? "off",
        isNewSession: false,
        blockStreamingEnabled: params?.blockStreamingEnabled ?? false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: params?.typingMode ?? "instant",
        replyOperation: params?.replyOperation,
      });
    },
  };
}

function requireScheduledFollowupRunner(): (run: FollowupRun) => Promise<void> {
  const scheduled = vi.mocked(scheduleFollowupDrain).mock.calls.at(-1);
  if (!scheduled) {
    throw new Error("expected a scheduled follow-up drain");
  }
  expect(scheduled[0]).toBe("main");
  return scheduled[1];
}

import { executePreparedReplyRun } from "./get-reply-run-execute.js";
describe("Phase 6C A2 causal followup and steer", () => {
  // Drive a queued follow-up through the real scheduled drain and reach the
  // embedded runner. Mirrors the existing "falls back once when the pre-resolved
  // steer owner disappears" fixture: active op running, steer declined -> queue,
  // then the captured drain callback runs the follow-up as its own run.
  async function drainCausalFollowup(causalMessageId: string | undefined) {
    parkedSteer.fallback.mockClear();
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    active.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage: vi.fn() },
    });
    active.complete();
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });
    if (causalMessageId !== undefined) {
      followupRun.causalMessageId = causalMessageId;
    }
    await expect(run()).resolves.toBeUndefined();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(vi.mocked(scheduleFollowupDrain)).toHaveBeenCalled();
    await requireScheduledFollowupRunner()(followupRun);
    return followupRun;
  }

  it("A2-E: queued follow-up B keeps its own causal identity in embedded params", async () => {
    await drainCausalFollowup("B");
    expect(mockCallArgs(state.runEmbeddedAgentMock, "followup B")[0]).toMatchObject({
      messageId: "B",
    });
  });

  it("A2-F: two queued follow-ups keep B then C with no swap", async () => {
    await drainCausalFollowup("B");
    expect(mockCallArgs(state.runEmbeddedAgentMock, "followup B", 0)[0]).toMatchObject({
      messageId: "B",
    });
    clearFollowupQueueForTest("main");
    replyRunTesting.resetReplyRunRegistry();
    state.runEmbeddedAgentMock.mockClear();
    await drainCausalFollowup("C");
    expect(mockCallArgs(state.runEmbeddedAgentMock, "followup C", 0)[0]).toMatchObject({
      messageId: "C",
    });
  });

  it("A2-G: queued follow-up without a causal id yields undefined embedded messageId", async () => {
    await drainCausalFollowup(undefined);
    const params = mockCallArgs(state.runEmbeddedAgentMock, "followup none")[0] as {
      messageId?: unknown;
    };
    expect(params.messageId).toBeUndefined();
  });

  it("A2-H/I: accepted steer B starts no new initial run and never mutates A", async () => {
    // Baseline run A carries its own causal identity.
    const a = createMinimalRun({ sessionCtx: { MessageSid: "sid-A" } });
    a.followupRun.causalMessageId = "A";
    await a.run();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const aParams = mockCallArgs(state.runEmbeddedAgentMock, "A baseline")[0] as {
      messageId?: string;
    };
    expect(aParams.messageId).toBe("A");
    // Isolate the steer admission from the baseline run's registry/queue state.
    replyRunTesting.resetReplyRunRegistry();
    clearFollowupQueueForTest("main");

    // B is accepted as steer input against a running A-style operation.
    state.queueEmbeddedAgentMessageMock.mockReturnValueOnce(true);
    const activeRoute = { provider: "openai", model: "gpt-fallback" };
    const { followupRun, run } = createMinimalRun({
      isActive: true,
      shouldSteer: true,
      resolvedQueueMode: "steer",
      bindActiveAuthority: false,
    });
    followupRun.causalMessageId = "B";
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
    active.bindToolAuthorityRoute(activeRoute);
    active.setPhase("running");

    await expect(run()).resolves.toBeUndefined();

    // Accepted steer produces no new embedded run for B.
    expect(state.queueEmbeddedAgentMessageMock).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    // A's already-created params are untouched (immutability).
    expect(aParams.messageId).toBe("A");
    active.complete();
  });

  it("A2-J: a declined steer falls back to a queued run that keeps causal B", async () => {
    parkedSteer.fallback.mockClear();
    const active = createReplyOperation({
      sessionKey: "main",
      sessionId: "session",
      resetTriggered: false,
    });
    active.setPhase("running");
    // CLI active backend cannot accept injection => steer declined, queue fallback.
    active.attachBackend({ kind: "cli", cancel: vi.fn() });
    const { followupRun, run } = createMinimalRun({
      attachSteerBackend: false,
      isActive: true,
      shouldSteer: true,
      shouldFollowup: true,
      resolvedQueueMode: "steer",
    });
    followupRun.causalMessageId = "B";

    await expect(run()).resolves.toBeUndefined();
    expect(parkedSteer.fallback).toHaveBeenCalledOnce();
    expect(state.runEmbeddedAgentMock).not.toHaveBeenCalled();
    active.complete();
    await requireScheduledFollowupRunner()(followupRun);
    expect(mockCallArgs(state.runEmbeddedAgentMock, "declined steer followup")[0]).toMatchObject({
      messageId: "B",
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 6C Checkpoint B2a: interrupt replacement + same-run fallback causal.
// Compositional production-seam proof:
//   - B source creation via real executePreparedReplyRun
//   - B / A run mapping via real runReplyAgent -> runEmbeddedAgentMock
// ---------------------------------------------------------------------------
function buildB2aAdmission(
  runReplyAgentMock: ReturnType<typeof vi.fn>,
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
    sessionId: "b2a-sess",
    sessionFile: "/tmp/p6c-b2a-sess.json",
    sessionEntry: {},
  };
  const params: Record<string, unknown> = {
    ctx,
    sessionCtx,
    cfg: {},
    agentId: "agent-1",
    agentDir: "/tmp/p6c-b2a-agent",
    directives: {},
    modelState: {},
    provider: "openai",
    model: "gpt-4o-mini",
    perMessageQueueOptions: {},
    typing: {},
    opts: {},
    command: { senderIsOwner: false, senderId: "owner-1", ownerList: [] },
    isNewSession: false,
    sessionKey: "b2a-sess",
    sessionId: "b2a-sess",
    storePath: "/tmp/p6c-b2a-store",
    sessionEntryHandle: {},
    sessionStore: {},
    resolvedThinkLevel: undefined,
    requestedRouteResolution: undefined,
    timeoutMs: undefined,
    resolvedBlockStreamingBreak: undefined,
    autoFallbackPrimaryProbe: undefined,
  };
  return {
    context: {
      params,
      runtimePolicySessionKey: "b2a-sess",
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
      workspaceDir: "/tmp/p6c-b2a-ws",
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
    runReplyAgent: runReplyAgentMock,
    queueKey: "q-b2a",
    shouldSteer: false,
    shouldFollowup: false,
    hasQueuedFollowups: false,
    isActive: false,
    authProfileId: undefined,
    authProfileIdSource: undefined,
  };
}

describe("Phase 6C B2a interrupt replacement and fallback causal", () => {
  it("B2a-D: interrupt replacement B's source id flows to embedded params, never old-A", async () => {
    // 1) B source creation through the REAL executePreparedReplyRun.
    const bRunReplyAgent = vi.fn(async () => ({ ok: true }));
    const admission = buildB2aAdmission(bRunReplyAgent, "interrupt-B", "short-B");
    await executePreparedReplyRun(admission as never);
    const captured = (bRunReplyAgent.mock.calls[0] as unknown[])[0] as {
      followupRun: FollowupRun;
    };
    expect(captured.followupRun.causalMessageId).toBe("interrupt-B");
    expect(captured.followupRun.causalMessageId).not.toBe("old-A");

    // 2) Feed B through the REAL runReplyAgent -> embedded mapping.
    const { followupRun, run } = createMinimalRun({
      sessionCtx: { MessageSidFull: "interrupt-B", MessageSid: "short-B" },
    });
    followupRun.causalMessageId = captured.followupRun.causalMessageId;
    followupRun.messageId = captured.followupRun.messageId;
    await run();
    const params = mockCallArgs(state.runEmbeddedAgentMock, "replacement B")[0] as {
      messageId?: string;
    };
    expect(params.messageId).toBe("interrupt-B");
    expect(params.messageId).not.toBe("old-A");
  });

  it("B2a-H/I: fallback of the SAME logical run keeps causal id across a model change", async () => {
    const { followupRun, run } = createMinimalRun({
      runOverrides: { provider: "openai", model: "gpt-5.6-sol" },
    });
    followupRun.causalMessageId = "causal-A";
    state.runEmbeddedAgentMock
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce({ payloads: [{ text: "recovered" }], meta: { agentMeta: {} } });
    vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => {
      try {
        await runInitialModelFallbackAttempt(args);
      } catch {
        /* attempt 1 fails, fall through to attempt 2 */
      }
      const result = await runFallbackModelAttempt(
        args,
        "deepinfra",
        "moonshotai/Kimi-K2.5",
        "rate_limit",
      );
      return {
        outcome: "completed" as const,
        result,
        provider: "deepinfra",
        model: "moonshotai/Kimi-K2.5",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.6-sol",
            error: "primary down",
            reason: "rate_limit",
          },
        ],
      };
    });

    await run();

    const calls = state.runEmbeddedAgentMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [params] of calls) {
      expect((params as { messageId?: string }).messageId).toBe("causal-A");
    }
    const first = (calls[0] as unknown[])[0] as { provider?: unknown; model?: unknown };
    const second = (calls[1] as unknown[])[0] as { provider?: unknown; model?: unknown };
    expect(second.provider).toBe("deepinfra");
    expect(second.model).toBe("moonshotai/Kimi-K2.5");
    expect(first.provider).not.toBe(second.provider);
  });

  it("B2a-J: causal id stays A across attempts even when the logical run ultimately fails", async () => {
    const { followupRun, run } = createMinimalRun({
      runOverrides: { provider: "openai", model: "gpt-5.6-sol" },
    });
    followupRun.causalMessageId = "causal-A";
    state.runEmbeddedAgentMock.mockRejectedValue(new Error("all providers down"));
    vi.spyOn(modelFallbackModule, "runWithModelFallback").mockImplementationOnce(async (args) => {
      try {
        await runInitialModelFallbackAttempt(args);
      } catch {
        /* ignore */
      }
      try {
        await runFallbackModelAttempt(args, "deepinfra", "moonshotai/Kimi-K2.5", "rate_limit");
      } catch {
        /* ignore */
      }
      throw new Error("fallback exhausted");
    });

    await run().catch(() => undefined);

    const calls = state.runEmbeddedAgentMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [params] of calls) {
      expect((params as { messageId?: string }).messageId).toBe("causal-A");
    }
  });

  it("B2a-K: a separate run after a fallback keeps its own causal id (no stale reuse)", async () => {
    const { followupRun, run } = createMinimalRun({
      sessionCtx: { MessageSidFull: "sid-B2", MessageSid: "short-B2" },
    });
    followupRun.causalMessageId = "causal-B";
    await run();
    const params = mockCallArgs(state.runEmbeddedAgentMock, "post-fallback B")[0] as {
      messageId?: string;
    };
    expect(params.messageId).toBe("causal-B");
    expect(params.messageId).not.toBe("causal-A");
  });
});

// ---------------------------------------------------------------------------
// Phase 6C Checkpoint B2b: a synthetic/internal turn must reach the downstream
// embedded mapping with messageId === undefined (no false causal identity).
// ---------------------------------------------------------------------------
describe("Phase 6C B2b synthetic downstream hook context", () => {
  it("B2b-N: synthetic heartbeat turn maps to embedded messageId undefined", async () => {
    // 1) Synthetic B source creation via the REAL executePreparedReplyRun.
    const syntheticSpy = vi.fn(async () => ({ ok: true }));
    const admission = buildB2aAdmission(syntheticSpy, "synthetic-heartbeat-id", undefined, {
      isHeartbeat: true,
    });
    await executePreparedReplyRun(admission as never);
    const captured = (syntheticSpy.mock.calls[0] as unknown[])[0] as {
      followupRun: FollowupRun;
    };
    // Synthetic turn never receives an external causal identity.
    expect(captured.followupRun.causalMessageId).toBeUndefined();

    // 2) Feed through the REAL runReplyAgent -> embedded mapping.
    const { followupRun, run } = createMinimalRun({
      sessionCtx: { MessageSidFull: "synthetic-heartbeat-id" },
    });
    followupRun.causalMessageId = captured.followupRun.causalMessageId;
    await run();
    const params = mockCallArgs(state.runEmbeddedAgentMock, "synthetic downstream")[0] as {
      messageId?: unknown;
    };
    // Downstream RunEmbeddedAgentParams.messageId is undefined -> the hook
    // context seam (agent-hook-context.causal.test.ts) exposes messageId undefined.
    expect(params.messageId).toBeUndefined();
  });
});
