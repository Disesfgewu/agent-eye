"""Agent Eye — give AI agents eyes and hands in the browser.

Programmatic API for Python AI agents to drive a real browser and manage dev
servers, with server-side permission enforcement. See the AgentEye class.
"""
from .browser import AgentEye
from .policy import Policy, PermissionGate, PolicyError

__all__ = ["AgentEye", "Policy", "PermissionGate", "PolicyError"]
__version__ = "0.1.0"
