import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 250;
const MIN_LIVE_SAMPLE_MS = 1_000;
const MIN_FINAL_SAMPLE_MS = 250;

function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }

  return cost;
}

function estimateContentTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let contentStreamStart: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;
  let currentContext: ExtensionContext | undefined;

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

  function refresh(ctx: ExtensionContext) {
    currentContext = ctx;
    const model = ctx.model;
    const usage = ctx.getContextUsage();

    state = {
      ...state,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      modelName: model?.name ?? model?.id ?? "No model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
      cost: getSessionCost(ctx),
    };
    publish();
  }

  function resetMessageTracking() {
    contentStreamStart = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    lastLiveUpdate = 0;
  }

  pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    state = { ...state, tokensPerSecond: null, generating: false };
    refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    state = {
      ...state,
      provider: event.model.provider,
      modelId: event.model.id,
      modelName: event.model.name,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: event.model.contextWindow,
    };
    refresh(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("agent_start", (_event, ctx) => {
    runContentTokens = 0;
    runContentStreamMs = 0;
    resetMessageTracking();
    state = { ...state, tokensPerSecond: null, generating: true };
    refresh(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetMessageTracking();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    // TPS is a visible-text throughput metric. Providers often deliver hidden
    // reasoning and tool JSON in large buffered chunks; mixing those events
    // with visible text produces intermittent 500–1000 tok/s spikes.
    if (streamEvent.type !== "text_delta") return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (
      contentDeltaCount < 2 ||
      elapsedMs < MIN_LIVE_SAMPLE_MS ||
      streamedCharacters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    ) {
      return;
    }
    lastLiveUpdate = now;

    state = {
      ...state,
      tokensPerSecond:
        estimateContentTokens(streamedCharacters) / (elapsedMs / 1000),
    };
    publish();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    if (contentStreamStart !== null && contentCharacters > 0) {
      // Include the final flush interval. Using the timestamp of the last delta
      // alone exaggerates throughput when a provider batches its final chunk.
      const streamMs = Date.now() - contentStreamStart;
      const estimatedFirstDeltaTokens = estimateContentTokens(
        firstContentDeltaCharacters,
      );
      // Use only text actually observed in the stream. Provider usage.output may
      // include hidden reasoning and tool-call tokens delivered on a different
      // cadence, which is the source of occasional implausible TPS readings.
      const streamedTokens = Math.max(
        0,
        estimateContentTokens(contentCharacters) - estimatedFirstDeltaTokens,
      );

      if (
        contentDeltaCount >= 2 &&
        streamMs >= MIN_FINAL_SAMPLE_MS &&
        streamedTokens > 0
      ) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
        state = {
          ...state,
          tokensPerSecond: runContentTokens / (runContentStreamMs / 1000),
        };
      }
    }

    resetMessageTracking();
    refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => refresh(ctx));

  pi.on("agent_settled", (_event, ctx) => {
    state = { ...state, generating: false };
    refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    currentContext = undefined;
  });
}
