import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
  truncateHead,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  Firecrawl,
  type CrawlJob,
  type Document,
  type SearchData,
} from "firecrawl";
import { Type } from "typebox";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  CRAWL_PARAMETER_DESCRIPTIONS,
  CRAWL_PROMPT_GUIDELINES,
  CRAWL_PROMPT_SNIPPET,
  CRAWL_TOOL_DESCRIPTION,
  SCRAPE_PARAMETER_DESCRIPTIONS,
  SCRAPE_PROMPT_GUIDELINES,
  SCRAPE_PROMPT_SNIPPET,
  SCRAPE_TOOL_DESCRIPTION,
  SEARCH_PARAMETER_DESCRIPTIONS,
  SEARCH_PROMPT_GUIDELINES,
  SEARCH_PROMPT_SNIPPET,
  SEARCH_TOOL_DESCRIPTION,
} from "./prompt.ts";

export const FIRECRAWL_CLOUD_API_URL = "https://api.firecrawl.dev";

export interface FirecrawlDetails {
  count: number;
  status: string;
  url?: string;
  title?: string;
  truncated: boolean;
  artifactPath?: string;
}

type FirecrawlMetadata = Omit<FirecrawlDetails, "truncated" | "artifactPath">;
type FirecrawlOperation = "search" | "crawl" | "scrape";
type IdentityKind = "query" | "url";
type StatusTone = "warning" | "success" | "error";

export interface FormattedFirecrawlOutput {
  text: string;
  truncated: boolean;
  artifactPath?: string;
}

function readEnvValue(name: string) {
  if (process.env[name]) return process.env[name];

  const envPath = join(homedir(), ".pi", "agent", ".env");
  let envText = "";

  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match || match[1] !== name) continue;

    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value.replace(/\s+#.*$/, "");
  }

  return undefined;
}

function createClient() {
  const apiKey = readEnvValue("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing FIRECRAWL_API_KEY in the environment or ~/.pi/agent/.env",
    );
  }

  // Always use Firecrawl Cloud with the API key. The SDK otherwise honors an
  // inherited FIRECRAWL_API_URL, which may point at an unavailable local server.
  return new Firecrawl({ apiKey, apiUrl: FIRECRAWL_CLOUD_API_URL });
}

