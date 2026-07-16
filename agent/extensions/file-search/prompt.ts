export const FD_TOOL_DESCRIPTION =
  "Find files and directories by name with fd. Supports types, extensions, glob mode, hidden/ignored files, depth, and result limits. Uses the trusted ~/.pi/agent/bin/fd.exe when present, then PATH. Output is head-truncated at 2,000 lines or 50KB with full truncated output in a private temp artifact.";

export const FD_PROMPT_SNIPPET =
  "Find files by name with fd when fd-specific filters are useful";

export const FD_PROMPT_GUIDELINES = [
  "Use fd when its type, extension, glob, hidden/ignored, depth, or result-limit options are useful; keep using stock find and ls for ordinary discovery.",
  "Use rg rather than fd for file-content searches, and keep stock grep active for simple searches.",
];

export const RG_TOOL_DESCRIPTION =
  "Search file contents with ripgrep. Supports regex or fixed strings, smart/forced case, globs, file types, context, hidden/ignored files, and per-file limits. Uses the trusted ~/.pi/agent/bin/rg.exe when present, then PATH. Output is head-truncated at 2,000 lines or 50KB with full truncated output in a private temp artifact.";

export const RG_PROMPT_SNIPPET =
  "Search file contents with rg when ripgrep-specific options are useful";

export const RG_PROMPT_GUIDELINES = [
  "Use rg when its regex/fixed-string, smart-case, glob, file-type, context, hidden/ignored, or per-file limit options are useful; keep using stock grep for simple content searches.",
  "Use fd rather than rg for file-name searches, and keep stock find and ls active for ordinary discovery.",
];

export const FD_PARAMETER_DESCRIPTIONS = {
  pattern:
    "Name regex, or a glob when glob is true. Omit to list all entries under path.",
  path: "Directory to search; defaults to the current working directory.",
  type: "Return only files, directories, or symlinks.",
  extension: "Return only files with this extension, such as ts or .md.",
  glob: "Treat pattern as a glob rather than a regular expression.",
  hidden: "Include hidden entries.",
  no_ignore: "Include entries excluded by .gitignore and other ignore files.",
  max_depth: "Maximum traversal depth (1-64).",
  limit: "Maximum results (1-10000); defaults to 1000.",
} as const;

export const RG_PARAMETER_DESCRIPTIONS = {
  pattern: "Regular expression, or literal text when fixed_strings is true.",
  path: "File or directory to search; defaults to the current working directory.",
  glob: "Only search paths matching this ripgrep glob.",
  file_type: "Only search a ripgrep file type such as ts, js, py, or rust.",
  case_sensitive:
    "true forces case-sensitive, false forces case-insensitive; omitted uses smart-case.",
  fixed_strings:
    "Treat pattern as literal text instead of a regular expression.",
  hidden: "Search hidden files and directories.",
  no_ignore: "Search files excluded by .gitignore and other ignore files.",
  context: "Context lines around matches (0-20).",
  limit: "Maximum matches per file (1-1000); defaults to 100.",
} as const;
