"""The plugin's settings, turned into the flags of the command line."""

from __future__ import annotations

from typing import Any

from .context import PluginContext

#: The value of ``toolsets`` that turns on every toolset.
ALL_TOOLSETS = "all"


class SettingsError(ValueError):
    """A setting has a value of the wrong type."""


def _names(key: str, value: Any) -> str | None:
    """A list of names as the comma-separated text a flag takes; ``None`` for no names."""
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise SettingsError(f'setting "{key}" must be a list of names')
    return ",".join(value) or None


def _directory_flags(ctx: PluginContext, key: str, flag: str) -> list[str]:
    """Read the directory setting ``key`` and return ``[flag, value]``, or ``[]`` when absent.

    Raises:
        SettingsError: the setting is present but not a non-empty string.
    """
    value = ctx.get_config(key)
    if value is None:
        return []
    if not isinstance(value, str) or not value.strip():
        raise SettingsError(f'setting "{key}" must be a path')
    return [flag, value]


def state_dir_flags(ctx: PluginContext) -> list[str]:
    """Read ``state_dir`` and return ``["--state-dir", value]``, or ``[]`` when absent.

    Raises:
        SettingsError: the setting is present but not a non-empty string.
    """
    return _directory_flags(ctx, "state_dir", "--state-dir")


def download_dir_flags(ctx: PluginContext) -> list[str]:
    """Read ``download_dir`` and return ``["--download-dir", value]``, or ``[]`` when absent.

    Raises:
        SettingsError: the setting is present but not a non-empty string.
    """
    return _directory_flags(ctx, "download_dir", "--download-dir")


def directory_flags(ctx: PluginContext) -> list[str]:
    """The flags of the directory settings, which is all the ``target`` command takes."""
    return state_dir_flags(ctx) + download_dir_flags(ctx)


def settings_flags(ctx: PluginContext) -> list[str]:
    """Read the plugin's settings and return the flags that say the same.

    A setting that is absent gives no flag, so the command line's own defaults
    (and ``WHATSAPP_TOOLS_*`` variables) apply. A wrong type is refused rather
    than ignored, since ignoring ``read_only`` would loosen what the person asked for.

    Raises:
        SettingsError: a setting has a value of the wrong type.
    """
    flags: list[str] = []

    toolsets = ctx.get_config("toolsets")
    if toolsets == ALL_TOOLSETS:
        flags += ["--toolsets", ALL_TOOLSETS]
    elif toolsets is not None and (names := _names("toolsets", toolsets)):
        flags += ["--toolsets", names]

    read_only = ctx.get_config("read_only")
    if read_only is not None and not isinstance(read_only, bool):
        raise SettingsError('setting "read_only" must be true or false')
    if read_only:
        flags.append("--read-only")

    for key, flag in (("tools", "--tools"), ("exclude_tools", "--exclude-tools")):
        value = ctx.get_config(key)
        if value is not None and (names := _names(key, value)):
            flags += [flag, names]

    flags += state_dir_flags(ctx)
    flags += download_dir_flags(ctx)

    return flags
