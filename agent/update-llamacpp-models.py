import json
import urllib.request
from pathlib import Path

BASE_URL = "http://loq:8085/v1"
CONFIG = Path.home() / ".pi" / "agent" / "models.json"

with urllib.request.urlopen(f"{BASE_URL}/models", timeout=5) as r:
    payload = json.load(r)

models = []
for m in payload.get("data", payload.get("models", [])):
    mid = m.get("id") or m.get("model") or m.get("name")
    meta = m.get("meta", {}) or {}
    ctx = meta.get("n_ctx") or meta.get("n_ctx_train")
    if not mid:
        continue
    model = {
        "id": mid,
        "name": f"{mid} (llama.cpp @ loq:8085)",
        "reasoning": False,
        "input": ["text"],
        "maxTokens": 8192,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    }
    if ctx:
        model["contextWindow"] = int(ctx)
    models.append(model)

config = {
    "providers": {
        "llama.cpp": {
            "baseUrl": BASE_URL,
            "api": "openai-completions",
            "apiKey": "llama.cpp",
            "compat": {
                "supportsDeveloperRole": False,
                "supportsReasoningEffort": False,
                "maxTokensField": "max_tokens"
            },
            "models": models
        }
    }
}

CONFIG.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(models)} llama.cpp model(s) to {CONFIG}")
for m in models:
    print(f"- {m['id']}: contextWindow={m.get('contextWindow', 'default')}")
