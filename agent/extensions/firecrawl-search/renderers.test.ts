import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MAX_BYTES,
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CrawlJob, Document, SearchData } from "firecrawl";
import firecrawlTools, {
  FIRECRAWL_CLOUD_API_URL,
  formatFirecrawlOutput,
  getCrawlMetadata,
  getScrapeMetadata,
  getSearchMetadata,
  runAbortableCrawl,
  type FirecrawlDetails,
} from "./index.ts";

type RenderArgs = Record<string, unknown>;
interface RenderContext {
  args: RenderArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: unknown;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

type CapturedTool = {
  name: string;
  renderCall?: (
    args: RenderArgs,
    theme: Theme,
    context: RenderContext,
  ) => Component;
  renderResult?: (
    result: AgentToolResult<unknown>,
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    context: RenderContext,
  ) => Component;
};

initTheme("dark");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const tools = new Map<string, CapturedTool>();
firecrawlTools({
  registerTool(tool: CapturedTool) {
    tools.set(tool.name, tool);
  },
} as unknown as ExtensionAPI);

function getTool(name: string) {
  const tool = tools.get(name);
  assert.ok(tool?.renderCall, `${name} has a renderCall`);
  assert.ok(tool.renderResult, `${name} has a renderResult`);
  return tool as Required<
    Pick<CapturedTool, "name" | "renderCall" | "renderResult">
  >;
}

function renderContext(
  args: RenderArgs,
  options: {
    expanded?: boolean;
    isPartial?: boolean;
    isError?: boolean;
  } = {},
): RenderContext {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: options.isPartial ?? false,
    expanded: options.expanded ?? false,
    showImages: false,
    isError: options.isError ?? false,
  };
}

function render(component: Component, width = 88) {
  const lines = component.render(width);
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `rendered line is ${visibleWidth(line)} columns at width ${width}`,
    );
  }
  return { lines, text: lines.join("\n") };
}

const cases = [
  {
    operation: "search",
    identityKey: "query",
    identity: "pi extension renderers",
    details: {
      count: 3,
      status: "completed",
      truncated: false,
    } satisfies FirecrawlDetails,
    successStatus: "3 results",
    partialStatus: "searching…",
  },
  {
    operation: "crawl",
    identityKey: "url",
    identity: "https://example.com/docs",
    details: {
      count: 2,
      status: "completed",
      truncated: false,
    } satisfies FirecrawlDetails,
    successStatus: "completed · 2 pages",
    partialStatus: "crawling…",
  },
  {
    operation: "scrape",
    identityKey: "url",
    identity: "https://example.com/docs/start",
    details: {
      count: 1,
      status: "HTTP 200",
      title: "Start here",
      truncated: false,
    } satisfies FirecrawlDetails,
    successStatus: "HTTP 200 · 1 page",
    partialStatus: "scraping…",
  },
] as const;

