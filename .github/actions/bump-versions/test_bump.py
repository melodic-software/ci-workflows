"""Unit tests for the version-bump engine: selection, pins, verification and hooks."""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "bump.py"
_spec = importlib.util.spec_from_file_location("version_bump", SCRIPT)
if _spec is None or _spec.loader is None:
    raise ImportError(SCRIPT)
bump = importlib.util.module_from_spec(_spec)
sys.modules["version_bump"] = bump
_spec.loader.exec_module(bump)

POLICY = {"cooldownDays": {"own": 0, "patch": 3, "minor": 3, "major": 7}}
THIRD = {"class": "third-party"}
NOW = dt.datetime(2026, 11, 2, 12, tzinfo=dt.UTC)


def release(version: str, days_old: float) -> object:
    return bump.Release(version, f"v{version}", NOW - dt.timedelta(days=days_old))


class VersionClassTest(unittest.TestCase):
    def test_parse_rejects_prereleases(self) -> None:
        self.assertEqual(bump.parse_version("2.15.1"), (2, 15, 1))
        self.assertIsNone(bump.parse_version("2.16.0-rc.1"))
        self.assertIsNone(bump.parse_version("v2.16.0"))

    def test_classes(self) -> None:
        self.assertEqual(bump.change_class("2.13.2", "2.13.3"), "patch")
        self.assertEqual(bump.change_class("2.13.2", "2.15.0"), "minor")
        self.assertEqual(bump.change_class("2.13.2", "3.0.0"), "major")
        # Calendar versions: a new month is minor, a new year is major.
        self.assertEqual(bump.change_class("2026.9.12", "2026.10.24"), "minor")
        self.assertEqual(bump.change_class("2026.12.3", "2027.1.0"), "major")

    def test_below_one_a_minor_move_is_major(self) -> None:
        # The Dependabot gate's breaksBelowOne rule: 0.24 -> 0.25 breaks, 0.24.2 -> 0.24.3 not.
        self.assertEqual(bump.change_class("0.24.2", "0.25.0"), "major")
        self.assertEqual(bump.change_class("0.24.2", "0.24.3"), "patch")
        self.assertEqual(bump.change_class("0.38.2", "1.0.0"), "major")
        self.assertEqual(bump.cooldown_days(POLICY, THIRD, "0.38.2", "0.39.0"), 7)

    def test_line_major_below_one_keeps_the_minor(self) -> None:
        self.assertFalse(bump.in_line((0, 24, 2), (0, 25, 0), "major"))
        self.assertTrue(bump.in_line((0, 24, 2), (0, 24, 3), "major"))
        self.assertTrue(bump.in_line((1, 4, 0), (1, 5, 0), "major"))
        self.assertFalse(bump.in_line((1, 4, 0), (2, 0, 0), "major"))

    def test_cooldown_by_class_and_override(self) -> None:
        self.assertEqual(bump.cooldown_days(POLICY, THIRD, "1.0.0", "1.0.1"), 3)
        self.assertEqual(bump.cooldown_days(POLICY, THIRD, "1.0.0", "2.0.0"), 7)
        self.assertEqual(
            bump.cooldown_days(POLICY, {"class": "own"}, "1.0.0", "2.0.0"), 0
        )
        override = {"class": "third-party", "cooldownDays": 0}
        self.assertEqual(bump.cooldown_days(POLICY, override, "1.0.0", "2.0.0"), 0)


class SelectTest(unittest.TestCase):
    def test_latest_past_cooldown_is_taken(self) -> None:
        sel = bump.select(
            [release("1.2.0", 5), release("1.1.0", 20)], "1.0.0", POLICY, THIRD, NOW
        )
        self.assertEqual(sel.chosen.version, "1.2.0")
        self.assertEqual(sel.latest.version, "1.2.0")
        self.assertEqual(bump.days_between(sel.oldest_newer.date, NOW), 20)

    def test_young_latest_falls_back_to_older_release(self) -> None:
        sel = bump.select(
            [release("1.2.0", 1), release("1.1.0", 4)], "1.0.0", POLICY, THIRD, NOW
        )
        self.assertEqual(sel.latest.version, "1.2.0")
        self.assertEqual(sel.chosen.version, "1.1.0")

    def test_major_waits_seven_days_while_minor_waits_three(self) -> None:
        sel = bump.select(
            [release("2.0.0", 5), release("1.3.0", 5)], "1.0.0", POLICY, THIRD, NOW
        )
        self.assertEqual(sel.chosen.version, "1.3.0")
        self.assertEqual(sel.cooldown, 7)

    def test_nothing_past_cooldown(self) -> None:
        sel = bump.select([release("1.0.1", 2)], "1.0.0", POLICY, THIRD, NOW)
        self.assertIsNone(sel.chosen)
        self.assertEqual(sel.latest.version, "1.0.1")

    def test_own_release_has_no_cooldown(self) -> None:
        sel = bump.select(
            [release("2.16.0", 0)], "2.15.1", POLICY, {"class": "own"}, NOW
        )
        self.assertEqual(sel.chosen.version, "2.16.0")

    def test_never_downgrades_and_ignores_prereleases(self) -> None:
        rels = [release("0.9.0", 30), release("1.0.0", 30), release("1.1.0-rc1", 30)]
        sel = bump.select(rels, "1.0.0", POLICY, THIRD, NOW)
        self.assertIsNone(sel.latest)
        self.assertIsNone(sel.chosen)


