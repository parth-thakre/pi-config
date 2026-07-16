import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  initTheme,
  type AgentToolResult,
  type ExecOptions,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { execCommand } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
import {
  buildFdArgs,
  buildRgArgs,
  FD_DEFAULT_LIMIT,
  normalizeSearchPath,
  RG_DEFAULT_LIMIT,
} from "./args.ts";
import { bundledBinaryPath, resolveSearchBinary } from "./binaries.ts";
import fileSearchTools, {
  type FdToolDetails,
  type RgToolDetails,
} from "./index.ts";
import {
  boundedStderr,
  formatSearchOutput,
  normalizeSearchOutput,
  searchFailureMessage,
} from "./output.ts";
import { FD_PROMPT_GUIDELINES, RG_PROMPT_GUIDELINES } from "./prompt.ts";

// Pure argv construction ------------------------------------------------------

test("fd argv keeps all user-controlled positional values behind --", () => {
  assert.deepEqual(
    buildFdArgs({
      pattern: "-pattern [空]",
      path: "@-path with spaces\\nested",
      type: "file",
      extension: ".ts",
      glob: true,
      hidden: true,
      no_ignore: true,
      max_depth: 500,
      limit: 50_000,
    }),
    [
      "--color=never",
      "--hidden",
      "--no-ignore",
      "--glob",
      "--type",
      "f",
      "--extension",
      "ts",
      "--max-depth",
      "64",
      "--max-results",
      "10000",
      "--",
      "-pattern [空]",
      "-path with spaces\\nested",
    ],
  );
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
});

test("rg argv covers regex/fixed/case/glob/type/context flags and clamps", () => {
  assert.deepEqual(
    buildRgArgs({
      pattern: "--help Ω",
      path: "@-scope\\with spaces",
      glob: "-*.ts",
      file_type: "ts",
      case_sensitive: true,
      fixed_strings: true,
      hidden: true,
      no_ignore: true,
      context: 500,
      limit: 50_000,
    }),
    [
      "--line-number",
      "--color=never",
      "--no-heading",
      "--with-filename",
      "--case-sensitive",
      "--fixed-strings",
      "--hidden",
      "--no-ignore",
      "--context",
      "20",
      "--glob",
      "-*.ts",
      "--type",
      "ts",
      "--max-count",
      "1000",
      "--",
      "--help Ω",
      "-scope\\with spaces",
    ],
  );
  assert.ok(buildRgArgs({ pattern: "x" }).includes("--smart-case"));
  assert.ok(
    buildRgArgs({ pattern: "x", case_sensitive: false }).includes(
      "--ignore-case",
    ),
  );
  assert.ok(
    buildRgArgs({ pattern: "x", context: -3, limit: -4 }).includes("0"),
  );
  assert.ok(buildRgArgs({ pattern: "x" }).includes(String(RG_DEFAULT_LIMIT)));
});

test("path normalization strips one @ and expands both home separators", () => {
  const home = join("C:\\", "Users", "Example User");
  assert.equal(normalizeSearchPath("@src\\é 空", home), "src\\é 空");
  assert.equal(normalizeSearchPath("@@literal", home), "@literal");
  assert.equal(normalizeSearchPath("-leading", home), "-leading");
  assert.equal(normalizeSearchPath("~/folder", home), join(home, "folder"));
  assert.equal(normalizeSearchPath("~\\folder", home), join(home, "folder"));
  assert.equal(normalizeSearchPath("~", home), home);
  assert.equal(
    normalizeSearchPath(" path with spaces ", home),
    " path with spaces ",
  );
});

// Binary resolution ----------------------------------------------------------

test("bundled Windows binaries are preferred over PATH and carry trusted versions", () => {
  const fakeHome = join("C:\\", "Users", "Fixture");
  const fdBundled = bundledBinaryPath("fd", fakeHome, "win32");
  const resolved = resolveSearchBinary("fd", {
    home: fakeHome,
    platform: "win32",
    path: `C:\\fallback${delimiter}C:\\other`,
    isUsableFile: (candidate) =>
      candidate === fdBundled || candidate.endsWith("fallback\\fd.exe"),
  });
  assert.deepEqual(resolved, {
    tool: "fd",
    command: fdBundled,
    source: "bundled",
    version: "10.4.2",
  });
});

