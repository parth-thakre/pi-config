import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_FIRECRAWL_URL = "http://vostro:3002";

type FirecrawlScrapeResponse = {
	success?: boolean;
	data?: {
		markdown?: string;
		content?: string;
		html?: string;
		links?: string[];
		linksOnPage?: string[];
		metadata?: Record<string, unknown>;
	};
	returnCode?: number;
	warnings?: string[];
	error?: string;
};

function baseUrl() {
	return (process.env.FIRECRAWL_URL || DEFAULT_FIRECRAWL_URL).replace(/\/$/, "");
}

function clip(text: string | undefined, max: number) {
	if (!text) return "";
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function headers() {
	const h: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
	};
	const key = process.env.FIRECRAWL_API_KEY;
	if (key) h.authorization = `Bearer ${key}`;
	return h;
}

export default function firecrawlExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "scrape_url",
		label: "Scrape URL",
		description:
			"Scrape a web page using the user's local Firecrawl instance at http://vostro:3002. Use after web_search to fetch readable page content as Markdown.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to scrape" }),
			includeHtml: Type.Optional(Type.Boolean({ description: "Also include clipped raw HTML in details", default: false })),
			includeLinks: Type.Optional(Type.Boolean({ description: "Include links discovered on the page", default: true })),
			onlyMainContent: Type.Optional(Type.Boolean({ description: "Prefer main article/page content", default: true })),
			waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before scraping dynamic pages", default: 0, minimum: 0, maximum: 10000 })),
			maxChars: Type.Optional(Type.Number({ description: "Maximum Markdown characters to return", default: 20000, minimum: 1000, maximum: 80000 })),
		}),
		async execute(_toolCallId, params, signal) {
			const maxChars = Math.max(1000, Math.min(Number(params.maxChars ?? 20000), 80000));
			const formats = ["markdown"];
			if (params.includeLinks !== false) formats.push("links");
			if (params.includeHtml) formats.push("html");

			const response = await fetch(`${baseUrl()}/v2/scrape`, {
				method: "POST",
				signal,
				headers: headers(),
				body: JSON.stringify({
					url: params.url,
					formats,
					onlyMainContent: params.onlyMainContent ?? true,
					...(params.waitFor ? { waitFor: params.waitFor } : {}),
				}),
			});

			const raw = await response.text();
			let data: FirecrawlScrapeResponse;
			try {
				data = JSON.parse(raw) as FirecrawlScrapeResponse;
			} catch {
				throw new Error(`Firecrawl returned non-JSON ${response.status}: ${clip(raw, 1000)}`);
			}

			if (!response.ok || data.success === false) {
				throw new Error(`Firecrawl scrape failed ${response.status}: ${data.error || clip(raw, 1000)}`);
			}

			const page = data.data ?? {};
			const markdown = page.markdown || page.content || "";
			const metadata = page.metadata ?? {};
			const title = typeof metadata.title === "string" ? metadata.title : undefined;
			const sourceURL = typeof metadata.sourceURL === "string" ? metadata.sourceURL : params.url;
			const links = page.links ?? page.linksOnPage ?? [];

			const text = [
				title ? `# ${title}` : undefined,
				`Source: ${sourceURL}`,
				"",
				clip(markdown, maxChars) || "No Markdown content returned.",
				links.length && params.includeLinks !== false
					? `\n\nLinks (${links.length}):\n${links.slice(0, 50).map((link) => `- ${link}`).join("\n")}`
					: undefined,
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					metadata,
					links,
					warnings: data.warnings ?? [],
					...(params.includeHtml ? { html: clip(page.html, 20000) } : {}),
				},
			};
		},
	});

	pi.registerCommand("firecrawl-test", {
		description: "Test Firecrawl scrape connectivity",
		handler: async (_args, ctx) => {
			try {
				const response = await fetch(`${baseUrl()}/v2/scrape`, {
					method: "POST",
					headers: headers(),
					body: JSON.stringify({ url: "https://example.com", formats: ["markdown"] }),
				});
				ctx.ui.notify(
					response.ok ? `Firecrawl OK: ${baseUrl()}` : `Firecrawl error ${response.status}`,
					response.ok ? "success" : "error",
				);
			} catch (error) {
				ctx.ui.notify(`Firecrawl failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
