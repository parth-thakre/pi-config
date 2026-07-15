import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fold delegated child-agent spend into the next parent assistant message.
 * Pi's built-in footer calculates session cost from assistant-message usage,
 * so this keeps its existing $ total accurate without replacing the footer.
 */
export function createDelegatedCostAccounting(pi: ExtensionAPI) {
  let pendingCost = 0;

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || pendingCost <= 0) return;

    const delegatedCost = pendingCost;
    pendingCost = 0;
    const usage = event.message.usage;
    return {
      message: {
        ...event.message,
        usage: {
          ...usage,
          cost: {
            ...usage.cost,
            total: usage.cost.total + delegatedCost,
          },
        },
      },
    };
  });

  pi.on("session_shutdown", () => {
    pendingCost = 0;
  });

  return {
    add(cost: number) {
      if (Number.isFinite(cost) && cost > 0) pendingCost += cost;
    },
  };
}
