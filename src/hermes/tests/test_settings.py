"""Tests of the settings the plugin turns into command-line flags."""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

from support import StubContext, project, settings


class SettingsFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_no_setting_gives_no_flag(self) -> None:
        self.assertEqual(self.flags(), [])

    def test_each_setting_becomes_its_flag(self) -> None:
        self.assertEqual(
            self.flags(
                toolsets=["things", "widgets"],
                read_only=True,
                tools=["demo_thing_read"],
                exclude_tools=["demo_widget_update", "demo_gadget_edit"],
            ),
            [
                "--toolsets",
                "things,widgets",
                "--read-only",
                "--tools",
                "demo_thing_read",
                "--exclude-tools",
                "demo_widget_update,demo_gadget_edit",
            ],
        )

    def test_all_toolsets_as_text_or_as_a_list(self) -> None:
        self.assertEqual(self.flags(toolsets="all"), ["--toolsets", "all"])
        self.assertEqual(self.flags(toolsets=["all"]), ["--toolsets", "all"])

    def test_false_and_empty_settings_give_no_flag(self) -> None:
        self.assertEqual(self.flags(toolsets=[], read_only=False, tools=[], exclude_tools=[]), [])

    def test_state_dir_flag(self) -> None:
        self.assertEqual(
            settings.state_dir_flags(StubContext({"state_dir": "/custom/path"})), ["--state-dir", "/custom/path"]
        )
        self.assertEqual(settings.state_dir_flags(StubContext({})), [])

    def test_state_dir_included_in_settings_flags(self) -> None:
        self.assertEqual(self.flags(state_dir="/custom/path"), ["--state-dir", "/custom/path"])

    def test_invalid_state_dir_refused(self) -> None:
        for value in (123, True, "", "   ", []):
            with self.subTest(value=value), self.assertRaises(settings.SettingsError):
                settings.state_dir_flags(StubContext({"state_dir": value}))

    def test_download_dir_flag(self) -> None:
        self.assertEqual(
            settings.download_dir_flags(StubContext({"download_dir": "/custom/files"})),
            ["--download-dir", "/custom/files"],
        )
        self.assertEqual(settings.download_dir_flags(StubContext({})), [])

    def test_download_dir_included_in_settings_flags(self) -> None:
        self.assertEqual(
            self.flags(state_dir="/custom/path", download_dir="/custom/files"),
            ["--state-dir", "/custom/path", "--download-dir", "/custom/files"],
        )

    def test_directory_flags_are_only_the_directories(self) -> None:
        ctx = StubContext({"state_dir": "/custom/path", "download_dir": "/custom/files", "read_only": True})
        self.assertEqual(
            settings.directory_flags(ctx), ["--state-dir", "/custom/path", "--download-dir", "/custom/files"]
        )
        self.assertEqual(settings.directory_flags(StubContext({"read_only": True})), [])

    def test_invalid_download_dir_refused(self) -> None:
        for value in (123, True, "", "   ", []):
            with self.subTest(value=value), self.assertRaises(settings.SettingsError):
                settings.download_dir_flags(StubContext({"download_dir": value}))

    def test_send_dirs_flag_joins_the_list(self) -> None:
        self.assertEqual(
            settings.send_dirs_flags(StubContext({"send_dirs": ["/a", "~/b"]})), ["--send-dirs", "/a,~/b"]
        )
        self.assertEqual(settings.send_dirs_flags(StubContext({})), [])
        self.assertEqual(settings.send_dirs_flags(StubContext({"send_dirs": []})), [])

    def test_send_dirs_follow_the_other_directories(self) -> None:
        self.assertEqual(
            self.flags(state_dir="/s", download_dir="/d", send_dirs=["/a", "/b"]),
            ["--state-dir", "/s", "--download-dir", "/d", "--send-dirs", "/a,/b"],
        )
        self.assertEqual(
            settings.directory_flags(StubContext({"send_dirs": ["/a"], "read_only": True})), ["--send-dirs", "/a"]
        )

    def test_invalid_send_dirs_refused(self) -> None:
        for value in ("/a,/b", 123, True, "", ["/a", 1], ["/a", ""], ["  "], ["/a,/b"]):
            with self.subTest(value=value), self.assertRaises(settings.SettingsError):
                settings.send_dirs_flags(StubContext({"send_dirs": value}))

    def test_a_wrong_type_is_refused(self) -> None:
        for config in (
            {"toolsets": "things"},
            {"toolsets": 3},
            {"read_only": "true"},
            {"tools": "demo_thing_read"},
            {"exclude_tools": [1]},
            {"state_dir": 123},
            {"state_dir": ""},
            {"download_dir": 123},
            {"download_dir": ""},
        ):
            with self.subTest(config=config), self.assertRaises(settings.SettingsError):
                self.flags(**config)