class SumsTest(unittest.TestCase):
    SUMS = "\n".join(
        [
            f"{'a' * 64}  ./tool-linux-x64",
            f"{'b' * 64}  ./tool-linux-x64.sig",
            f"{'c' * 64} *tool-win.exe",
            f"{'d' * 64}  dup",
            f"{'e' * 64}  dup",
            "-----BEGIN PGP SIGNATURE-----",
        ]
    )

    def test_exact_name_once(self) -> None:
        sums = bump.parse_sums(self.SUMS)
        self.assertEqual(bump.lookup_sum(sums, "tool-linux-x64", "sha256"), "a" * 64)
        self.assertEqual(bump.lookup_sum(sums, "tool-win.exe", "sha256"), "c" * 64)

    def test_missing_duplicate_or_wrong_length_fails(self) -> None:
        sums = bump.parse_sums(self.SUMS)
        for name, algo in (
            ("tool", "sha256"),
            ("dup", "sha256"),
            ("tool-linux-x64", "sha512"),
        ):
            with self.subTest(name=name, algo=algo), self.assertRaises(bump.BumpError):
                bump.lookup_sum(sums, name, algo)

    def test_case(self) -> None:
        self.assertEqual(bump.apply_case("ab", "upper"), "AB")
        self.assertEqual(bump.apply_case("AB", None), "ab")


class DecodedTextTest(unittest.TestCase):
    def test_utf16_with_a_bom_and_utf8(self) -> None:
        self.assertEqual(bump.decoded_text("a  b".encode("utf-16")), "a  b")
        self.assertEqual(bump.decoded_text(b"a  b"), "a  b")


class RewriteTest(unittest.TestCase):
    def test_replace_on_line_keeps_quotes_and_other_lines(self) -> None:
        text = 'a:\n  version: "1.0.0"\n  other: "1.0.0"\n'
        self.assertEqual(
            bump.replace_on_line(text, 2, "1.0.0", "1.1.0"),
            'a:\n  version: "1.1.0"\n  other: "1.0.0"\n',
        )

    def test_locate_line_ignores_yq_offset_after_header_comments(self) -> None:
        text = '# header\n# more\ncalibre:\n  version: "9.16.0"\n  other: "9.16.0"\n'
        # yq reports line 2 here: it does not count the header comments.
        self.assertEqual(bump.locate_line(text, ".calibre.version", "9.16.0", 2), 4)

    def test_locate_line_list_entries_and_ambiguity(self) -> None:
        text = "files:\n  - path: a\n    url: u/a\n  - path: b\n    url: u/b\n"
        self.assertEqual(bump.locate_line(text, ".files[1].url", "u/b", 1), 5)
        dup = "a:\n  v: 1.0\nb:\n  v: 1.0\n"
        self.assertEqual(bump.locate_line(dup, ".b.v", "1.0", 4), 4)
        with self.assertRaises(bump.BumpError):
            bump.locate_line(dup, ".b.v", "1.0", 3)

    def test_replace_on_line_refuses_ambiguity(self) -> None:
        with self.assertRaises(bump.BumpError):
            bump.replace_on_line("x: 1.0 1.0\n", 1, "1.0", "2.0")

    def test_fill(self) -> None:
        self.assertEqual(bump.fill("v{version}/{path}", "1.2", "a.zsh"), "v1.2/a.zsh")


class PublishGuardTest(unittest.TestCase):
    def test_bot_prs_drops_forks_and_humans(self) -> None:
        prs = [
            {"number": 1, "isCrossRepository": True, "author": {"is_bot": True}},
            {"number": 2, "isCrossRepository": False, "author": {"is_bot": False}},
            {
                "number": 3,
                "isCrossRepository": False,
                "author": {"is_bot": True, "login": "app/melodic-ai"},
            },
            {
                "number": 4,
                "isCrossRepository": False,
                "author": {"is_bot": True, "login": "app/dependabot"},
            },
        ]
        with mock.patch.object(bump, "run", return_value=json.dumps(prs)):
            self.assertEqual([p["number"] for p in bump.bot_prs("b")], [3, 4])
            own = bump.own_prs("b", "o/r", "melodic-ai")
            self.assertEqual([p["number"] for p in own], [3])

    def test_tag_source_waits_for_cooldown_from_bot_commit(self) -> None:
        recent = (dt.datetime.now(dt.UTC) - dt.timedelta(days=1)).isoformat()
        old = (dt.datetime.now(dt.UTC) - dt.timedelta(days=4)).isoformat()
        row = {"pr": 9, "tagCooldown": 3}
        with (
            mock.patch.object(bump, "run") as run,
            mock.patch.object(bump, "run_raw") as run_raw,
        ):
            bump.arm_auto_merge(row, "o/r", {"date": recent})
            run.assert_not_called()
            # An arm left from an earlier target is disabled while the new one waits.
            self.assertIn("--disable-auto", run_raw.call_args.args[0])
            self.assertFalse(row["autoMerge"])
            bump.arm_auto_merge(row, "o/r", {"date": old})
            run.assert_called_once()
            self.assertTrue(row["autoMerge"])

    def test_author_dated_sources_wait_from_first_sighting(self) -> None:
        # The module proxy's .info Time is the tagged commit's date, which its author sets;
        # a registry's publish time is the registry's own.
        rows = [
            {"sourceType": "goproxy", "targetCooldown": 3},
            {"sourceType": "github-tag", "targetCooldown": 7},
            {"sourceType": "npm", "targetCooldown": 9},
        ]
        self.assertEqual(bump.tag_cooldown(rows), 7)
        self.assertEqual(bump.tag_cooldown(rows[:1]), 3)
        self.assertEqual(bump.tag_cooldown(rows[2:]), 0)

    def test_bump_with_a_major_row_is_left_for_review(self) -> None:
        rows = [
            {"current": "1.4.0", "target": "1.5.0"},
            {"current": "0.24.2", "target": "0.25.0"},
        ]
        self.assertTrue(bump.has_major(rows))
        self.assertFalse(bump.has_major(rows[:1]))
        self.assertTrue(bump.has_major([{"current": "2.9.0", "target": "3.0.0"}]))
        row = {"pr": 9, "tagCooldown": 0, "hasMajor": True}
        with (
            mock.patch.object(bump, "run") as run,
            mock.patch.object(bump, "run_raw") as run_raw,
        ):
            bump.arm_auto_merge(
                row, "o/r", {"date": dt.datetime.now(dt.UTC).isoformat()}
            )
        run.assert_not_called()
        self.assertIn("--disable-auto", run_raw.call_args.args[0])
        self.assertFalse(row["autoMerge"])
        self.assertEqual(row["detail"], "a major release waits for review")

    def test_release_source_arms_at_once(self) -> None:
        row = {"pr": 9, "tagCooldown": 0}
        now = dt.datetime.now(dt.UTC).isoformat()
        with mock.patch.object(bump, "run") as run:
            bump.arm_auto_merge(row, "o/r", {"date": now})
            run.assert_called_once()