test("PATH fallback and clear offline missing-binary errors need no probing process", () => {
  const resolved = resolveSearchBinary("rg", {
    home: "C:\\missing-home",
    platform: "win32",
    path: `C:\\first${delimiter}C:\\tools`,
    isUsableFile: (candidate) => candidate.endsWith("tools\\rg.exe"),
  });
  assert.equal(resolved.source, "path");
  assert.match(resolved.command, /tools\\rg\.exe$/);

  assert.throws(
    () =>
      resolveSearchBinary("rg", {
        home: "C:\\missing-home",
        platform: "win32",
        path: "",
        isUsableFile: () => false,
      }),
    /rg executable not found[\s\S]*PATH[\s\S]*No download was attempted/,
  );
});

test("the real trusted binaries are present at the expected Windows paths", () => {
  assert.equal(process.platform, "win32");
  assert.equal(existsSync(bundledBinaryPath("fd")), true);
  assert.equal(existsSync(bundledBinaryPath("rg")), true);
  assert.equal(resolveSearchBinary("fd").version, "10.4.2");
  assert.equal(resolveSearchBinary("rg").version, "15.1.0");
});

// Output shaping -------------------------------------------------------------

test("CRLF normalization gives stable content and logical line counts", async () => {
  assert.equal(normalizeSearchOutput("a\r\nb\r\n"), "a\nb");
  const formatted = await formatSearchOutput("a\r\nb\r\n", {
    tempPrefix: "pi-rg-",
  });
  assert.equal(formatted.text, "a\nb");
  assert.equal(formatted.lineCount, 2);
  assert.equal(formatted.byteCount, 3);
  assert.equal(formatted.truncated, false);
});

test("2,000-line and 50KB head thresholds produce accurate metadata", async () => {
  const atLines = Array.from({ length: DEFAULT_MAX_LINES }, () => "x").join(
    "\n",
  );
  assert.equal(
    (await formatSearchOutput(atLines, { tempPrefix: "pi-fd-" })).truncated,
    false,
  );

  const overLines = `${atLines}\nx`;
  let persisted = "";
  const byLines = await formatSearchOutput(overLines, {
    tempPrefix: "pi-fd-",
    persistFullOutput: async (output) => {
      persisted = output;
      return "C:\\private\\fd-output.txt";
    },
  });
  assert.equal(byLines.truncated, true);
  assert.equal(persisted, overLines);
  assert.deepEqual(byLines.truncation, {
    truncatedBy: "lines",
    totalLines: DEFAULT_MAX_LINES + 1,
    totalBytes: Buffer.byteLength(overLines),
    outputLines: DEFAULT_MAX_LINES,
    outputBytes: Buffer.byteLength(atLines),
  });
  assert.match(byLines.text, /2000 of 2001 lines/);

  const atBytes = "x".repeat(DEFAULT_MAX_BYTES);
  assert.equal(
    (await formatSearchOutput(atBytes, { tempPrefix: "pi-rg-" })).truncated,
    false,
  );
  const overBytes = await formatSearchOutput(`${atBytes}x`, {
    tempPrefix: "pi-rg-",
    persistFullOutput: async () => "C:\\private\\rg-output.txt",
  });
  assert.equal(overBytes.truncation?.truncatedBy, "bytes");
  assert.equal(overBytes.truncation?.totalLines, 1);
  assert.equal(overBytes.truncation?.outputLines, 0);
});

test("truncated output creates a private random temp artifact with normalized full output", async () => {
  const raw = `${Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, i) => `row-${i}`).join("\r\n")}\r\n`;
  const formatted = await formatSearchOutput(raw, { tempPrefix: "pi-rg-" });
  assert.equal(formatted.truncated, true);
  assert.ok(formatted.fullOutputPath);
  assert.match(dirname(formatted.fullOutputPath), /pi-rg-/);
  const artifact = await readFile(formatted.fullOutputPath, "utf8");
  assert.equal(artifact.includes("\r"), false);
  assert.equal(artifact.split("\n").length, DEFAULT_MAX_LINES + 1);
  assert.match(formatted.text, /Full output saved to:/);
  await rm(dirname(formatted.fullOutputPath), { recursive: true, force: true });
});