function stringify(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function checkCancellation(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Firecrawl request cancelled");
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  checkCancellation(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Firecrawl request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortableDelay(ms: number, signal?: AbortSignal) {
  if (!signal) return new Promise<void>((resolve) => setTimeout(resolve, ms));
  checkCancellation(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Firecrawl request cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CrawlPollingClient {
  startCrawl(
    url: string,
    options?: Parameters<Firecrawl["startCrawl"]>[1],
  ): Promise<{ id: string }>;
  getCrawlStatus(
    id: string,
    pagination?: { autoPaginate?: boolean },
  ): Promise<CrawlJob>;
  cancelCrawl(id: string): Promise<boolean>;
}

/** Start, poll, and remotely cancel a crawl in response to the tool signal. */
export async function runAbortableCrawl(options: {
  client: CrawlPollingClient;
  url: string;
  request: Parameters<Firecrawl["startCrawl"]>[1];
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutSeconds?: number;
}): Promise<CrawlJob> {
  const { client, signal } = options;
  checkCancellation(signal);
  const startPromise = client.startCrawl(options.url, options.request);
  let started: { id: string };
  try {
    started = await abortable(startPromise, signal);
  } catch (error) {
    if (signal?.aborted) {
      void startPromise
        .then((job) => client.cancelCrawl(job.id))
        .catch(() => false);
    }
    throw error;
  }

  let cancelPromise: Promise<unknown> | undefined;
  const cancelRemote = () =>
    (cancelPromise ??= client.cancelCrawl(started.id).catch(() => false));
  const onAbort = () => void cancelRemote();
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline =
    Date.now() + Math.max(1, options.timeoutSeconds ?? 120) * 1_000;

  try {
    while (true) {
      checkCancellation(signal);
      const status = await abortable(
        client.getCrawlStatus(started.id, { autoPaginate: false }),
        signal,
      );
      if (status.status === "failed") {
        throw new Error(`crawl job ${started.id} ended with status failed`);
      }
      if (status.status === "cancelled") {
        throw new Error(`crawl job ${started.id} ended with status cancelled`);
      }
      if (status.status === "completed") {
        // Fetch all result pages only once, after the terminal success state.
        return await abortable(client.getCrawlStatus(started.id), signal);
      }
      if (Date.now() >= deadline) {
        await cancelRemote();
        throw new Error(
          `crawl job ${started.id} timed out after ${options.timeoutSeconds ?? 120} seconds`,
        );
      }
      await abortableDelay(
        Math.max(100, options.pollIntervalMs ?? 2_000),
        signal,
      );
    }
  } catch (error) {
    if (signal?.aborted) await cancelRemote();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function formatFirecrawlOutput(
  value: unknown,
  operation: FirecrawlOperation,
): Promise<FormattedFirecrawlOutput> {
  const output = typeof value === "string" ? value : stringify(value);
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncation.truncated) {
    return { text: output, truncated: false };
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "pi-firecrawl-"));
  const outputPath = join(outputDirectory, `${operation}.json`);
  await writeFile(outputPath, output, "utf8");

  return {
    text: `${truncation.content}\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${outputPath}]`,
    truncated: true,
    artifactPath: outputPath,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: unknown, field: string) {
  const candidate = record(value)?.[field];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
}

function compactMetadataField(value: unknown, field: string) {
  const raw = stringField(value, field);
  if (!raw) return undefined;

  const characters = [...compactIdentity(raw)];
  return characters.length > 512
    ? `${characters.slice(0, 511).join("")}…`
    : characters.join("");
}

function firstResultMetadata(value: unknown): {
  url?: string;
  title?: string;
} {
  const item = record(value);
  const metadata = record(item?.metadata);
  return {
    url:
      compactMetadataField(item, "url") ??
      compactMetadataField(metadata, "url") ??
      compactMetadataField(metadata, "sourceURL"),
    title:
      compactMetadataField(item, "title") ??
      compactMetadataField(metadata, "title"),
  };
}

export function getSearchMetadata(result: SearchData): FirecrawlMetadata {
  const groups = [result.web ?? [], result.news ?? [], result.images ?? []];
  const first = groups.find((group) => group.length > 0)?.[0];
  return {
    count: groups.reduce((count, group) => count + group.length, 0),
    status: "completed",
    ...firstResultMetadata(first),
  };
}

export function getCrawlMetadata(result: CrawlJob): FirecrawlMetadata {
  return {
    count: result.completed,
    status: result.status,
    ...firstResultMetadata(result.data[0]),
  };
}

export function getScrapeMetadata(document: Document): FirecrawlMetadata {
  const statusCode = document.metadata?.statusCode;
  return {
    count: document.markdown || document.html || document.rawHtml ? 1 : 0,
    status: statusCode ? `HTTP ${statusCode}` : "scraped",
    url:
      compactMetadataField(document.metadata, "url") ??
      compactMetadataField(document.metadata, "sourceURL"),
    title: compactMetadataField(document.metadata, "title"),
  };
}

/** Shared execute pipeline: cancellation, progress update, request, truncation, errors. */
async function runFirecrawl(
  operation: FirecrawlOperation,
  status: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<FirecrawlDetails | undefined> | undefined,
  request: (
    client: Firecrawl,
  ) => Promise<{ details: FirecrawlMetadata; output: unknown }>,
): Promise<AgentToolResult<FirecrawlDetails | undefined>> {
  try {
    checkCancellation(signal);
    onUpdate?.({
      content: [{ type: "text", text: status }],
      details: undefined,
    });

    const { details, output } = await request(createClient());
    checkCancellation(signal);
    const formatted = await formatFirecrawlOutput(output, operation);

    return {
      content: [{ type: "text", text: formatted.text }],
      details: {
        ...details,
        truncated: formatted.truncated,
        artifactPath: formatted.artifactPath,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Firecrawl ${operation} failed: ${message}`, {
      cause: error,
    });
  }
}

function compactIdentity(value: unknown) {
  const sanitized = sanitizeTerminalText(typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized || "[missing identity]";
}

function renderIdentity(value: string, kind: IdentityKind, maxWidth: number) {
  if (kind === "url" || maxWidth < 3) {
    return truncateToWidth(value, maxWidth, "…");
  }

  return `"${truncateToWidth(value, maxWidth - 2, "…")}"`;
}

class FirecrawlRenderComponent implements Component {
  private readonly theme: Theme;
  private readonly identity: string;
  private readonly identityKind: IdentityKind;
  private readonly options: {
    title?: string;
    status?: string;
    tone?: StatusTone;
    hint?: string;
    body?: string;
  };
  private readonly body?: Text;

  constructor(
    theme: Theme,
    identity: string,
    identityKind: IdentityKind,
    options: {
      title?: string;
      status?: string;
      tone?: StatusTone;
      hint?: string;
      body?: string;
    },
  ) {
    this.theme = theme;
    this.identity = identity;
    this.identityKind = identityKind;
    this.options = options;
    if (options.body) {
      this.body = new Text(
        theme.fg("toolOutput", sanitizeTerminalText(options.body)),
        0,
        0,
      );
    }
  }

  render(width: number): string[] {
    if (width <= 0) return [""];

    const title = this.options.title
      ? `${this.theme.fg("toolTitle", this.theme.bold(this.options.title))} `
      : "";
    const status = this.options.status
      ? this.theme.fg(
          this.options.tone ?? "success",
          ` · ${compactIdentity(this.options.status)}`,
        )
      : "";
    const hint = this.options.hint
      ? this.theme.fg("dim", ` (${this.options.hint})`)
      : "";
    const suffix = `${status}${hint}`;
    const identityWidth = Math.max(
      1,
      width - visibleWidth(title) - visibleWidth(suffix),
    );
    const identity = this.theme.fg(
      "accent",
      renderIdentity(this.identity, this.identityKind, identityWidth),
    );
    const header = truncateToWidth(`${title}${identity}${suffix}`, width, "");

    return this.body ? [header, ...this.body.render(width)] : [header];
  }

  invalidate(): void {
    this.body?.invalidate();
  }
}

function textOutput(result: AgentToolResult<unknown>) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function legacyCount(operation: FirecrawlOperation, details: unknown) {
  const value = record(details);
  if (!value) return 0;
  if (typeof value.count === "number" && Number.isFinite(value.count)) {
    return value.count;
  }
  if (operation === "search") {
    return [value.web, value.news, value.images].reduce<number>(
      (count, group) => count + (Array.isArray(group) ? group.length : 0),
      0,
    );
  }
  if (typeof value.completed === "number") return value.completed;
  if (Array.isArray(value.data)) return value.data.length;
  return operation === "scrape" && (value.markdown || value.html) ? 1 : 0;
}

function rendererDetails(
  operation: FirecrawlOperation,
  details: unknown,
): FirecrawlDetails {
  const value = record(details);
  const metadata = record(value?.metadata);
  const statusCode = metadata?.statusCode;
  return {
    count: legacyCount(operation, details),
    status:
      stringField(value, "status") ??
      (typeof statusCode === "number" ? `HTTP ${statusCode}` : undefined) ??
      (operation === "scrape" ? "scraped" : "completed"),
    url: stringField(value, "url") ?? stringField(metadata, "url"),
    title: stringField(value, "title") ?? stringField(metadata, "title"),
    truncated: value?.truncated === true,
    artifactPath: stringField(value, "artifactPath"),
  };
}

function statusFor(
  operation: FirecrawlOperation,
  details: FirecrawlDetails,
  isPartial: boolean,
  isError: boolean,
) {
  if (isPartial) {
    return operation === "search"
      ? "searching…"
      : operation === "crawl"
        ? "crawling…"
        : "scraping…";
  }
  if (isError) return "failed";

  const noun = operation === "search" ? "result" : "page";
  const count = `${details.count} ${noun}${details.count === 1 ? "" : "s"}`;
  const base = operation === "search" ? count : `${details.status} · ${count}`;
  return details.truncated ? `${base} · truncated` : base;
}

function renderCall(
  operation: FirecrawlOperation,
  theme: Theme,
  args: Record<string, unknown>,
) {
  const identityKind: IdentityKind = operation === "search" ? "query" : "url";
  return new FirecrawlRenderComponent(
    theme,
    compactIdentity(args[identityKind]),
    identityKind,
    { title: operation },
  );
}

function renderResult(
  operation: FirecrawlOperation,
  result: AgentToolResult<unknown>,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  args: Record<string, unknown>,
  isError: boolean,
) {
  const identityKind: IdentityKind = operation === "search" ? "query" : "url";
  const output = textOutput(result);
  const details = rendererDetails(operation, result.details);
  const tone: StatusTone = options.isPartial
    ? "warning"
    : isError
      ? "error"
      : "success";

  return new FirecrawlRenderComponent(
    theme,
    compactIdentity(args[identityKind]),
    identityKind,
    {
      status: statusFor(operation, details, options.isPartial, isError),
      tone,
      hint:
        !options.expanded && !options.isPartial && output
          ? keyHint("app.tools.expand", "to expand")
          : undefined,
      body: options.expanded && !options.isPartial ? output : undefined,
    },
  );
}

export default function firecrawlTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "search",
    label: "Search Web",
    description: SEARCH_TOOL_DESCRIPTION,
    promptSnippet: SEARCH_PROMPT_SNIPPET,
    promptGuidelines: SEARCH_PROMPT_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({
        description: SEARCH_PARAMETER_DESCRIPTIONS.query,
      }),
      limit: Type.Optional(
        Type.Number({
          description: SEARCH_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 20,
        }),
      ),
      source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
      scrapeResults: Type.Optional(
        Type.Boolean({
          description: SEARCH_PARAMETER_DESCRIPTIONS.scrapeResults,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "search",
        `Searching Firecrawl for: ${params.query}`,
        signal,
        onUpdate,
        async (client) => {
          const result = await client.search(params.query, {
            limit: params.limit ?? 5,
            sources: [params.source ?? "web"],
            scrapeOptions: params.scrapeResults
              ? { formats: ["markdown"], timeout: 30_000 }
              : undefined,
            timeout: 30_000,
          });
          return {
            details: getSearchMetadata(result),
            output: result,
          };
        },
      ),
    renderCall(_args, theme, context) {
      return renderCall("search", theme, context.args);
    },
    renderResult(result, options, theme, context) {
      return renderResult(
        "search",
        result,
        options,
        theme,
        context.args,
        context.isError,
      );
    },
  });

  pi.registerTool({
    name: "crawl",
    label: "Crawl Website",
    description: CRAWL_TOOL_DESCRIPTION,
    promptSnippet: CRAWL_PROMPT_SNIPPET,
    promptGuidelines: CRAWL_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: CRAWL_PARAMETER_DESCRIPTIONS.url }),
      limit: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.limit,
          minimum: 1,
          maximum: 100,
        }),
      ),
      maxDiscoveryDepth: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.maxDiscoveryDepth,
          minimum: 0,
        }),
      ),
      includePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.includePaths,
        }),
      ),
      excludePaths: Type.Optional(
        Type.Array(Type.String(), {
          description: CRAWL_PARAMETER_DESCRIPTIONS.excludePaths,
        }),
      ),
      crawlEntireDomain: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.crawlEntireDomain,
        }),
      ),
      allowSubdomains: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.allowSubdomains,
        }),
      ),
      sitemap: Type.Optional(StringEnum(["include", "skip", "only"] as const)),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: CRAWL_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: CRAWL_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
          maximum: 600,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "crawl",
        `Crawling up to ${params.limit ?? 20} pages from: ${params.url}`,
        signal,
        onUpdate,
        async (client) => {
          const result = await runAbortableCrawl({
            client,
            url: params.url,
            signal,
            timeoutSeconds: params.timeout ?? 120,
            request: {
              limit: params.limit ?? 20,
              maxDiscoveryDepth: params.maxDiscoveryDepth,
              includePaths: params.includePaths,
              excludePaths: params.excludePaths,
              crawlEntireDomain: params.crawlEntireDomain,
              allowSubdomains: params.allowSubdomains,
              sitemap: params.sitemap,
              scrapeOptions: {
                formats: ["markdown"],
                onlyMainContent: params.onlyMainContent ?? true,
              },
            },
          });
          return {
            details: getCrawlMetadata(result),
            output: result,
          };
        },
      ),
    renderCall(_args, theme, context) {
      return renderCall("crawl", theme, context.args);
    },
    renderResult(result, options, theme, context) {
      return renderResult(
        "crawl",
        result,
        options,
        theme,
        context.args,
        context.isError,
      );
    },
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description: SCRAPE_TOOL_DESCRIPTION,
    promptSnippet: SCRAPE_PROMPT_SNIPPET,
    promptGuidelines: SCRAPE_PROMPT_GUIDELINES,
    parameters: Type.Object({
      url: Type.String({ description: SCRAPE_PARAMETER_DESCRIPTIONS.url }),
      onlyMainContent: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.onlyMainContent,
        }),
      ),
      waitFor: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.waitFor,
          minimum: 0,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.timeout,
          minimum: 1,
        }),
      ),
      includeMetadata: Type.Optional(
        Type.Boolean({
          description: SCRAPE_PARAMETER_DESCRIPTIONS.includeMetadata,
        }),
      ),
    }),
    execute: (_toolCallId, params, signal, onUpdate) =>
      runFirecrawl(
        "scrape",
        `Scraping page with Firecrawl: ${params.url}`,
        signal,
        onUpdate,
        async (client) => {
          const document = await client.scrape(params.url, {
            formats: ["markdown"],
            onlyMainContent: params.onlyMainContent ?? true,
            waitFor: params.waitFor,
            timeout: params.timeout ?? 30_000,
          });

          const metadata =
            params.includeMetadata && document.metadata
              ? `\n\nMetadata:\n${stringify(document.metadata)}`
              : "";
          const markdown =
            document.markdown?.trim() || "No markdown content returned.";

          return {
            details: getScrapeMetadata(document),
            output: `${markdown}${metadata}`,
          };
        },
      ),
    renderCall(_args, theme, context) {
      return renderCall("scrape", theme, context.args);
    },
    renderResult(result, options, theme, context) {
      return renderResult(
        "scrape",
        result,
        options,
        theme,
        context.args,
        context.isError,
      );
    },
  });
}
