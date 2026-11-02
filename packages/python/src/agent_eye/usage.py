"""Token usage ledger (port of usage/estimate.ts + usage/ledger.ts, Issue #1).

Token estimation without a tokenizer dependency. These are ESTIMATES meant for relative comparison (did this
change make output cheaper?), not billing:

* ASCII text: ~4 chars per token (override: AGENT_EYE_CHARS_PER_TOKEN).
* Non-ASCII (CJK, emoji, ...): ~1 token per code point; a 4-chars/token rule badly under-counts these.
* Images: Anthropic's published rule of thumb, tokens ~ width*height/750, long edge downscaled to 1568px.

The estimators are checked against golden cases computed from the TypeScript reference
(packages/mcp-server/tests/fixtures/usage-cases.json).
"""
from __future__ import annotations

import base64
import functools
import json
import math
import os
import struct
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

DEFAULT_CHARS_PER_TOKEN = 4
MAX_IMAGE_TOKENS = 1600
MAX_LONG_EDGE = 1568
HISTORY_MAX_LINES = 200


def _chars_per_token() -> float:
    try:
        v = float(os.environ.get("AGENT_EYE_CHARS_PER_TOKEN", ""))
    except ValueError:
        return DEFAULT_CHARS_PER_TOKEN
    return v if v > 0 and math.isfinite(v) else DEFAULT_CHARS_PER_TOKEN


def estimate_text_tokens(text: str) -> int:
    if not text:
        return 0
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    wide = len(text) - ascii_chars
    return math.ceil(ascii_chars / _chars_per_token()) + wide