test("stderr failures are CRLF-normalized, sanitized, and bounded", () => {
  const hostile = `first\r\n\u001b]0;owned\u0007safe\r\n${Array.from({ length: 200 }, (_, i) => `error-${i}`).join("\r\n")}`;
  const bounded = boundedStderr(hostile);
  assert.match(bounded, /first\nsafe/);
  assert.doesNotMatch(bounded, /owned|\u001b|\r/);
  assert.match(bounded, /stderr truncated/);
  assert.ok(Buffer.byteLength(bounded) < 9 * 1024);
  assert.match(
    searchFailureMessage("rg", 2, hostile),
    /^rg failed \(exit 2\):/,
  );
});

// Captured tools and real Pi exec backend ------------------------------------

type CapturedTool = ToolDefinition<any, any, any>;

function createApi(options: { timeoutMs?: number } = {}) {
  const tools = new Map<string, CapturedTool>();
  const api = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    exec(command: string, args: string[], execOptions?: ExecOptions) {
      return execCommand(
        command,
        args,
        execOptions?.cwd ?? process.cwd(),
        execOptions,
      );
    },
  } as unknown as ExtensionAPI;
  fileSearchTools(api, options);
  return { api, tools };
}

function toolContext(cwd: string) {
  return { cwd } as ExtensionContext;
}

async function executeTool(
  tool: CapturedTool,
  params: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
) {
  return tool.execute("call-1", params, signal, undefined, toolContext(cwd));
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-file-search-test-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "-scope"));
  await writeFile(join(root, ".gitignore"), "ignored.ts\n");
  await writeFile(join(root, "visible.ts"), "Alpha needle\r\ncontext line\r\n");
  await writeFile(join(root, "sample.test.ts"), "test Needle\r\n");
  await writeFile(join(root, ".hidden.ts"), "hidden needle\r\n");
  await writeFile(join(root, "ignored.ts"), "ignored needle\r\n");
  await writeFile(join(root, "literal.txt"), "literal a+b value\r\n");
  await writeFile(join(root, "case.txt"), "Needle\r\nneedle\r\n");
  await writeFile(join(root, "unicodé 空.ts"), "unicode needle\r\n");
  await writeFile(
    join(root, "nested", "deep.js"),
    "before\r\ndeep needle\r\nafter\r\n",
  );
  await writeFile(join(root, "-scope", "dash.ts"), "dash needle\r\n");
  return root;
}

