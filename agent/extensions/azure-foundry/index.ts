import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type FoundryApi = "openai-completions" | "openai-responses";

type FoundryModel = {
  id: string;
  name?: string;
  api?: FoundryApi;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
};

type FoundryConfig = {
  endpoint?: string;
  apiKeyEnv?: string;
  provider?: string;
  apiVersion?: string;
  api?: FoundryApi;
  discoverDeployments?: boolean;
  subscriptionId?: string;
  resourceGroup?: string;
  accountName?: string;
  models?: FoundryModel[];
};

type AzureAccount = {
  name: string;
  kind: string;
  resourceGroup?: string;
  endpoint?: string | null;
  customSubdomain?: string | null;
};

type AzureDeployment = {
  name: string;
  modelName?: string;
  state?: string;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "azure-foundry.json");
const DEFAULT_API: FoundryApi = "openai-responses";
const LEGACY_CHAT_API: FoundryApi = "openai-completions";

const DEFAULT_THINKING_LEVEL_MAP: FoundryModel["thinkingLevelMap"] = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

const DEFAULT_MODELS: FoundryModel[] = [
  {
    id: "gpt-5.4-mini1",
    name: "Azure Foundry GPT 5.4 Mini",
    api: DEFAULT_API,
    reasoning: true,
    thinkingLevelMap: DEFAULT_THINKING_LEVEL_MAP,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 16384,
  },
];

function readConfig(): FoundryConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FoundryConfig;
}

function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error("Azure Foundry endpoint is empty");

  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    const normalizedPath = parsed.pathname.replace(/\/openai(?:$|\/).*/i, "").replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
  } catch {
    const withoutQuery = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return withoutQuery.replace(/\/openai(?:$|\/).*/i, "");
  }
}

function buildFoundryV1BaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}

function runAzJson<T>(args: string[]): T | undefined {
  try {
    const output = execFileSync("az", [...args, "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    return JSON.parse(output) as T;
  } catch {
    return undefined;
  }
}

function accountEndpoint(account: AzureAccount): string | undefined {
  if (account.kind === "AIServices" && account.customSubdomain) {
    return `https://${account.customSubdomain}.services.ai.azure.com`;
  }
  if (account.endpoint) return normalizeFoundryEndpoint(account.endpoint);
  return undefined;
}

function discoverAzureDeployments(config: FoundryConfig, endpoint: string): FoundryModel[] {
  const target = normalizeFoundryEndpoint(endpoint);
  let resourceGroup = config.resourceGroup;
  let accountName = config.accountName;

  if (!resourceGroup || !accountName) {
    const accounts = runAzJson<AzureAccount[]>([
      "cognitiveservices",
      "account",
      "list",
      ...(config.subscriptionId ? ["--subscription", config.subscriptionId] : []),
      "--query",
      "[].{name:name,kind:kind,resourceGroup:resourceGroup,endpoint:properties.endpoint,customSubdomain:properties.customSubDomainName}",
    ]);

    const matched = accounts?.find((account) => accountEndpoint(account) === target);
    resourceGroup = resourceGroup || matched?.resourceGroup;
    accountName = accountName || matched?.name;
  }

  if (!resourceGroup || !accountName) return [];

  const deployments = runAzJson<AzureDeployment[]>([
    "cognitiveservices",
    "account",
    "deployment",
    "list",
    ...(config.subscriptionId ? ["--subscription", config.subscriptionId] : []),
    "-g",
    resourceGroup,
    "-n",
    accountName,
    "--query",
    "[].{name:name,modelName:properties.model.name,state:properties.provisioningState}",
  ]);

  return (deployments || [])
    .filter((deployment) => deployment.state === "Succeeded")
    .map((deployment) => ({
      id: deployment.name,
      name: deployment.modelName || deployment.name,
      api: DEFAULT_API,
      reasoning: true,
      thinkingLevelMap: DEFAULT_THINKING_LEVEL_MAP,
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 16384,
    }));
}

function normalizedModelName(model: FoundryModel): string {
  return (model.name || model.id).toLowerCase();
}

function isReasoningFamily(model: FoundryModel): boolean {
  const name = normalizedModelName(model);
  return (
    name.startsWith("gpt-") ||
    name.startsWith("o1") ||
    name.startsWith("o3") ||
    name.startsWith("o4") ||
    name.includes("codex") ||
    name === "computer-use-preview"
  );
}

function resolveApi(model: FoundryModel, providerApi?: FoundryApi): FoundryApi {
  return model.api || providerApi || (isReasoningFamily(model) ? DEFAULT_API : LEGACY_CHAT_API);
}

function configuredModels(config: FoundryConfig): FoundryModel[] {
  if (config.models?.length) return config.models;
  const envModels = (process.env.AZURE_FOUNDRY_MODELS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id }));
  return envModels.length ? envModels : DEFAULT_MODELS;
}

export default function (pi: ExtensionAPI) {
  const config = readConfig();
  const endpoint = config.endpoint || process.env.AZURE_FOUNDRY_ENDPOINT;
  if (!endpoint) return;

  const discovered = config.discoverDeployments === false ? [] : discoverAzureDeployments(config, endpoint);
  const models = discovered.length ? discovered : configuredModels(config);
  if (models.length === 0) return;

  const provider = config.provider || "azure-foundry";
  const apiKeyEnv = config.apiKeyEnv || "AZURE_FOUNDRY_API_KEY";
  const headers: Record<string, string> = { "api-key": apiKeyEnv };

  if (config.apiVersion) {
    headers["api-version"] = config.apiVersion;
  }

  pi.registerProvider(provider, {
    name: "Azure AI Foundry",
    baseUrl: buildFoundryV1BaseUrl(endpoint),
    apiKey: apiKeyEnv,
    authHeader: false,
    api: config.api || DEFAULT_API,
    headers,
    oauth: {
      name: "Azure AI Foundry API key",
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const apiKey = await callbacks.onPrompt({
          message: "Enter your Azure AI Foundry API key:",
          placeholder: "API key",
        });

        const trimmed = apiKey.trim();
        if (!trimmed) throw new Error("Azure AI Foundry API key is empty");

        return {
          access: trimmed,
          refresh: trimmed,
          expires: Date.now() + 3650 * 24 * 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
        return credentials;
      },
      getApiKey(credentials: OAuthCredentials): string {
        return credentials.access;
      },
    },
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
    },
    models: models.map((model) => {
      const api = resolveApi(model, config.api);
      const reasoning = model.reasoning ?? api === DEFAULT_API;
      return {
        id: model.id,
        name: model.name || `Azure Foundry ${model.id}`,
        api,
        reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input || (isReasoningFamily(model) ? ["text", "image"] : ["text"]),
        contextWindow: model.contextWindow || 128000,
        maxTokens: model.maxTokens || 16384,
        compat: api === DEFAULT_API
          ? { supportsStore: false, maxTokensField: "max_completion_tokens" }
          : undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }),
  });
}
