import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const PROVIDER = "llamacpp";
const DEFAULT_BASE_URL = "http://loq:8085/v1";
const DEFAULT_MODEL = "llama.cpp";
const FALLBACK_CONTEXT_WINDOW = 32_768;
const FALLBACK_MAX_TOKENS = 4_096;

type LlamaCppModel = {
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
};

type ModelsResponse = { data?: LlamaCppModel[] };
type StoredConfig = { url: string; model: LlamaCppModel };
type PropsResponse = {
  default_generation_settings?: {
    n_ctx?: number;
    n_predict?: number;
  };
  total_slots?: number;
  model_path?: string;
};

function normalizeBaseUrl(input: string) {
  let url = input.trim();
  if (!url) return DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/$/, "");
  if (!url.endsWith("/v1")) url = `${url}/v1`;
  return url;
}

function serverRoot(url: string) {
  return url.replace(/\/v1$/, "");
}

async function discoverModel(url: string): Promise<LlamaCppModel> {
  const headers = { Authorization: `Bearer ${process.env.LLAMACPP_API_KEY ?? "local"}` };

  const modelResponse = await fetch(`${url}/models`, {
    signal: AbortSignal.timeout(3_000),
    headers,
  });

  if (!modelResponse.ok) throw new Error(`GET ${url}/models returned ${modelResponse.status}`);

  const payload = (await modelResponse.json()) as ModelsResponse;
  const model = payload.data?.[0] ?? { id: process.env.LLAMACPP_MODEL ?? DEFAULT_MODEL };

  // llama.cpp exposes runtime settings at /props (not /v1/props). Use it when available
  // so pi's context window matches the currently running server instead of a hardcoded default.
  const props = await fetch(`${serverRoot(url)}/props`, {
    signal: AbortSignal.timeout(3_000),
    headers,
  })
    .then(async (response) => (response.ok ? ((await response.json()) as PropsResponse) : undefined))
    .catch(() => undefined);

  const nCtx = props?.default_generation_settings?.n_ctx;
  const nPredict = props?.default_generation_settings?.n_predict;

  return {
    ...model,
    name: model.name ?? model.id ?? props?.model_path,
    context_window: model.context_window ?? (typeof nCtx === "number" && nCtx > 0 ? nCtx : undefined),
    max_tokens: model.max_tokens ?? (typeof nPredict === "number" && nPredict > 0 ? nPredict : undefined),
  };
}

function encodeConfig(config: StoredConfig) {
  return JSON.stringify(config);
}

function decodeConfig(credentials: OAuthCredentials): StoredConfig | undefined {
  try {
    return JSON.parse(credentials.refresh) as StoredConfig;
  } catch {
    return undefined;
  }
}

async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const url = normalizeBaseUrl(await callbacks.onPrompt({ message: "llama.cpp server URL (example: loq:8085):" }));
  const model = await discoverModel(url);

  return {
    access: process.env.LLAMACPP_API_KEY ?? "local",
    refresh: encodeConfig({ url, model }),
    // Effectively never expires; /login again to change the server.
    expires: Date.now() + 1000 * 60 * 60 * 24 * 365 * 20,
  };
}

export default function llamaCppExtension(pi: ExtensionAPI) {
  const fallbackUrl = normalizeBaseUrl(process.env.LLAMACPP_BASE_URL ?? DEFAULT_BASE_URL);

  pi.registerProvider(PROVIDER, {
    name: "llama.cpp",
    baseUrl: fallbackUrl,
    apiKey: process.env.LLAMACPP_API_KEY ?? "local",
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: [
      {
        id: process.env.LLAMACPP_MODEL ?? DEFAULT_MODEL,
        name: "llama.cpp (run /login llamacpp)",
        reasoning: false,
        input: ["text"],
        contextWindow: Number(process.env.LLAMACPP_CONTEXT_WINDOW ?? FALLBACK_CONTEXT_WINDOW),
        maxTokens: Number(process.env.LLAMACPP_MAX_TOKENS ?? FALLBACK_MAX_TOKENS),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    oauth: {
      name: "llama.cpp server",
      login,
      async refreshToken(credentials) {
        const config = decodeConfig(credentials);
        if (!config) return credentials;

        // Refresh model metadata from the server when possible.
        const model = await discoverModel(config.url).catch(() => config.model);
        return { ...credentials, refresh: encodeConfig({ url: config.url, model }) };
      },
      getApiKey(credentials) {
        return credentials.access || "local";
      },
      modifyModels(models, credentials) {
        const config = decodeConfig(credentials);
        if (!config) return models;

        return models.map((model) => ({
          ...model,
          id: config.model.id,
          name: config.model.name ?? config.model.id,
          baseUrl: config.url,
          contextWindow: config.model.context_window ?? Number(process.env.LLAMACPP_CONTEXT_WINDOW ?? FALLBACK_CONTEXT_WINDOW),
          maxTokens: config.model.max_tokens ?? Number(process.env.LLAMACPP_MAX_TOKENS ?? FALLBACK_MAX_TOKENS),
        }));
      },
    },
  });
}