class LineAndFormatTest(unittest.TestCase):
    def test_line_keeps_releases_inside_the_pin_line(self) -> None:
        rels = [release("7.0.0", 30), release("6.1.0", 30), release("6.0.9", 30)]
        major = bump.select(rels, "6.0.3", POLICY, {**THIRD, "line": "major"}, NOW)
        self.assertEqual(major.chosen.version, "6.1.0")
        minor = bump.select(rels, "6.0.3", POLICY, {**THIRD, "line": "minor"}, NOW)
        self.assertEqual(minor.chosen.version, "6.0.9")
        free = bump.select(rels, "6.0.3", POLICY, THIRD, NOW)
        self.assertEqual(free.chosen.version, "7.0.0")

    def test_pinned_version_reads_the_format(self) -> None:
        tool = {"format": "pyright[nodejs]=={version}"}
        self.assertEqual(
            bump.pinned_version(tool, "pyright[nodejs]==1.1.411"), "1.1.411"
        )
        npm = {"format": "@upstash/context7-mcp@{version}"}
        self.assertEqual(
            bump.pinned_version(npm, "@upstash/context7-mcp@4.1.1"), "4.1.1"
        )
        self.assertEqual(bump.pinned_version({}, "3.14.8"), "3.14.8")
        with self.assertRaises(bump.BumpError):
            bump.pinned_version(tool, "ruff==0.17.0")

    def test_locate_line_sequence_item_and_whole_value(self) -> None:
        text = "uv:\n  dev:\n    - ruff==0.17.0\n    - mypy==2.3.1\n"
        path = '.uv.dev[] | select(test("^ruff=="))'
        self.assertEqual(bump.locate_line(text, path, "ruff==0.17.0", 1), 3)
        mods = 'm:\n  - name: a\n    version: "0.11.0"\n  - name: b\n    version: "1.1.0"\n'
        # 1.1.0 must not match inside 0.11.0.
        path = '.m[] | select(.name == "b") | .version'
        self.assertEqual(bump.locate_line(mods, path, "1.1.0", 1), 5)


class GroupTest(unittest.TestCase):
    TOOLS: ClassVar[dict[str, dict[str, str]]] = {
        "a": {"group": "g"},
        "b": {},
        "c": {"group": "g"},
    }

    def test_group_units(self) -> None:
        self.assertEqual(bump.group_units(self.TOOLS), {"g": ["a", "c"], "b": ["b"]})

    def test_selected_tools_takes_a_group_name(self) -> None:
        policy = {"tools": self.TOOLS}
        self.assertEqual(list(bump.selected_tools(policy, "g")), ["a", "c"])
        self.assertEqual(list(bump.selected_tools(policy, "b,a")), ["a", "b"])
        with self.assertRaises(SystemExit):
            bump.selected_tools(policy, "nope")

    def test_targets_marker(self) -> None:
        rows = [{"tool": "a", "target": "1.1"}, {"tool": "c", "target": "2.0"}]
        self.assertEqual(bump.targets_marker(rows), "a=1.1,c=2.0")
        body = f"x\n<!-- version-bump-targets: {bump.targets_marker(rows)} -->\n"
        self.assertEqual(bump.TARGETS_MARKER.search(body).group(1), "a=1.1,c=2.0")


