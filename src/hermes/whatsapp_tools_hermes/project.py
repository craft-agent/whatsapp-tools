"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "whatsapp-tools"

#: The built command-line name used in error and log messages.
CLI_NAME = "whatsapp-tools-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "whatsapp-"

#: The emoji each toolset is shown with.
TOOLSET_EMOJI: dict[str, str] = {
    "account": "🪪",
    "chats": "💬",
    "contacts": "📇",
    "history": "📜",
    "files": "📎",
    "sends": "📤",
    "actions": "🔧",
}

#: How long one call of a tool may take, in seconds, for a tool that may take longer than the default.
#: ``whatsapp_history_backfill`` waits up to 300 seconds for the phone, so it gets a margin above that;
#: ``whatsapp_file_save`` may wait 150 seconds for WhatsApp's server and then 150 for the phone;
#: ``whatsapp_file_send`` ends within 280 seconds however many files it sends, and gets the same margin.
TOOL_TIMEOUT_SECONDS: dict[str, float] = {
    "whatsapp_history_backfill": 330,
    "whatsapp_file_save": 330,
    "whatsapp_file_send": 330,
}

__all__ = [
    "CLI_NAME",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
    "TOOL_TIMEOUT_SECONDS",
]
