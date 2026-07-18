"""Permission policy + gate (plan 7.1), mirroring the TypeScript server.

Enforcement lives here, not in prompts: a manipulated agent still cannot exceed
these decisions. `ask` actions consult an `on_approve(title, detail) -> bool`
callback (the Python analogue of MCP elicitation); with no callback they
fail safe (deny).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Callable, Optional

DEFAULT_CATEGORIES = {
    "observe": "allow",
    "interact": "allow",
    "sideEffect": "ask",
    "execute": "ask",
    "highRisk": "deny",
}

DEFAULT_NAV_ALLOWLIST = ["localhost", "127.0.0.1", "::1"]

DEFAULT_CMD_ALLOWLIST = [
    "npm", "pnpm", "yarn", "bun", "node", "npx", "deno",
    "vite", "next", "nuxt", "ng", "webpack", "rollup", "parcel", "astro",
    "remix", "svelte-kit", "gatsby", "expo", "quasar", "ionic", "storybook",
    "react-scripts", "vue-cli-service", "turbo",
    "flutter", "dart",
    "python", "python3", "py", "uvicorn", "flask", "django-admin", "manage.py",
    "php", "ruby", "bundle", "rails", "jekyll", "hugo",
    "http-server", "serve", "live-server", "static-server", "wrangler",
]


class PolicyError(Exception):
    """Raised when an action is blocked by policy. Callers should treat this as a
    permission boundary, not a transient failure — do not blindly retry."""


@dataclass
class Policy:
    categories: dict = field(default_factory=lambda: dict(DEFAULT_CATEGORIES))
    navigation_allowlist: list = field(default_factory=lambda: list(DEFAULT_NAV_ALLOWLIST))
    command_allowlist: list = field(default_factory=lambda: list(DEFAULT_CMD_ALLOWLIST))
    redact_sensitive_headers: bool = True

    @classmethod
    def load(cls, path: str) -> "Policy":
        p = cls()
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                p.categories = {**DEFAULT_CATEGORIES, **raw.get("categories", {})}
                p.navigation_allowlist = raw.get("navigationAllowlist", p.navigation_allowlist)
                p.command_allowlist = raw.get("commandAllowlist", p.command_allowlist)
                p.redact_sensitive_headers = raw.get("redactSensitiveHeaders", True)
            else:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(p.to_json(), f, indent=2)
        except Exception:
            p = cls()
        return p

    def to_json(self) -> dict:
        return {
            "version": 1,
            "categories": self.categories,
            "navigationAllowlist": self.navigation_allowlist,
            "commandAllowlist": self.command_allowlist,
            "redactSensitiveHeaders": self.redact_sensitive_headers,
        }


class PermissionGate:
    def __init__(self, policy: Policy, on_approve: Optional[Callable[[str, str], bool]] = None):
        self.policy = policy
        self.on_approve = on_approve
        self._session_approved = set()

    def check(self, category: str, title: str, detail: str = "", remember: bool = False) -> None:
        decision = self.policy.categories.get(category, "deny")
        if decision == "ask" and category in self._session_approved:
            return
        if decision == "deny":
            raise PolicyError(
                f'Permission denied by policy: this action is in the "{category}" category, '
                f'which is set to "deny". This is a permission boundary, not a failure. '
                f"Enable it in the policy to permit it."
            )
        if decision == "ask":
            approved = bool(self.on_approve(title, detail)) if self.on_approve else False
            if approved:
                if remember:
                    self._session_approved.add(category)
                return
            raise PolicyError(
                f'This action requires approval (category "{category}" is "ask") and it was not '
                f"granted. Provide an on_approve callback, or set the category to \"allow\" in the policy."
            )
        # allow
        return
