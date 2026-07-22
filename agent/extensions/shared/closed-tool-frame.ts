import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

export type ToolFrameStatus = "pending" | "success" | "error";

export function toolFrameStatus(context: {
  isError?: boolean;
  isPartial?: boolean;
}): ToolFrameStatus {
  if (context.isError) return "error";
  if (context.isPartial) return "pending";
  return "success";
}

function borderColor(status: ToolFrameStatus) {
  return status === "pending"
    ? ("warning" as const)
    : status === "error"
      ? ("error" as const)
      : ("success" as const);
}

function fitLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, Math.max(0, width), "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/** Closed, rounded title section for a self-rendered tool shell. */
export function closedToolFrameTop(
  title: string,
  status: ToolFrameStatus,
  theme: Theme,
  body: readonly string[] = [],
): Component {
  return {
    invalidate() {},
    render(width: number) {
      if (width < 2) return [theme.fg(borderColor(status), "╭")];
      const border = (text: string) => theme.fg(borderColor(status), text);
      const innerWidth = width - 2;
      const label = truncateToWidth(
        ` ${title} `,
        Math.max(0, innerWidth - 1),
        "…",
      );
      const fill = "─".repeat(
        Math.max(0, innerWidth - 1 - visibleWidth(label)),
      );
      const lines = [border("╭─") + label + border(`${fill}╮`)];
      for (const row of body) {
        lines.push(border("│") + fitLine(row, innerWidth) + border("│"));
      }
      return lines;
    },
  };
}

/** Closed body and bottom section paired with closedToolFrameTop(). */
export function closedToolFrameResult(
  component: Component,
  status: ToolFrameStatus,
  theme: Theme,
  bottomLabel?: string,
): Component {
  return {
    invalidate() {
      component.invalidate();
    },
    render(width: number) {
      if (width < 2) return [theme.fg(borderColor(status), "╰")];
      const border = (text: string) => theme.fg(borderColor(status), text);
      const innerWidth = width - 2;
      const body = component
        .render(innerWidth)
        .map((line) => border("│") + fitLine(line, innerWidth) + border("│"));

      if (!bottomLabel) {
        body.push(border(`╰${"─".repeat(innerWidth)}╯`));
        return body;
      }

      const label = truncateToWidth(
        ` ${bottomLabel} `,
        Math.max(0, innerWidth - 2),
        "…",
      );
      const fill = "─".repeat(
        Math.max(0, innerWidth - 2 - visibleWidth(label)),
      );
      body.push(border("╰─") + label + border(`${fill}─╯`));
      return body;
    },
  };
}

export function closedToolFrame(
  title: string,
  component: Component,
  status: ToolFrameStatus,
  theme: Theme,
  bottomLabel?: string,
): Component {
  const top = closedToolFrameTop(title, status, theme);
  const result = closedToolFrameResult(component, status, theme, bottomLabel);
  return {
    invalidate() {
      top.invalidate();
      result.invalidate();
    },
    render(width: number) {
      return [...top.render(width), ...result.render(width)];
    },
  };
}

export function closedToolFrameText(
  text: string,
  status: ToolFrameStatus,
  theme: Theme,
  bottomLabel?: string,
): Component {
  return closedToolFrameResult(
    new Text(text, 0, 0),
    status,
    theme,
    bottomLabel,
  );
}