class RegistryParseTest(unittest.TestCase):
    def test_pypi_dates_by_first_live_upload(self) -> None:
        doc = {
            "releases": {
                "1.0.0": [
                    {"upload_time_iso_8601": "2026-10-02T00:00:00Z", "yanked": False},
                    {"upload_time_iso_8601": "2026-10-01T00:00:00Z", "yanked": False},
                ],
                "1.1.0": [
                    {"upload_time_iso_8601": "2026-10-03T00:00:00Z", "yanked": True}
                ],
                "1.2.0rc1": [{"upload_time_iso_8601": "2026-10-04T00:00:00Z"}],
                "1.3.0": [],
            }
        }
        rels = bump.pypi_releases(doc)
        self.assertEqual([r.version for r in rels], ["1.0.0"])
        self.assertEqual(rels[0].date, dt.datetime(2026, 10, 1, tzinfo=dt.UTC))

    def test_goproxy_case_encodes_upper_case(self) -> None:
        self.assertEqual(
            bump.goproxy_path("github.com/BurntSushi/toml"),
            "github.com/!burnt!sushi/toml",
        )

    def test_goproxy_keeps_release_tags_only(self) -> None:
        rels = bump.goproxy_versions(
            "v1.2.0\nv1.3.0-rc.1\nv2.0.0+incompatible\nv1.10.0\n"
        )
        self.assertEqual(
            [(r.version, r.tag) for r in rels],
            [("1.2.0", "v1.2.0"), ("1.10.0", "v1.10.0")],
        )

    def test_nuget_drops_unlisted_and_prerelease(self) -> None:
        def leaf(version: str, listed: bool = True) -> dict[str, Any]:
            return {
                "packageContent": f"https://example.test/{version}.nupkg",
                "catalogEntry": {
                    "@id": f"https://example.test/{version}.json",
                    "version": version,
                    "listed": listed,
                    "published": "2026-10-25T17:07:30.2+00:00",
                },
            }

        pages = [
            {"items": [leaf("10.0.13"), leaf("10.0.14", listed=False)]},
            {"items": [leaf("11.0.0-rc.1")]},
        ]
        rels = bump.nuget_releases(pages)
        self.assertEqual([r.version for r in rels], ["10.0.13"])
        self.assertEqual(rels[0].meta["nupkg"], "https://example.test/10.0.13.nupkg")
        self.assertEqual(rels[0].date.year, 2026)

    def test_npm_drops_deprecated_and_undated(self) -> None:
        doc: dict[str, Any] = {
            "time": {
                "1.0.0": "2026-10-01T00:00:00.000Z",
                "1.1.0": "2026-10-02T00:00:00Z",
            },
            "versions": {
                "1.0.0": {"dist": {}},
                "1.1.0": {"deprecated": "broken"},
                "1.2.0": {},
                "2.0.0-beta.1": {},
            },
        }
        self.assertEqual([r.version for r in bump.npm_releases(doc)], ["1.0.0"])

    def test_psgallery_skips_prerelease_and_unlisted(self) -> None:
        def entry(version: str, published: str, pre: str = "false") -> str:
            return (
                "<entry><m:properties>"
                f"<d:Version>{version}</d:Version><d:NormalizedVersion>{version}</d:NormalizedVersion>"
                f"<d:IsPrerelease>{pre}</d:IsPrerelease><d:Published>{published}</d:Published>"
                "<d:PackageHash>aGFzaA==</d:PackageHash><d:PackageHashAlgorithm>SHA512</d:PackageHashAlgorithm>"
                "</m:properties></entry>"
            )

        ns = "http://schemas.microsoft.com/ado/2007/08/dataservices"
        xml = "".join(
            [
                f'<feed xmlns="http://www.w3.org/2005/Atom" xmlns:d="{ns}" xmlns:m="{ns}/metadata">',
                entry("6.2.0", "2026-09-09T19:41:50.16"),
                entry("6.3.0-beta1", "2026-10-01T00:00:00", pre="true"),
                entry("6.1.0", "1900-01-01T00:00:00"),
                '<link rel="next" href="https://example.test/page2" /></feed>',
            ]
        )
        rels, nxt = bump.parse_psgallery(xml)
        self.assertEqual([r.version for r in rels], ["6.2.0"])
        self.assertEqual(rels[0].meta, {"hash": "aGFzaA==", "algo": "SHA512"})
        self.assertEqual(rels[0].date.tzinfo, dt.UTC)
        self.assertEqual(nxt, "https://example.test/page2")

    def test_uv_cpython_builds_counts_hashed_stable_builds(self) -> None:
        meta = {
            "a": {
                "name": "cpython",
                "major": 3,
                "minor": 14,
                "patch": 10,
                "prerelease": "",
                "sha256": "a" * 64,
            },
            "b": {
                "name": "cpython",
                "major": 3,
                "minor": 14,
                "patch": 10,
                "prerelease": "",
                "sha256": "b" * 64,
            },
            "c": {
                "name": "cpython",
                "major": 3,
                "minor": 15,
                "patch": 0,
                "prerelease": "a1",
                "sha256": "c" * 64,
            },
            "d": {
                "name": "pypy",
                "major": 3,
                "minor": 11,
                "patch": 13,
                "prerelease": "",
                "sha256": "d" * 64,
            },
            "e": {
                "name": "cpython",
                "major": 3,
                "minor": 13,
                "patch": 18,
                "prerelease": "",
                "sha256": None,
            },
        }
        self.assertEqual(bump.uv_cpython_builds(meta), {"3.14.10": 2})