class LanguageSettingTest(unittest.TestCase):
    def language(self, **config: Any) -> str | None:
        return settings.language_setting(StubContext(config))

    def test_a_language_is_read_stripped(self) -> None:
        self.assertEqual(self.language(language="ja"), "ja")
        self.assertEqual(self.language(language="  ja-JP \n"), "ja-JP")

    def test_absent_blank_and_non_string_values_are_unset(self) -> None:
        for config in ({}, {"language": ""}, {"language": " \t"}, {"language": None}, {"language": 3}, {"language": ["ja"]}):
            with self.subTest(config=config):
                self.assertIsNone(self.language(**config))

    def test_it_is_no_flag_of_list_or_run(self) -> None:
        self.assertEqual(settings.settings_flags(StubContext({"language": "ja"})), [])


class EmojiSettingTest(unittest.TestCase):
    def test_no_setting_returns_a_copy_of_the_package_defaults(self) -> None:
        for defaults in ({}, {"things": "🧩", "widgets": "🔀"}):
            with self.subTest(defaults=defaults), mock.patch.object(project, "TOOLSET_EMOJI", defaults):
                result = settings.emoji_setting(StubContext())
                self.assertEqual(result, defaults)
                self.assertIsNot(result, defaults)

    def test_explicit_defaults_are_copied(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        result = settings.emoji_setting(StubContext(), defaults=defaults)
        self.assertEqual(result, defaults)
        self.assertIsNot(result, defaults)

    def test_overrides_replace_and_add_emoji_and_preserve_other_defaults(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        result = settings.emoji_setting(StubContext({"emoji": {"things": "🗒️", "items": "📦"}}), defaults)
        self.assertEqual(result, {"things": "🗒️", "widgets": "🔀", "items": "📦"})
        self.assertEqual(defaults, {"things": "🧩", "widgets": "🔀"})

    def test_an_empty_string_removes_an_emoji(self) -> None:
        result = settings.emoji_setting(StubContext({"emoji": {"things": ""}}), {"things": "🧩", "widgets": "🔀"})
        self.assertEqual(result, {"things": "", "widgets": "🔀"})

    def test_a_setting_that_is_not_a_dict_is_ignored(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        for value in (None, "🧩", ["things"], 3, True):
            with self.subTest(value=value):
                self.assertEqual(settings.emoji_setting(StubContext({"emoji": value}), defaults), defaults)

    def test_entries_that_are_not_strings_are_ignored(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        for value in (None, 3, ["🧩"], True, {"a": "b"}):
            with self.subTest(value=value):
                result = settings.emoji_setting(StubContext({"emoji": {"things": value, "items": "📦"}}), defaults)
                self.assertEqual(result, {"things": "🧩", "widgets": "🔀", "items": "📦"})
        result = settings.emoji_setting(StubContext({"emoji": {1: "🧩", "items": "📦"}}), defaults)
        self.assertEqual(result, {"things": "🧩", "widgets": "🔀", "items": "📦"})

    def test_it_is_no_flag_of_list_or_run(self) -> None:
        self.assertEqual(settings.settings_flags(StubContext({"emoji": {"things": "🗒️"}})), [])


if __name__ == "__main__":
    unittest.main()
