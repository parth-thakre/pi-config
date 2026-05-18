import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_EXA_URL = "https://api.exa.ai";
const MISSING_KEY_MESSAGE =
	"Exa key is not available. Run /exa-key for a session-only key, or set EXA_API_KEY_CMD to a command that prints it from your password manager.";

type ExaResult = {
	id?: string;
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
};

type ExaSearchResponse = {
	requestId?: string;
	autopromptString?: string;
	results?: ExaResult[];
};

function baseUrl() {
	return (process.env.EXA_BASE_URL || DEFAULT_EXA_URL).replace(/\/$/, "");
}

function clip(text: string | undefined, max: number) {
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function keyFromCommand() {
	const command = process.env.EXA_API_KEY_CMD?.trim();
	if (!command) return "";
	try {
		return execSync(command, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
	} catch {
		return "";
	}
}

export default function exaExtension(pi: ExtensionAPI) {
	let sessionApiKey = "";

	function apiKey() {
		return (
			sessionApiKey ||
			keyFromCommand() ||
			(process.env.EXA_ALLOW_ENV_KEY === "1" ? process.env.EXA_API_KEY || process.env.EXA_KEY || "" : "")
		);
	}

	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web with Exa for high-quality source URLs. Use alongside SearXNG web_search for URL discovery, then scrape selected URLs with scrape_url.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(Type.Number({ description: "Maximum results", default: 8, minimum: 1, maximum: 20 })),
			type: Type.Optional(Type.String({ description: "Exa search type: auto, neural, or keyword", default: "auto" })),
			includeText: Type.Optional(Type.Boolean({ description: "Include clipped page text snippets from Exa", default: false })),
			includeHighlights: Type.Optional(Type.Boolean({ description: "Include Exa highlights when available", default: true })),
			includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Optional domains to include" })),
			excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Optional domains to exclude" })),
		}),
		async execute(_toolCallId, params, signal) {
			const key = apiKey();
			if (!key) throw new Error(MISSING_KEY_MESSAGE);

			const limit = Math.max(1, Math.min(Number(params.limit ?? 8), 20));
			const searchType = ["auto", "neural", "keyword"].includes(String(params.type ?? "auto"))
				? String(params.type ?? "auto")
				: "auto";

			const response = await fetch(`${baseUrl()}/search`, {
				method: "POST",
				signal,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					"x-api-key": key,
				},
				body: JSON.stringify({
					query: params.query,
					numResults: limit,
					type: searchType,
					useAutoprompt: true,
					...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
					...(params.excludeDomains?.length ? { excludeDomains: params.excludeDomains } : {}),
					contents: {
						text: params.includeText ? { maxCharacters: 1000 } : false,
						highlights: params.includeHighlights ?? true,
						summary: false,
					},
				}),
			});

			const raw = await response.text();
			let data: ExaSearchResponse;
			try {
				data = JSON.parse(raw) as ExaSearchResponse;
			} catch {
				throw new Error(`Exa returned non-JSON ${response.status}: ${clip(raw, 1000)}`);
			}

			if (!response.ok) {
				throw new Error(`Exa returned ${response.status}: ${clip(raw, 1000)}`);
			}

			const results = (data.results ?? []).slice(0, limit).map((r, i) => ({
				rank: i + 1,
				title: r.title ?? "Untitled",
				url: r.url ?? "",
				publishedDate: r.publishedDate,
				author: r.author,
				score: r.score,
				highlights: r.highlights ?? [],
				text: params.includeText ? clip(r.text, 1000) : undefined,
			}));

			const text = results.length
				? results
						.map((r) => {
							const bits = [
								`${r.rank}. ${r.title}`,
								r.url,
								r.publishedDate ? `Published: ${r.publishedDate}` : undefined,
								r.highlights.length ? `Highlights: ${r.highlights.map((h) => clip(h, 220)).join(" | ")}` : undefined,
								r.text ? `Text: ${r.text}` : undefined,
							];
							return bits.filter(Boolean).join("\n");
						})
						.join("\n\n")
				: `No Exa results for: ${params.query}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					autopromptString: data.autopromptString,
					requestId: data.requestId,
					results,
				},
			};
		},
	});

	pi.registerCommand("exa-key", {
		description: "Set Exa API key for this Pi session only (not saved to disk)",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.input("Exa API key (session-only, not saved)", "paste key");
			const trimmed = value?.trim() ?? "";
			if (!trimmed) {
				ctx.ui.notify("Exa key unchanged", "info");
				return;
			}
			sessionApiKey = trimmed;
			ctx.ui.notify("Exa key stored in memory for this Pi session only", "success");
		},
	});

	pi.registerCommand("exa-clear", {
		description: "Clear the in-memory Exa API key",
		handler: async (_args, ctx) => {
			sessionApiKey = "";
			ctx.ui.notify("In-memory Exa key cleared", "success");
		},
	});

	pi.registerCommand("exa-test", {
		description: "Test Exa search connectivity",
		handler: async (_args, ctx) => {
			try {
				const key = apiKey();
				if (!key) {
					ctx.ui.notify(MISSING_KEY_MESSAGE, "error");
					return;
				}
				const response = await fetch(`${baseUrl()}/search`, {
					method: "POST",
					headers: {
						accept: "application/json",
						"content-type": "application/json",
						"x-api-key": key,
					},
					body: JSON.stringify({ query: "test", numResults: 1, contents: { text: false } }),
				});
				ctx.ui.notify(response.ok ? "Exa OK" : `Exa error ${response.status}`, response.ok ? "success" : "error");
			} catch (error) {
				ctx.ui.notify(`Exa failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