class RegistryIntegrityTest(unittest.TestCase):
    def test_nupkg_hash(self) -> None:
        data = b"nupkg bytes"
        good = base64.b64encode(hashlib.sha512(data).digest()).decode()
        self.assertTrue(bump.nupkg_hash_matches(data, good, "SHA512"))
        self.assertFalse(bump.nupkg_hash_matches(b"other", good, "SHA512"))

    def test_zip_member_digest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "f.zip"
            with zipfile.ZipFile(archive, "w") as zf:
                zf.writestr("dir/font.ttf", b"glyphs")
            self.assertEqual(
                bump.zip_member_digest(archive, "dir/font.ttf", "sha256"),
                hashlib.sha256(b"glyphs").hexdigest(),
            )
            with self.assertRaises(bump.BumpError):
                bump.zip_member_digest(archive, "missing.ttf", "sha256")

    @unittest.skipUnless(shutil.which("openssl"), "needs openssl")
    def test_npm_signature_checked_against_committed_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            key, msg, sig = work / "k.pem", work / "m", work / "s.der"
            ec = ["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout"]
            bump.run([*ec, "-out", str(key)])
            pem = bump.run(["openssl", "ec", "-in", str(key), "-pubout"])
            spki = "".join(ln for ln in pem.splitlines() if not ln.startswith("-----"))
            integrity = (
                "sha512-" + base64.b64encode(hashlib.sha512(b"tgz").digest()).decode()
            )
            msg.write_bytes(bump.npm_signed_message("pkg", "1.0.0", integrity))
            bump.run(
                [
                    "openssl",
                    "dgst",
                    "-sha256",
                    "-sign",
                    str(key),
                    "-out",
                    str(sig),
                    str(msg),
                ]
            )
            policy = {"npmRegistryKeys": {"k1": spki}}
            dist = {
                "integrity": integrity,
                "signatures": [
                    {"keyid": "k1", "sig": base64.b64encode(sig.read_bytes()).decode()}
                ],
            }
            rel = bump.Release("1.0.0", "1.0.0", NOW, {"dist": dist})
            verifier = bump.Verifier("pkg", {"source": {}}, rel, work, policy)
            self.assertIn(
                "registry signature verified against k1", verifier.npm_note("pkg", rel)
            )
            # The same signature does not cover another version.
            other = bump.Release("1.0.1", "1.0.1", NOW, {"dist": dist})
            with self.assertRaises(bump.BumpError):
                verifier.npm_note("pkg", other)
            # A signature by a key not committed in the policy is refused.
            unknown = {"dist": {**dist, "signatures": [{"keyid": "k2", "sig": "AA=="}]}}
            with self.assertRaises(bump.BumpError):
                verifier.npm_note("pkg", bump.Release("1.0.0", "1.0.0", NOW, unknown))


class LineCapTest(unittest.TestCase):
    def test_reports_the_newest_release_outside_the_line(self) -> None:
        rels = [release("7.7.0", 30), release("7.6.7", 30)]
        tool = {**THIRD, "line": "minor"}
        sel = bump.select(rels, "7.6.6", POLICY, tool, NOW)
        self.assertEqual(sel.chosen.version, "7.6.7")
        self.assertEqual(sel.beyond_line.version, "7.7.0")
        # With nothing newer inside the line the out-of-line release still shows.
        only = bump.select([release("7.7.0", 30)], "7.6.6", POLICY, tool, NOW)
        self.assertIsNone(only.chosen)
        self.assertEqual(only.beyond_line.version, "7.7.0")
        self.assertIsNone(bump.select(rels, "7.6.6", POLICY, THIRD, NOW).beyond_line)


class RegexPinTest(unittest.TestCase):
    PSD1 = "@{\n    Version = '0.1.36'\n    Msi = @{ Sha256 = 'abc' }\n}\n"

    def test_reads_value_and_line(self) -> None:
        self.assertEqual(
            bump.regex_pin(self.PSD1, r"^\s*Version\s*=\s*'([^']+)'"), ("0.1.36", 2)
        )

    def test_requires_one_group_and_one_line(self) -> None:
        with self.assertRaises(bump.BumpError):
            bump.regex_pin(self.PSD1, r"=\s*'([^']+)'")
        with self.assertRaises(bump.BumpError):
            bump.regex_pin(self.PSD1, r"Version")

    def test_two_edits_on_one_line_and_a_second_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp, "a.psd1"), Path(tmp, "b.yaml")
            a.write_text("Version = '1.0.0'\n", encoding="utf-8")
            b.write_text("image: x:1.0.0@sha256:aaa\n", encoding="utf-8")
            bump.rewrite(
                [
                    {"file": str(a), "old": "1.0.0", "new": "2.0.0", "line": 1},
                    {"file": str(b), "old": "1.0.0", "new": "2.0.0", "line": 1},
                    {"file": str(b), "old": "aaa", "new": "bbb", "line": 1},
                ]
            )
            self.assertEqual(a.read_text(encoding="utf-8"), "Version = '2.0.0'\n")
            self.assertEqual(
                b.read_text(encoding="utf-8"), "image: x:2.0.0@sha256:bbb\n"
            )


