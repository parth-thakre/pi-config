import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDelegatedCostAccounting } from "./delegated-cost.ts";

function assistant(cost: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("delegated cost is folded into exactly one parent assistant message", () => {
  const handlers = new Map<string, Array<(event: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;

  const accounting = createDelegatedCostAccounting(pi);
  accounting.add(0.12);
  accounting.add(0.03);

  const onMessage = handlers.get("message_end")![0];
  const first = onMessage({ message: assistant(0.01) });
  assert.equal(first.message.usage.cost.total, 0.16);
  assert.equal(onMessage({ message: assistant(0.02) }), undefined);
});

test("invalid, zero, and shutdown-cleared delegated costs are ignored", () => {
  const handlers = new Map<string, Array<(event: any) => any>>();
  const pi = {
    on(name: string, handler: (event: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;

  const accounting = createDelegatedCostAccounting(pi);
  accounting.add(0);
  accounting.add(Number.NaN);
  accounting.add(0.5);
  handlers.get("session_shutdown")![0]({});

  const result = handlers.get("message_end")![0]({ message: assistant(0.01) });
  assert.equal(result, undefined);
});