function textOf(result: AgentToolResult<unknown>) {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("real fd.exe covers hidden/ignored, types, extensions, globs, depth, Unicode, and dash paths", async () => {
  const root = await makeFixture();
  const { tools } = createApi();
  const fd = tools.get("fd");
  assert.ok(fd);
  try {
    const defaults = textOf(await executeTool(fd, { extension: "ts" }, root));
    assert.match(defaults, /visible\.ts/);
    assert.match(defaults, /unicodé 空\.ts/);
    assert.doesNotMatch(defaults, /\.hidden\.ts|ignored\.ts/);

    const special = textOf(
      await executeTool(
        fd,
        {
          pattern: "*.ts",
          glob: true,
          type: "file",
          hidden: true,
          no_ignore: true,
          max_depth: 1,
        },
        root,
      ),
    );
    assert.match(special, /\.hidden\.ts/);
    assert.match(special, /ignored\.ts/);
    assert.doesNotMatch(special, /dash\.ts/);

    const dashPath = textOf(
      await executeTool(fd, { extension: "ts", path: "-scope" }, root),
    );
    assert.match(dashPath, /dash\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real rg.exe covers regex/fixed/smart/forced case, globs, types, context, hidden and ignored", async () => {
  const root = await makeFixture();
  const { tools } = createApi();
  const rg = tools.get("rg");
  assert.ok(rg);
  try {
    const regex = textOf(
      await executeTool(rg, { pattern: "n[e]{2}dle", glob: "*.ts" }, root),
    );
    assert.match(regex, /visible\.ts/);
    assert.doesNotMatch(regex, /deep\.js/);
    assert.equal(regex.includes("\r"), false);

    const defaults = textOf(await executeTool(rg, { pattern: "needle" }, root));
    assert.doesNotMatch(defaults, /\.hidden\.ts|ignored\.ts/);

    const fixed = textOf(
      await executeTool(
        rg,
        { pattern: "a+b", fixed_strings: true, path: "literal.txt" },
        root,
      ),
    );
    assert.match(fixed, /literal a\+b value/);

    const smartUpper = textOf(
      await executeTool(rg, { pattern: "Needle", path: "case.txt" }, root),
    );
    assert.match(smartUpper, /Needle/);
    assert.doesNotMatch(smartUpper, /:2:needle$/m);
    const forcedInsensitive = textOf(
      await executeTool(
        rg,
        { pattern: "NEEDLE", path: "case.txt", case_sensitive: false },
        root,
      ),
    );
    assert.match(forcedInsensitive, /:1:Needle/);
    assert.match(forcedInsensitive, /:2:needle/);

    const typedContext = textOf(
      await executeTool(
        rg,
        { pattern: "deep needle", file_type: "js", context: 1 },
        root,
      ),
    );
    assert.match(typedContext, /before[\s\S]*deep needle[\s\S]*after/);

    const all = textOf(
      await executeTool(
        rg,
        { pattern: "needle", hidden: true, no_ignore: true },
        root,
      ),
    );
    assert.match(all, /\.hidden\.ts/);
    assert.match(all, /ignored\.ts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("broad rg output streams to a private artifact without buffering through pi.exec", async () => {
  const root = await makeFixture();
  const { tools } = createApi();
  try {
    const lines = Array.from({ length: 1_000 }, (_, index) => `needle-${index}`).join("\n");
    await Promise.all(
      ["many-a.txt", "many-b.txt", "many-c.txt"].map((name) =>
        writeFile(join(root, name), lines),
      ),
    );
    const result = await executeTool(
      tools.get("rg")!,
      { pattern: "needle", path: ".", limit: 1_000 },
      root,
    );
    const details = result.details as RgToolDetails;
    assert.equal(details.truncated, true);
    assert.ok(details.fullOutputPath);
    assert.ok(details.outputLines >= 3_000);
    const artifact = await readFile(details.fullOutputPath, "utf8");
    assert.match(artifact, /many-a\.txt/);
    assert.match(artifact, /many-c\.txt/);
    assert.match(textOf(result), /Full output saved to:/);
    await rm(dirname(details.fullOutputPath), { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rg exit 1 and fd empty output are successful no-match classifications", async () => {
  const root = await makeFixture();
  const { tools } = createApi();
  try {
    const rgResult = await executeTool(
      tools.get("rg")!,
      { pattern: "definitely absent" },
      root,
    );
    assert.equal(textOf(rgResult), "No matches found");
    assert.equal((rgResult.details as RgToolDetails).outputLines, 0);

    const fdResult = await executeTool(
      tools.get("fd")!,
      { pattern: "definitely-absent" },
      root,
    );
    assert.equal(textOf(fdResult), "No files found");
    assert.equal((fdResult.details as FdToolDetails).matchCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real rg nonzero failures surface only bounded stderr", async () => {
  const root = await makeFixture();
  const { tools } = createApi();
  try {
    await assert.rejects(
      executeTool(tools.get("rg")!, { pattern: "[" }, root),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "";
        assert.match(message, /rg failed \(exit 2\)/);
        assert.ok(Buffer.byteLength(message) < 9 * 1024);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real rg execution honors cancellation and Pi exec timeout", async () => {
  const root = await makeFixture();
  await writeFile(join(root, "large.txt"), "x".repeat(32 * 1024 * 1024));
  try {
    const cancellable = createApi().tools.get("rg")!;
    const controller = new AbortController();
    const pending = executeTool(
      cancellable,
      { pattern: "not-present-in-large-file", path: "large.txt" },
      root,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 1);
    await assert.rejects(pending, /cancelled/);

    const timed = createApi({ timeoutMs: 1 }).tools.get("rg")!;
    await assert.rejects(
      executeTool(
        timed,
        { pattern: "not-present-in-large-file", path: "large.txt" },
        root,
      ),
      /timed out after 1 ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Renderer boundaries --------------------------------------------------------

initTheme("dark");
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function renderContext(args: Record<string, unknown>, expanded = false) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: false,
    isError: false,
  };
}

function render(component: Component, width: number) {
  const lines = component.render(width);
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
  return { lines, text: lines.join("\n") };
}

test("collapsed fd/rg renderers retain pattern, path, and useful flags within width", () => {
  const { tools } = createApi();
  const cases = [
    {
      name: "fd",
      args: {
        pattern: "*.test.ts",
        path: "src files",
        type: "file",
        extension: "ts",
        glob: true,
        max_depth: 3,
      },
      expected: [/\*\.test\.ts/, /src files/, /ext=ts/, /glob/, /depth=3/],
    },
    {
      name: "rg",
      args: {
        pattern: "TODO\\(important\\)",
        path: "src files",
        glob: "*.ts",
        file_type: "ts",
        fixed_strings: true,
        context: 2,
      },
      expected: [
        /TODO/,
        /src files/,
        /glob=\*\.ts/,
        /type=ts/,
        /fixed/,
        /ctx=2/,
      ],
    },
  ];

  for (const item of cases) {
    const tool = tools.get(item.name)!;
    const component = tool.renderCall!(
      { pattern: "decoy" },
      theme,
      renderContext(item.args),
    );
    const output = render(component, 110).text;
    assert.doesNotMatch(output, /decoy/);
    for (const expected of item.expected) assert.match(output, expected);
  }
});

test("collapsed result rows keep search identity, status, and flags at narrow widths", () => {
  const rg = createApi().tools.get("rg")!;
  const args = {
    pattern: "TODO",
    path: "src files",
    fixed_strings: true,
    glob: "*.ts",
    context: 2,
  };
  const result = {
    content: [{ type: "text", text: "src.ts:1:TODO" }],
    details: {
      binarySource: "bundled",
      outputLines: 1,
      truncated: false,
    } satisfies RgToolDetails,
  } as AgentToolResult<unknown>;
  const output = render(
    rg.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      renderContext(args),
    ),
    72,
  ).text;
  assert.match(output, /TODO/);
  assert.match(output, /src files/);
  assert.match(output, /1 output line/);
  assert.match(output, /smart/);
  assert.match(output, /fixed/);
});

test("expanded previews are sanitized, line-bounded, byte-bounded, and width-safe", () => {
  const { tools } = createApi();
  const args = { pattern: "needle", path: "src" };
  const hostile = `\u001b]0;owned\u0007\u001b[31mred\u001b[0m\n${Array.from({ length: 100 }, (_, i) => `${i}-${"x".repeat(1_000)}`).join("\n")}`;
  for (const name of ["fd", "rg"] as const) {
    const tool = tools.get(name)!;
    const details =
      name === "fd"
        ? ({
            binarySource: "bundled",
            matchCount: 100,
            truncated: true,
          } satisfies FdToolDetails)
        : ({
            binarySource: "bundled",
            outputLines: 100,
            truncated: true,
          } satisfies RgToolDetails);
    const result = {
      content: [{ type: "text", text: hostile }],
      details,
    } as AgentToolResult<unknown>;
    const output = render(
      tool.renderResult!(
        result,
        { expanded: true, isPartial: false },
        theme,
        renderContext(args, true),
      ),
      72,
    );
    assert.ok(output.lines.length <= 22);
    assert.doesNotMatch(output.text, /owned|\u0007|\u001b\]0|\u001b\[31m/);
    assert.match(output.text, /red/);
    assert.match(output.text, /preview limited/);
    assert.ok(Buffer.byteLength(output.text) < 10 * 1024);
  }
});

// Scope/trust boundaries -----------------------------------------------------

test("file-search stays dependency-free, offline, and does not alter stock tools", async () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourceNames = [
    "index.ts",
    "args.ts",
    "binaries.ts",
    "output.ts",
    "prompt.ts",
  ];
  const source = (
    await Promise.all(
      sourceNames.map((name) => readFile(join(directory, name), "utf8")),
    )
  ).join("\n");
  const packageJson = JSON.parse(
    await readFile(join(directory, "..", "..", "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.doesNotMatch(source, /from ["']effect|@effect|vitest|https?:\/\//i);
  assert.match(source, /from ["']node:child_process["']/);
  assert.doesNotMatch(source, /pi\.exec\(/);
  assert.doesNotMatch(
    source,
    /setActiveTools|registerTool\(\{\s*name: ["'](?:grep|find|ls)["']/,
  );
  assert.equal(packageJson.dependencies?.effect, undefined);
  assert.equal(packageJson.devDependencies?.vitest, undefined);
  assert.equal(existsSync(join(directory, "package-lock.json")), false);
  assert.match(FD_PROMPT_GUIDELINES.join(" "), /stock find and ls/);
  assert.match(RG_PROMPT_GUIDELINES.join(" "), /stock grep/);
});
