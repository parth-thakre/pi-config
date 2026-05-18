import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_SEARXNG_URL = "http://vostro:8888";

type SearxResult = {
	url?: string;
	title?: string;
	content?: string;
	engine?: string;
	engines?: string[];
	score?: number;
};

type SearxResponse = {
	query?: string;
	results?: SearxResult[];
	answers?: string[];
	corrections?: string[];
	infoboxes?: unknown[];
};

function baseUrl() {
	return (process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL).replace(/\/$/, "");
}

function clip(text: string | undefined, max: number) {
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function searxngExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using the user's SearXNG instance at http://vostro:8888. Use this for current web/news/research lookups.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results to return", default: 8, minimum: 1, maximum: 20 })),
			categories: Type.Optional(Type.String({ description: "Optional SearXNG categories, e.g. general, news, science" })),
			language: Type.Optional(Type.String({ description: "Optional language code, e.g. en" })),
		}),
		async execute(_toolCallId, params, signal) {
			const limit = Math.max(1, Math.min(Number(params.limit ?? 8), 20));
			const url = new URL(`${baseUrl()}/search`);
			url.searchParams.set("q", params.query);
			url.searchParams.set("format", "json");
			if (params.categories) url.searchParams.set("categories", params.categories);
			if (params.language) url.searchParams.set("language", params.language);

			const response = await fetch(url, { signal, headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`SearXNG returned ${response.status}: ${await response.text()}`);

			const data = (await response.json()) as SearxResponse;
			const results = (data.results ?? []).slice(0, limit).map((r, i) => ({
				rank: i + 1,
				title: r.title ?? "Untitled",
				url: r.url ?? "",
				snippet: clip(r.content, 700),
				engines: r.engines ?? (r.engine ? [r.engine] : []),
				score: r.score,
			}));

			const text = results.length
				? results.map((r) => `${r.rank}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n")
				: `No results for: ${params.query}`;

			return {
				content: [{ type: "text", text }],
				details: { query: data.query ?? params.query, results, answers: data.answers ?? [], corrections: data.corrections ?? [] },
			};
		},
	});

	pi.registerCommand("webtest", {
		description: "Test SearXNG web_search connectivity",
		handler: async (_args, ctx) => {
			try {
				const url = new URL(`${baseUrl()}/search`);
				url.searchParams.set("q", "test");
				url.searchParams.set("format", "json");
				const response = await fetch(url, { headers: { accept: "application/json" } });
				ctx.ui.notify(response.ok ? `SearXNG OK: ${baseUrl()}` : `SearXNG error ${response.status}`, response.ok ? "success" : "error");
			} catch (error) {
				ctx.ui.notify(`SearXNG failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