class OciTest(unittest.TestCase):
    OK = "HTTP/2 200\r\nDocker-Content-Digest: sha256:" + "a" * 64 + "\r\n\r\n"
    CHALLENGE = (
        "HTTP/2 401\r\n"
        'www-authenticate: Bearer realm="https://auth.example/token",'
        'service="registry.example",scope="repository:o/i:pull"\r\n\r\n'
    )

    def test_digest_without_auth(self) -> None:
        with mock.patch.object(bump, "run", return_value=self.OK) as run:
            digest = bump.oci_digest("mcr.microsoft.com/dotnet/x", "1.0.0")
        self.assertEqual(digest, "sha256:" + "a" * 64)
        self.assertEqual(
            run.call_args.args[0][-1],
            "https://mcr.microsoft.com/v2/dotnet/x/manifests/1.0.0",
        )

    def test_bearer_flow_and_missing_tag(self) -> None:
        with (
            mock.patch.object(
                bump, "run", side_effect=[self.CHALLENGE, self.OK]
            ) as run,
            mock.patch.object(bump, "http_json", return_value={"token": "t"}) as tok,
        ):
            digest = bump.oci_digest("registry.example/o/i", "1.0.0")
        self.assertEqual(digest, "sha256:" + "a" * 64)
        self.assertEqual(
            tok.call_args.args[0],
            "https://auth.example/token?service=registry.example&scope=repository%3Ao%2Fi%3Apull",
        )
        self.assertIn("Authorization: Bearer t", run.call_args.args[0])
        missing = "HTTP/2 404\r\n\r\n"
        with mock.patch.object(bump, "run", return_value=missing):
            self.assertIsNone(bump.oci_digest("registry.example/o/i", "1.0.0"))

    def test_with_image_drops_only_untagged_releases_above_the_pin(self) -> None:
        rels = [release("13.6.4", 5), release("13.6.3", 6), release("13.4.2", 90)]
        tagged = {"13.6.4": "sha256:" + "a" * 64}
        with mock.patch.object(
            bump, "oci_digest", side_effect=lambda _, v: tagged.get(v)
        ):
            kept = bump.with_image({"requireImage": "h/r"}, rels, "13.4.2")
        self.assertEqual([r.version for r in kept], ["13.6.4", "13.4.2"])


class PublisherChecksTest(unittest.TestCase):
    def verifier(self, verify: dict[str, Any], work: Path) -> Any:
        rel = bump.Release("1.2.0", "v1.2.0", NOW)
        tool = {"source": {"repo": "o/r"}, "verify": verify}
        return bump.Verifier("t", tool, rel, work, {"_dir": work})

    def test_manifest_value_requires_checksum_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            (work / "m.json").write_text('{"a": {"b": "x"}}', encoding="utf-8")
            good = hashlib.sha256((work / "m.json").read_bytes()).hexdigest()
            spec = {"manifest": {"asset": "m.json"}}
            v = self.verifier(spec, work)
            v.assets["m.json"] = work / "m.json"
            with mock.patch.object(v, "checksums", return_value={"m.json": [good]}):
                self.assertEqual(v.manifest_value(".a.b"), "x")
                with self.assertRaises(bump.BumpError):
                    v.manifest_value(".a.missing")
            bad = self.verifier(spec, work)
            bad.assets["m.json"] = work / "m.json"
            with (
                mock.patch.object(
                    bad, "checksums", return_value={"m.json": ["0" * 64]}
                ),
                self.assertRaises(bump.BumpError),
            ):
                bad.manifest_value(".a.b")

    def test_attestation_verifies_every_subject_with_the_signer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            spec = {
                "repo": "o/r",
                "signerWorkflow": "o/r/.github/workflows/rel.yml",
                "assets": ["a-{version}.zip"],
                "sourceDigest": ".source.sha",
                "oci": {"image": ".image", "digest": ".digest"},
            }
            v = self.verifier({}, work)
            v.assets["a-1.2.0.zip"] = work / "a-1.2.0.zip"
            v.manifest = {
                "source": {"sha": "cafe"},
                "image": "ghcr.io/o/r",
                "digest": "sha256:d",
            }
            with mock.patch.object(bump, "run") as run:
                v.attestation(spec)
            calls = [c.args[0] for c in run.call_args_list]
            self.assertEqual(
                [c[3] for c in calls],
                [str(work / "a-1.2.0.zip"), "oci://ghcr.io/o/r@sha256:d"],
            )
            for call in calls:
                self.assertEqual(call[:3], ["gh", "attestation", "verify"])
                self.assertIn("--deny-self-hosted-runners", call)
                self.assertEqual(
                    call[call.index("--source-ref") + 1], "refs/tags/v1.2.0"
                )
                self.assertEqual(call[call.index("--signer-digest") + 1], "cafe")

    def run_authenticode(
        self,
        stdout: str,
        returncode: int,
        digest: str | None = None,
        ca_hash: str | None = None,
    ) -> Any:
        with tempfile.TemporaryDirectory() as tmp:
            work = Path(tmp)
            msi = work / "p-1.2.0.msi"
            msi.write_bytes(b"msi")
            real = digest or hashlib.sha256(b"msi").hexdigest()
            spec = {
                "asset": "p-{version}.msi",
                "caUrl": "https://ca.example/root.crt",
                "caSha256": ca_hash or hashlib.sha256(b"der").hexdigest(),
                "subject": "/O=Example/CN=Example",
            }

            def fake_fetch(_url: str, dest: Path) -> Path:
                dest.write_bytes(b"der")
                return dest

            v = self.verifier({"checksums": {"asset": "h"}}, work)
            v.assets["p-1.2.0.msi"] = msi
            proc = subprocess_result(stdout, returncode)
            with (
                mock.patch.object(bump, "run_raw", return_value=proc),
                mock.patch.object(bump, "fetch", side_effect=fake_fetch),
                mock.patch.object(bump, "run"),
                mock.patch.object(v, "checksums", return_value={"p-1.2.0.msi": [real]}),
            ):
                v.authenticode(spec)
            return v.notes

    GOOD = (
        "Signer's certificate:\n\t------\n\tSigner #0:\n\t\tSubject: /O=Example/CN=Example\n"
        "Signature verification: ok\n\nNumber of verified signatures: 1\nSucceeded\n"
    )

    def test_authenticode_accepts_the_pinned_publisher(self) -> None:
        self.assertIn(
            "Authenticode signer checked: /O=Example/CN=Example",
            self.run_authenticode(self.GOOD, 0),
        )

    def test_authenticode_refuses_failures(self) -> None:
        cases = {
            "nonzero exit": (self.GOOD, 1),
            "wrong signer": (self.GOOD.replace("CN=Example", "CN=Mallory", 1), 0),
            "signature not ok": (self.GOOD.replace("verification: ok", "failed"), 0),
            "two signatures": (self.GOOD.replace("signatures: 1", "signatures: 2"), 0),
        }
        for label, (stdout, code) in cases.items():
            with self.subTest(label), self.assertRaises(bump.BumpError):
                self.run_authenticode(stdout, code)

    def test_authenticode_refuses_an_unpinned_root(self) -> None:
        with self.assertRaises(bump.BumpError):
            self.run_authenticode(self.GOOD, 0, ca_hash="0" * 64)

    def test_authenticode_refuses_bytes_the_checksums_do_not_list(self) -> None:
        with self.assertRaises(bump.BumpError):
            self.run_authenticode(self.GOOD, 0, digest="0" * 64)


