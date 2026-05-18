import { visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const RESET = "\x1b[0m";
type RGB = [number, number, number];

const BLUE:  RGB = [91,  206, 250];
const PINK:  RGB = [245, 169, 184];
const WHITE: RGB = [255, 255, 255];
const MUTED: RGB = [142, 148, 170];

// Capital Π — top bar has upside-down pixel steps (narrow at top, widens each row).
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];

function fg([r, g, b]: RGB, text: string) {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
	return [
		Math.round(a[0] + (b[0] - a[0]) * t),
		Math.round(a[1] + (b[1] - a[1]) * t),
		Math.round(a[2] + (b[2] - a[2]) * t),
	];
}

// Per-character gradient — spaces are skipped, gradient maps only over
// visible (non-space) characters so the legs get the edge colours.
const TRANS: RGB[] = [BLUE, PINK, WHITE, PINK, BLUE];

function gradientText(text: string) {
	const chars = [...text];
	const visible = chars.filter((ch) => ch !== " ").length;
	if (visible === 0) return text;

	const segments = TRANS.length - 1;
	const colored: string[] = [];
	let vi = 0;

	for (const ch of chars) {
		if (ch === " ") { colored.push(ch); continue; }
		const p      = vi / Math.max(visible - 1, 1);
		const scaled = p * segments;
		const idx    = Math.min(Math.floor(scaled), TRANS.length - 2);
		const color  = mix(TRANS[idx], TRANS[idx + 1], scaled - idx);
		colored.push(fg(color, ch));
		vi++;
	}

	return colored.join("");
}

function center(text: string, width: number) {
	const pad = Math.floor((width - visibleWidth(text)) / 2);
	return pad > 0 ? " ".repeat(pad) + text : text;
}

function modelName(ctx: ExtensionContext) {
	const m  = ctx.model as { id?: string } | undefined;
	const id = m?.id ?? "";
	if (!id) return "pi";
	return id.replace(/[_-]+/g, " ").toUpperCase();
}

function providerName(ctx: ExtensionContext) {
	const m = ctx.model as { provider?: string } | undefined;
	return m?.provider ?? "";
}

const EXTENSIONS = ["azure-foundry", "exa", "firecrawl", "flow-title", "searxng"];
const THEMES     = ["trans-pride"];
const SKILLS     = ["web-research"];

function pill(label: string, color: RGB, items: string[]): string {
	return fg(color, label) + " " + items.map((i) => fg(MUTED, i)).join(fg(MUTED, "  "));
}

function renderHeader(width: number, ctx: ExtensionContext): string[] {
	const provider = providerName(ctx);
	return [
		"",
		...TITLE_LINES.map((line) => center(gradientText(line), width)),
		"",
		center(fg(PINK, modelName(ctx)), width),
		provider ? center(fg(MUTED, provider.toLowerCase()), width) : "",
		"",
		center(pill("extensions", BLUE,  EXTENSIONS), width),
		center(pill("theme",      PINK,  THEMES),     width),
		center(pill("skills",     WHITE, SKILLS),     width),
		"",
	];
}

export default function (pi: ExtensionAPI) {
	let requestHeaderRender: (() => void) | undefined;

	function installHeader(ctx: ExtensionContext) {
		ctx.ui.setHeader((tui) => {
			requestHeaderRender = () => tui.requestRender();
			return {
				render(width: number) { return renderHeader(width, ctx); },
				invalidate() { tui.requestRender(); },
			};
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) installHeader(ctx);
	});

	pi.on("model_select", () => requestHeaderRender?.());

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});
}