def image_size(buf: bytes) -> Optional[Tuple[int, int]]:
    """(width, height) of a PNG or JPEG buffer; None if unrecognised."""
    if len(buf) >= 24 and struct.unpack(">I", buf[0:4])[0] == 0x89504E47:
        return struct.unpack(">I", buf[16:20])[0], struct.unpack(">I", buf[20:24])[0]
    if len(buf) >= 4 and buf[0] == 0xFF and buf[1] == 0xD8:
        i = 2
        while i + 9 < len(buf):
            if buf[i] != 0xFF:
                i += 1
                continue
            marker = buf[i + 1]
            if marker == 0xD8 or 0xD0 <= marker <= 0xD7 or marker == 0x01:
                i += 2
                continue
            length = struct.unpack(">H", buf[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height = struct.unpack(">H", buf[i + 5:i + 7])[0]
                width = struct.unpack(">H", buf[i + 7:i + 9])[0]
                return width, height
            i += 2 + length
    return None


def estimate_image_tokens(base64_data: str) -> int:
    try:
        size = image_size(base64.b64decode(base64_data or "", validate=False))
    except Exception:
        size = None
    if not size or size[0] <= 0 or size[1] <= 0:
        return MAX_IMAGE_TOKENS
    scale = min(1.0, MAX_LONG_EDGE / max(size))
    return min(math.ceil((size[0] * scale * size[1] * scale) / 750), MAX_IMAGE_TOKENS)


def estimate_result_tokens(content: Optional[List[Dict[str, Any]]]) -> int:
    """Estimated tokens of an MCP tool result's content blocks."""
    total = 0
    for block in content or []:
        if block.get("type") == "text" and block.get("text"):
            total += estimate_text_tokens(block["text"])
        elif block.get("type") == "image" and block.get("data"):
            total += estimate_image_tokens(block["data"])
    return total


def estimate_tool_definition_tokens(name: str, description: str, input_schema: Dict[str, Any]) -> int:
    """Rough serialized size of one tool definition as an MCP client sends it to the model."""
    return estimate_text_tokens(json.dumps({"name": name, "description": description or "", "inputSchema": input_schema}, separators=(",", ":")))


class UsageLedger:
    """Per-session token ledger. State is persisted to <artifacts_dir>/usage.json (current session) and, on flush at
    shutdown, appended to usage-history.jsonl (bounded) so runs can be compared. All figures are estimates."""

    def __init__(self, artifacts_dir: Optional[str] = None):
        self.artifacts_dir = artifacts_dir
        self.session_id = f"{int(time.time() * 1000):x}-{os.getpid()}"
        self.started_at = datetime.now(timezone.utc).isoformat()
        self._tools: Dict[str, Dict[str, int]] = {}
        self.tool_definition_tokens = 0
        self.tool_count = 0
        self._lock = threading.Lock()

    def set_tool_definition_overhead(self, tokens: int, count: int) -> None:
        self.tool_definition_tokens, self.tool_count = tokens, count

    def record(self, tool: str, in_tokens: int, out_tokens: int, ms: float, ok: bool) -> None:
        with self._lock:
            u = self._tools.setdefault(tool, {"calls": 0, "errors": 0, "inTokens": 0, "outTokens": 0, "maxOutTokens": 0, "totalMs": 0})
            u["calls"] += 1
            u["errors"] += 0 if ok else 1
            u["inTokens"] += in_tokens
            u["outTokens"] += out_tokens
            u["maxOutTokens"] = max(u["maxOutTokens"], out_tokens)
            u["totalMs"] += int(ms)

    def summary(self) -> Dict[str, Any]:
        with self._lock:
            tools = {k: dict(v) for k, v in self._tools.items()}
        totals = {"calls": 0, "errors": 0, "inTokens": 0, "outTokens": 0}
        for u in tools.values():
            for k in totals:
                totals[k] += u[k]
        return {
            "sessionId": self.session_id, "startedAt": self.started_at, "updatedAt": datetime.now(timezone.utc).isoformat(),
            "toolDefinitionTokens": self.tool_definition_tokens, "toolCount": self.tool_count, "totals": totals, "tools": tools,
        }

    def report(self) -> str:
        """Compact human/agent-readable report (kept small: it is itself tool output)."""
        s = self.summary()
        n = lambda v: f"{v:,}"  # noqa: E731
        t = s["totals"]
        lines = [
            f"Agent Eye token usage (estimates) — session {s['sessionId']}",
            f"Tool definitions (fixed per session): ~{n(s['toolDefinitionTokens'])} tokens, {s['toolCount']} tools",
            f"Calls: {t['calls']} ({t['errors']} errors) | tool args in: ~{n(t['inTokens'])} | results out: ~{n(t['outTokens'])}",
            f"Total added to context ≈ {n(s['toolDefinitionTokens'] + t['inTokens'] + t['outTokens'])} tokens",
        ]
        rows = sorted(s["tools"].items(), key=lambda kv: kv[1]["outTokens"], reverse=True)
        if rows:
            lines += ["", "tool | calls | out | avg out | max out | err"]
            for name, u in rows:
                lines.append(f"{name} | {u['calls']} | {n(u['outTokens'])} | {n(round(u['outTokens'] / u['calls']))} | {n(u['maxOutTokens'])} | {u['errors']}")
        return "\n".join(lines)

    def flush(self) -> None:
        """Writes usage.json and appends one summary line to usage-history.jsonl (bounded)."""
        s = self.summary()
        if s["totals"]["calls"] == 0 or not self.artifacts_dir:
            return
        try:
            os.makedirs(self.artifacts_dir, exist_ok=True)
            with open(os.path.join(self.artifacts_dir, "usage.json"), "w", encoding="utf-8") as f:
                json.dump(s, f, indent=2)
            history = os.path.join(self.artifacts_dir, "usage-history.jsonl")
            with open(history, "a", encoding="utf-8") as f:
                f.write(json.dumps(s) + "\n")
            with open(history, encoding="utf-8") as f:
                lines = [ln for ln in f.read().split("\n") if ln]
            if len(lines) > HISTORY_MAX_LINES:
                with open(history, "w", encoding="utf-8") as f:
                    f.write("\n".join(lines[-HISTORY_MAX_LINES:]) + "\n")
        except OSError:
            pass  # measurement only: never affect a tool call


def measured(ledger: UsageLedger, name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
    """Wraps a tool function so each call is measured by the ledger. Purely observational: arguments and result pass
    through untouched and measurement failures never affect a call. Errors reported as text ("[policy] ...",
    "[error] ...") count as errors."""
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        started = time.time()
        try:
            in_tokens = estimate_text_tokens(json.dumps(kwargs or list(args), default=str))
        except Exception:
            in_tokens = 0
        try:
            result = fn(*args, **kwargs)
        except Exception:
            ledger.record(name, in_tokens, 0, (time.time() - started) * 1000, False)
            raise
        try:
            text = result if isinstance(result, str) else json.dumps(result, default=str)
            out = estimate_text_tokens(text)
            ok = not (isinstance(result, str) and result.startswith(("[policy]", "[error]")))
        except Exception:
            out, ok = 0, True
        ledger.record(name, in_tokens, out, (time.time() - started) * 1000, ok)
        return result
    return wrapper