class ManifestPatternTest(unittest.TestCase):
    def digest(self, spec: dict[str, str], value: str) -> str:
        rel = bump.Release("1.2.0", "v1.2.0", NOW)
        v = bump.Verifier("t", {"source": {}}, rel, Path("/x"), {})
        with mock.patch.object(v, "manifest_value", return_value=value):
            return v.digest(spec, "1.2.0")

    def test_value_must_fully_match_a_declared_pattern(self) -> None:
        spec = {"manifest": ".a", "pattern": "[0-9a-f]{4}"}
        self.assertEqual(self.digest(spec, "abcd"), "abcd")
        for bad in ("abcd\ninjected", "abc", "`abcd`"):
            with self.subTest(bad), self.assertRaises(bump.BumpError):
                self.digest(spec, bad)

    def test_pattern_is_required(self) -> None:
        with self.assertRaises(bump.BumpError):
            self.digest({"manifest": ".a"}, "abcd")


class BaseBranchTest(unittest.TestCase):
    def test_checkout_ahead_of_the_default_branch_is_refused(self) -> None:
        with (
            mock.patch.object(bump, "run", side_effect=["trunk\n", "2\n"]),
            self.assertRaises(SystemExit),
        ):
            bump.checked_out_default_branch("o/r", "abc")

    def test_behind_or_equal_returns_the_default_branch(self) -> None:
        with mock.patch.object(bump, "run", side_effect=["trunk\n", "0\n"]) as run:
            self.assertEqual(bump.checked_out_default_branch("o/r", "abc"), "trunk")
        self.assertIn("repos/o/r/compare/trunk...abc", run.call_args.args[0])


class ToolIsolationTest(unittest.TestCase):
    def test_an_unexpected_exception_fails_only_that_tool(self) -> None:
        tools = {"a": {"class": "own", "file": "f"}, "b": {"class": "own", "file": "f"}}
        policy = {"tools": tools}

        def resolve(row: dict[str, Any], *_: Any) -> None:
            if row["tool"] == "a":
                raise KeyError("realm")
            row["outcome"] = "current"

        with (
            tempfile.TemporaryDirectory() as tmp,
            mock.patch.object(bump, "resolve_tool", side_effect=resolve),
            mock.patch.object(bump, "bot_prs", return_value=[]),
        ):
            _, rows = bump.prepare_bump("a", ["a"], tools, policy, NOW, Path(tmp), True)
            self.assertEqual(rows[0]["outcome"], "failed")
            self.assertEqual(rows[0]["detail"], "KeyError: 'realm'")
            _, rows = bump.prepare_bump("b", ["b"], tools, policy, NOW, Path(tmp), True)
            self.assertEqual(rows[0]["outcome"], "current")


class LineEndingsTest(unittest.TestCase):
    def test_rewrite_keeps_crlf(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp, "a.psd1")
            f.write_bytes(b"Version = '1.0.0'\r\nOther = 'x'\r\n")
            bump.rewrite([{"file": str(f), "old": "1.0.0", "new": "2.0.0", "line": 1}])
            self.assertEqual(f.read_bytes(), b"Version = '2.0.0'\r\nOther = 'x'\r\n")


class HookTest(unittest.TestCase):
    def test_after_bump_receives_the_ready_tools(self) -> None:
        ready = [({"tool": "a", "target": "1.1"}, {"file": "f"}, [])]
        with mock.patch.object(bump, "run") as run:
            bump.run_hooks({"afterBump": [["bash", "hook.sh"]]}, ready)
        args = run.call_args
        self.assertEqual(args.args[0], ["bash", "hook.sh"])
        self.assertEqual(
            json.loads(args.kwargs["env"]["VERSION_BUMP_READY"]),
            [{"name": "a", "version": "1.1", "tool": {"file": "f"}}],
        )

    def test_no_hooks_is_a_no_op(self) -> None:
        with mock.patch.object(bump, "run") as run:
            bump.run_hooks({}, [])
        run.assert_not_called()