for (const item of cases) {
  test(`${item.operation} renderCall reads and displays context.args identity`, () => {
    const tool = getTool(item.operation);
    const args = { [item.identityKey]: item.identity };
    const call = tool.renderCall(
      { [item.identityKey]: "mutable-decoy" },
      theme,
      renderContext(args),
    );
    const output = render(call).text;

    assert.match(output, new RegExp(item.operation));
    assert.match(
      output,
      new RegExp(item.identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(output, /mutable-decoy/);
  });

  for (const expanded of [false, true]) {
    for (const state of ["partial", "success", "error"] as const) {
      test(`${item.operation} ${state} result renders ${expanded ? "expanded" : "collapsed"}`, () => {
        const tool = getTool(item.operation);
        const args = { [item.identityKey]: item.identity };
        const isPartial = state === "partial";
        const isError = state === "error";
        const body =
          state === "partial"
            ? `${item.operation} progress update`
            : state === "error"
              ? `${item.operation} network exploded`
              : `${item.operation} expanded body`;
        const result: AgentToolResult<unknown> = {
          content: [{ type: "text", text: body }],
          details: state === "success" ? item.details : undefined,
        };
        const component = tool.renderResult(
          result,
          { expanded, isPartial },
          theme,
          renderContext(args, { expanded, isPartial, isError }),
        );
        const output = render(component, 88).text;

        assert.match(
          output,
          new RegExp(item.identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        assert.match(
          output,
          new RegExp(
            state === "partial"
              ? item.partialStatus
              : state === "error"
                ? "failed"
                : item.successStatus,
          ),
        );

        if (!expanded && !isPartial) {
          assert.match(output, /to expand/);
          assert.doesNotMatch(output, new RegExp(body));
        } else {
          assert.doesNotMatch(output, /to expand/);
        }

        if (expanded && !isPartial) {
          assert.match(output, new RegExp(body));
        } else {
          assert.doesNotMatch(output, new RegExp(body));
        }
      });
    }
  }
}

test("long control-bearing identities stay inert and bounded in closed frames", () => {
  for (const item of cases) {
    const tool = getTool(item.operation);
    const identity = `identifying-prefix-${item.operation}-\u001b]0;hidden-title\u0007\u001b[31m${"x".repeat(180)}\nsecond-line`;
    const args = { [item.identityKey]: identity };
    const result: AgentToolResult<unknown> = {
      content: [{ type: "text", text: "bounded output" }],
      details: item.details,
    };
    const components = [
      tool.renderCall(args, theme, renderContext(args)),
      tool.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        renderContext(args),
      ),
    ];

    for (const [index, component] of components.entries()) {
      const output = render(component, 64);
      assert.ok(output.lines.length >= 1);
      assert.ok(output.lines.every((line) => visibleWidth(line) <= 64));
      assert.match(
        output.text,
        new RegExp(`identifying-prefix-${item.operation}`),
      );
      assert.doesNotMatch(
        output.text,
        /hidden-title|\u0007|second-line|\u001b\]|\u001b\[31m/,
      );
      if (index === 0) {
        assert.match(output.lines[0] ?? "", /^╭.*╮$/u);
      } else {
        assert.match(output.lines.at(-1) ?? "", /^╰.*╯$/u);
      }
    }
  }
});

test("renderer metadata excludes full Firecrawl SDK payloads", () => {
  const searchResponse = {
    web: [
      {
        url: "https://example.com/result",
        title: "Result",
        markdown: "full search markdown must not enter details",
      },
    ],
    news: [{ url: "https://example.com/news", title: "News" }],
  } as SearchData;
  const crawlResponse = {
    id: "crawl-1",
    status: "completed",
    total: 1,
    completed: 1,
    data: [
      {
        markdown: "full crawl markdown must not enter details",
        metadata: {
          sourceURL: "https://example.com/crawled",
          title: "Crawled",
        },
      },
    ],
  } as CrawlJob;
  const scrapeResponse = {
    markdown: "full scrape markdown must not enter details",
    metadata: {
      url: "https://example.com/scraped",
      title: "Scraped",
      statusCode: 200,
    },
  } satisfies Document;

  assert.deepEqual(getSearchMetadata(searchResponse), {
    count: 2,
    status: "completed",
    url: "https://example.com/result",
    title: "Result",
  });
  assert.deepEqual(getCrawlMetadata(crawlResponse), {
    count: 1,
    status: "completed",
    url: "https://example.com/crawled",
    title: "Crawled",
  });
  assert.deepEqual(getScrapeMetadata(scrapeResponse), {
    count: 1,
    status: "HTTP 200",
    url: "https://example.com/scraped",
    title: "Scraped",
  });

  const serialized = JSON.stringify([
    getSearchMetadata(searchResponse),
    getCrawlMetadata(crawlResponse),
    getScrapeMetadata(scrapeResponse),
  ]);
  assert.doesNotMatch(serialized, /full .* markdown|markdown|data|web|news/);

  const hostileMetadata = getScrapeMetadata({
    markdown: "body",
    metadata: {
      title: `identifying-title\u001b]0;hidden\u0007${"x".repeat(600)}`,
      url: `https://example.com/identifying-path/${"y".repeat(600)}`,
    },
  });
  assert.match(hostileMetadata.title ?? "", /^identifying-title/);
  assert.doesNotMatch(hostileMetadata.title ?? "", /hidden|\u001b|\u0007/);
  assert.ok((hostileMetadata.title?.length ?? 0) <= 512);
  assert.ok((hostileMetadata.url?.length ?? 0) <= 512);
});

test("truncation metadata and notice retain only the full temp artifact path", async () => {
  const fullOutput = `identifying output prefix\n${"x".repeat(DEFAULT_MAX_BYTES + 1_024)}`;
  const formatted = await formatFirecrawlOutput(fullOutput, "search");

  assert.equal(formatted.truncated, true);
  assert.ok(formatted.artifactPath);
  assert.match(formatted.text, /Output truncated:/);
  assert.match(formatted.text, /Full output saved to:/);
  assert.match(
    formatted.text,
    new RegExp(formatted.artifactPath.replace(/[/\\.]/g, "\\$&")),
  );
  assert.equal(await readFile(formatted.artifactPath, "utf8"), fullOutput);

  await rm(dirname(formatted.artifactPath), { recursive: true, force: true });
});

test("crawl polling throws for failed and cancelled terminal jobs", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const client = {
      async startCrawl() {
        return { id: `job-${status}` };
      },
      async getCrawlStatus() {
        return {
          id: `job-${status}`,
          status,
          completed: 0,
          total: 1,
          data: [],
        } as CrawlJob;
      },
      async cancelCrawl() {
        return true;
      },
    };
    await assert.rejects(
      runAbortableCrawl({
        client,
        url: "https://example.com",
        request: {},
        pollIntervalMs: 1,
      }),
      new RegExp(status),
    );
  }
});

test("aborting crawl polling cancels the remote job", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  const client = {
    async startCrawl() {
      return { id: "job-abort" };
    },
    async getCrawlStatus() {
      return {
        id: "job-abort",
        status: "scraping",
        completed: 0,
        total: 1,
        data: [],
      } as CrawlJob;
    },
    async cancelCrawl(id: string) {
      assert.equal(id, "job-abort");
      cancellations++;
      return true;
    },
  };
  const pending = runAbortableCrawl({
    client,
    url: "https://example.com",
    request: {},
    signal: controller.signal,
    pollIntervalMs: 10_000,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancellations, 1);
});

test("Firecrawl client remains pinned to the Cloud API URL", () => {
  assert.equal(FIRECRAWL_CLOUD_API_URL, "https://api.firecrawl.dev");
});