class SyncedCooldownTest(unittest.TestCase):
    """cooldownDays come from the policy file, else the synced standards dependabot-policy."""

    # standards components/dependabot-policy/policy.json schemaVersion 2 (standards#987).
    SYNCED = {
        "schemaVersion": 2,
        "cooldownMinimumDays": 3,
        "cooldownDays": {"own": 0, "patch": 3, "minor": 3, "major": 7},
    }

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.yaml = self.root / "policy.yaml"
        self.synced = self.root / "policy.json"

    def load(self, yaml_doc: dict[str, Any]) -> dict[str, Any]:
        with mock.patch.object(bump, "yq_json", return_value=yaml_doc):
            return bump.load_policy(self.yaml, self.synced)

    def test_policy_without_cooldown_takes_the_synced_classes(self) -> None:
        self.synced.write_text(json.dumps(self.SYNCED), encoding="utf-8")
        policy = self.load({"tools": {}})
        self.assertEqual(
            policy["cooldownDays"], {"own": 0, "patch": 3, "minor": 3, "major": 7}
        )
        self.assertEqual(bump.cooldown_days(policy, THIRD, "1.0.0", "2.0.0"), 7)
        self.assertEqual(bump.cooldown_days(policy, THIRD, "1.0.0", "1.0.1"), 3)

    def test_policy_cooldown_wins_over_the_synced_copy(self) -> None:
        self.synced.write_text(json.dumps(self.SYNCED), encoding="utf-8")
        own = {"own": 1, "patch": 2, "minor": 4, "major": 9}
        policy = self.load({"cooldownDays": own, "tools": {}})
        self.assertEqual(policy["cooldownDays"], own)
        self.assertEqual(bump.cooldown_days(policy, THIRD, "1.0.0", "2.0.0"), 9)

    def test_policy_cooldown_needs_no_synced_copy(self) -> None:
        own = {"own": 0, "patch": 3, "minor": 3, "major": 7}
        self.assertEqual(self.load({"cooldownDays": own})["cooldownDays"], own)

    def test_neither_source_fails_naming_both_paths(self) -> None:
        with self.assertRaises(SystemExit) as raised:
            self.load({"tools": {}})
        self.assertIn(str(self.yaml), str(raised.exception))
        self.assertIn(str(self.synced), str(raised.exception))

    def test_synced_copy_missing_a_class_fails(self) -> None:
        self.synced.write_text(
            json.dumps({"cooldownDays": {"own": 0, "patch": 3, "minor": 3}}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(SystemExit, "own, patch, minor, major"):
            self.load({"tools": {}})

    def test_synced_copy_with_a_non_integer_class_fails(self) -> None:
        days = {"own": False, "patch": 3, "minor": 3, "major": 7}
        self.synced.write_text(json.dumps({"cooldownDays": days}), encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "non-negative integer"):
            self.load({"tools": {}})

    def test_synced_copy_that_is_not_json_fails(self) -> None:
        self.synced.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(SystemExit, "not valid JSON"):
            self.load({"tools": {}})

    def test_cpython_source_waits_the_synced_patch_cooldown(self) -> None:
        self.synced.write_text(json.dumps(self.SYNCED), encoding="utf-8")
        policy = self.load({"tools": {}})
        uv = {
            "draft": False,
            "prerelease": False,
            "published_at": (NOW - dt.timedelta(days=2)).isoformat(),
            "tag_name": "0.9.0",
        }
        with (
            mock.patch.object(bump, "gh_json", return_value=[uv]),
            self.assertRaisesRegex(bump.BumpError, "past the cooldown"),
        ):
            bump.cpython_releases(policy, NOW)


REPO = SCRIPT.parents[3]
OWN_POLICY = REPO / ".github" / "version-bump" / "policy.yaml"


@unittest.skipUnless(shutil.which("yq"), "needs yq (bump-versions/install-tools.sh)")
class OwnPolicyPinsTest(unittest.TestCase):
    """This repository's own policy: every pin it names is one line a bump can rewrite."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.policy = bump.yq_json(".", OWN_POLICY)

    def assert_one_line(self, path: Any, file: Path) -> str:
        text = bump.read_exact(file)
        if isinstance(path, dict):
            return bump.regex_pin(text, path["regex"])[0]
        old = bump.yq_json(path, file)
        self.assertIsInstance(old, str, f"{path} in {file} is not a string scalar")
        bump.locate_line(text, path, old, bump.yq_line(path, file))
        return old

    def test_cooldowns_come_from_the_synced_org_policy(self) -> None:
        self.assertNotIn("cooldownDays", self.policy)

    def test_every_tool_sets_a_line(self) -> None:
        # A merged bump reaches every @main caller, so no tool may cross a major unattended.
        for name, tool in self.policy["tools"].items():
            with self.subTest(tool=name):
                self.assertIn(tool.get("line"), {"major", "minor"})

    def test_every_version_and_field_pin_is_on_one_line(self) -> None:
        for name, tool in self.policy["tools"].items():
            with self.subTest(tool=name):
                file = REPO / tool["file"]
                scalar = self.assert_one_line(tool["version"], file)
                self.assertIsNotNone(
                    bump.parse_version(bump.pinned_version(tool, scalar))
                )
                for item in tool.get("fields", []):
                    self.assert_one_line(
                        item["path"], REPO / item.get("file", tool["file"])
                    )

    def test_tools_in_one_group_pin_the_same_release(self) -> None:
        tools = self.policy["tools"]
        for group, names in bump.group_units(tools).items():
            with self.subTest(group=group):
                versions = {
                    bump.pinned_version(
                        tools[n],
                        self.assert_one_line(
                            tools[n]["version"], REPO / tools[n]["file"]
                        ),
                    )
                    for n in names
                }
                self.assertEqual(len(versions), 1, f"{group} pins {sorted(versions)}")


def subprocess_result(stdout: str, returncode: int) -> Any:
    return mock.Mock(stdout=stdout, returncode=returncode)


if __name__ == "__main__":
    unittest.main()
