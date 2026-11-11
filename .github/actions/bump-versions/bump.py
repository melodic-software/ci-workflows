#!/usr/bin/env python3
"""Bump pinned tool versions under a repository's version-bump policy file.

prepare  resolves each tool's newest release past its cooldown, verifies it, and (unless
         --dry-run) rewrites the pins of each bump (one tool, or the tools sharing a group),
         runs the policy's afterBump hooks and saves the changed files per bump under --out,
         restoring the tree.
publish  commits each prepared bump through the API (so GitHub signs it) to
         version-bump/<bump>, opens or updates its pull request and arms auto-merge.
summary  writes the run's measurement table and fails when any tool failed.

Every run writes <out>/results.json: one row per tool with the current and latest version,
release date, days behind, the cooldown or exception applied, and the outcome, and one row
per bump with its tools, pull request and outcome.

Run from the root of the repository whose policy this is; every file named in the policy is
relative to that root, and key and CA files are relative to the policy file.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode
from xml.etree import ElementTree

BRANCH_PREFIX = "version-bump/"
DEPENDABOT_POLICY = ".github/standards/dependabot-policy/policy.json"
COOLDOWN_CLASSES = ("own", "patch", "minor", "major")
SIGNER_EMAIL = "noreply@github.com"
VERSION_RE = re.compile(r"^\d+(?:\.\d+)*$")
HEX = {"sha256": 64, "sha512": 128}
TARGETS_MARKER = re.compile(r"<!-- version-bump-targets: (.*?) -->")
NPM_REGISTRY = "https://registry.npmjs.org"
CURL_LIMITS = ["--connect-timeout", "10", "--max-time", "300"]
OCI_ACCEPT = (
    "application/vnd.oci.image.index.v1+json, "
    "application/vnd.docker.distribution.manifest.list.v2+json, "
    "application/vnd.oci.image.manifest.v1+json, "
    "application/vnd.docker.distribution.manifest.v2+json"
)
PSGALLERY = "https://www.powershellgallery.com/api/v2"
GOPROXY = "https://proxy.golang.org"
GOSUMDB = "https://sum.golang.org"
NUGET_REGISTRATION = "https://api.nuget.org/v3/registration5-semver1"
# Sources dated by a commit, whose date its author sets: a bump's auto-merge also waits the
# cooldown from the bot's own GitHub-dated commit (arm_auto_merge).
AUTHOR_DATED = {"github-tag", "goproxy"}
ATOM = "{http://www.w3.org/2005/Atom}"
ODATA_D = "{http://schemas.microsoft.com/ado/2007/08/dataservices}"
ODATA_M = "{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}"
SUMMARY_COLUMNS = (
    "Tool",
    "Current",
    "Latest",
    "Released",
    "Target",
    "Days behind",
    "Cooldown",
    "Exception",
    "Outcome",
)


class BumpError(Exception):
    """A tool's bump cannot proceed; recorded as that tool's failed outcome."""


def failure_text(exc: Exception) -> str:
    """A BumpError's own message; any other exception also names its type."""
    return str(exc) if isinstance(exc, BumpError) else f"{type(exc).__name__}: {exc}"


# ---------------------------------------------------------------- pure logic


def parse_version(text: str) -> tuple[int, ...] | None:
    """Numeric dotted version, or None for anything else (prereleases included)."""
    return tuple(int(p) for p in text.split(".")) if VERSION_RE.match(text) else None


def change_class(current: str, candidate: str) -> str:
    cur, new = parse_version(current), parse_version(candidate)
    if cur is None or new is None:
        raise BumpError(f"cannot classify {current} -> {candidate}")
    # Below 1.0 a minor move is the breaking one, as Dependabot's gate treats it.
    if cur[0] != new[0] or (cur[0] == 0 and cur[1:2] != new[1:2]):
        return "major"
    if cur[1:2] != new[1:2]:
        return "minor"
    return "patch"


def cooldown_days(
    policy: dict[str, Any], tool: dict[str, Any], current: str, candidate: str
) -> int:
    if "cooldownDays" in tool:
        return int(tool["cooldownDays"])
    days = policy["cooldownDays"]
    if tool["class"] == "own":
        return int(days["own"])
    return int(days[change_class(current, candidate)])


def in_line(
    current: tuple[int, ...], candidate: tuple[int, ...], line: str | None
) -> bool:
    """line major keeps the first number, minor the first two; None allows any release.

    Below 1.0 the minor number is the breaking one, so line major keeps it too.
    """
    width = {"major": 1, "minor": 2}.get(line or "", 0)
    if line == "major" and current[:1] == (0,):
        width = 2
    return candidate[:width] == current[:width]


@dataclass(frozen=True)
class Release:
    version: str
    tag: str
    date: dt.datetime
    # Per-source data the verification reads (registry files, hashes, signatures).
    meta: Any = field(default=None, compare=False)


@dataclass(frozen=True)
class Selection:
    latest: Release | None  # newest release above the pin
    chosen: Release | None  # newest release above the pin that is past its cooldown
    oldest_newer: Release | None  # first release the pin fell behind
    cooldown: int  # cooldown that applied to the latest release
    beyond_line: Release | None = None  # newest release a line cap excludes


def select(
    releases: list[Release],
    current: str,
    policy: dict[str, Any],
    tool: dict[str, Any],
    now: dt.datetime,
) -> Selection:
    """Walk releases newer than the pin from newest down; take the first past its cooldown."""
    cur = parse_version(current)
    if cur is None:
        raise BumpError(f"pinned version {current!r} is not numeric")
    above = sorted(
        (r for r in releases if (parse_version(r.version) or ()) > cur),
        key=lambda r: parse_version(r.version) or (),
        reverse=True,
    )
    line = tool.get("line")
    newer = [r for r in above if in_line(cur, parse_version(r.version) or (), line)]
    beyond = next((r for r in above if r not in newer), None)
    if not newer:
        return Selection(None, None, None, 0, beyond)
    latest = newer[0]
    chosen = next(
        (
            r
            for r in newer
            if (now - r.date).total_seconds()
            >= cooldown_days(policy, tool, current, r.version) * 86400
        ),
        None,
    )
    oldest = min(newer, key=lambda r: r.date)
    return Selection(
        latest,
        chosen,
        oldest,
        cooldown_days(policy, tool, current, latest.version),
        beyond,
    )


def parse_sums(text: str) -> dict[str, list[str]]:
    """`<hash>  <name>` lines (also `./name` and `*name`) to name -> hashes."""
    sums: dict[str, list[str]] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-fA-F]{32,128}", parts[0]):
            continue
        name = parts[1].lstrip("*")
        name = name.removeprefix("./")
        sums.setdefault(name, []).append(parts[0].lower())
    return sums


def lookup_sum(sums: dict[str, list[str]], name: str, algo: str) -> str:
    found = sums.get(name, [])
    if len(found) != 1 or len(found[0]) != HEX[algo]:
        raise BumpError(
            f"the checksums list '{name}' {len(found)} times, not exactly once as {algo}"
        )
    return found[0]


def fill(template: str, version: str, path: str = "") -> str:
    return template.replace("{version}", version).replace("{path}", path)


def pinned_version(tool: dict[str, Any], scalar: str) -> str:
    """The version inside a pin scalar written as tool.format (default the bare version)."""
    fmt = tool.get("format", "{version}")
    head, _, tail = fmt.partition("{version}")
    if not (scalar.startswith(head) and scalar.endswith(tail)) or len(scalar) <= len(
        head + tail
    ):
        raise BumpError(f"pin {scalar!r} does not match the format {fmt!r}")
    return scalar[len(head) : len(scalar) - len(tail)]


def apply_case(digest: str, case: str | None) -> str:
    return digest.upper() if case == "upper" else digest.lower()


def locate_line(text: str, path: str, old: str, hint: int) -> int:
    """1-based line holding path's scalar: the one line with its key and old value.

    A path ending in a key (`.a.b`, `.a[0].b`, `... | .b`) matches `b:` lines; any other
    path (`.list[] | select(...)`) is a sequence item, matched as `- <old>`. The value must
    stand alone, so 1.1.0 never matches inside 11.1.0. yq's `line` does not count a comment
    block at the top of the file, so it is only the tiebreak when several lines match.
    """
    value = rf"(?<![\w.\-]){re.escape(old)}(?![\w.\-])"
    m = re.search(r"\.([A-Za-z_][\w-]*)(?:\[\d+\])?$", path)
    if m:
        pattern = re.compile(
            rf"^\s*(?:-\s+)?['\"]?{re.escape(m.group(1))}['\"]?\s*:.*{value}"
        )
    else:
        pattern = re.compile(rf"^\s*-\s+['\"]?{value}['\"]?\s*(?:#.*)?$")
    found = [i + 1 for i, s in enumerate(text.splitlines()) if pattern.match(s)]
    if len(found) == 1:
        return found[0]
    if hint in found:
        return hint
    raise BumpError(f"cannot place {path} = {old!r} on one line ({len(found)} found)")


def regex_pin(text: str, pattern: str) -> tuple[str, int]:
    """The value a pin's regex captures and its 1-based line; exactly one line must match."""
    compiled = re.compile(pattern)
    found = [
        (m, i + 1) for i, s in enumerate(text.splitlines()) if (m := compiled.search(s))
    ]
    if compiled.groups != 1 or len(found) != 1:
        raise BumpError(
            f"{pattern!r} must have one capture group and match one line ({len(found)} found)"
        )
    return found[0][0].group(1), found[0][1]


def pin_label(path: str | dict[str, str]) -> str:
    return path["regex"] if isinstance(path, dict) else path


def replace_on_line(text: str, line: int, old: str, new: str) -> str:
    """Replace the one occurrence of old on 1-based line, keeping every other byte."""
    lines = text.splitlines(keepends=True)
    target = lines[line - 1]
    if target.count(old) != 1:
        raise BumpError(
            f"line {line} holds {old!r} {target.count(old)} times, expected once"
        )
    lines[line - 1] = target.replace(old, new)
    return "".join(lines)


def days_between(earlier: dt.datetime | None, now: dt.datetime) -> int:
    return 0 if earlier is None else max(0, (now - earlier).days)


def group_units(tools: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Bump name -> its tools: a tool's group, else the tool alone.

    Tools that move the same golden rows or adjacent lines of one file share a group, so
    their bumps land in one pull request instead of conflicting with each other.
    """
    units: dict[str, list[str]] = {}
    for name, tool in tools.items():
        units.setdefault(tool.get("group", name), []).append(name)
    return units


def targets_marker(rows: list[dict[str, Any]]) -> str:
    return ",".join(f"{r['tool']}={r['target']}" for r in rows)


# ---------------------------------------------------------------- registry integrity


def npm_signed_message(name: str, version: str, integrity: str) -> bytes:
    """What the npm registry signs for a version: `<name>@<version>:<integrity>`."""
    return f"{name}@{version}:{integrity}".encode()


def nupkg_hash_matches(data: bytes, package_hash: str, algo: str) -> bool:
    """PSGallery's PackageHash is the base64 digest of the .nupkg bytes."""
    digest = hashlib.new(algo.lower(), data).digest()
    return base64.b64encode(digest).decode() == package_hash


def parse_psgallery(xml_text: str) -> tuple[list[Release], str | None]:
    """Listed, non-prerelease versions of one OData page, and the next page's URL."""
    # The feed is PSGallery's, fetched over TLS; expat resolves no external entities.
    root = ElementTree.fromstring(xml_text)  # noqa: S314
    out: list[Release] = []
    for entry in root.iter(f"{ATOM}entry"):
        props = entry.find(f"{ODATA_M}properties")
        if props is None:
            continue

        def prop(key: str, props: ElementTree.Element = props) -> str:
            return (props.findtext(f"{ODATA_D}{key}") or "").strip()

        published = prop("Published")
        if prop("IsPrerelease") == "true" or not published:
            continue
        date = dt.datetime.fromisoformat(published).replace(tzinfo=dt.UTC)
        # An unlisted version reports 1900-01-01, which would pass any cooldown.
        if date.year < 2000:
            continue
        meta = {"hash": prop("PackageHash"), "algo": prop("PackageHashAlgorithm")}
        version = prop("NormalizedVersion") or prop("Version")
        out.append(Release(version, version, date, meta))
    nxt = next(
        (ln.get("href") for ln in root.iter(f"{ATOM}link") if ln.get("rel") == "next"),
        None,
    )
    return out, nxt


def goproxy_path(module: str) -> str:
    """The module proxy's case encoding: each upper-case letter becomes ! and its lower case."""
    return re.sub(r"[A-Z]", lambda m: "!" + m.group(0).lower(), module)


def goproxy_versions(listing: str) -> list[Release]:
    """`@v/list` tags as releases, undated until date_tags reads their `.info`; prereleases
    and +incompatible versions dropped."""
    out: list[Release] = []
    for tag in listing.split():
        version = tag.removeprefix("v")
        if tag.startswith("v") and parse_version(version) is not None:
            out.append(Release(version, tag, dt.datetime.max.replace(tzinfo=dt.UTC)))
    return out


def nuget_releases(pages: list[dict[str, Any]]) -> list[Release]:
    """Listed, non-prerelease registration leaves dated by `published`."""
    out: list[Release] = []
    for page in pages:
        for leaf in page.get("items", []):
            entry = leaf["catalogEntry"]
            version = entry["version"]
            if entry.get("listed") is False or parse_version(version) is None:
                continue
            meta = {"catalog": entry["@id"], "nupkg": leaf["packageContent"]}
            out.append(Release(version, version, parse_date(entry["published"]), meta))
    return out


def pypi_releases(doc: dict[str, Any]) -> list[Release]:
    """PyPI JSON `releases`: dated by the first upload, yanked files and versions dropped."""
    out: list[Release] = []
    for version, files in doc.get("releases", {}).items():
        live = [f for f in files if not f.get("yanked")]
        if not live or parse_version(version) is None:
            continue
        date = min(parse_date(f["upload_time_iso_8601"]) for f in live)
        out.append(Release(version, version, date, live))
    return out


def npm_releases(doc: dict[str, Any]) -> list[Release]:
    """npm packument versions dated by `time`, deprecated versions dropped."""
    times = doc.get("time", {})
    out: list[Release] = []
    for version, meta in doc.get("versions", {}).items():
        if meta.get("deprecated") or version not in times:
            continue
        if parse_version(version) is not None:
            out.append(Release(version, version, parse_date(times[version]), meta))
    return out


def uv_cpython_builds(metadata: dict[str, Any]) -> dict[str, int]:
    """CPython version -> number of builds with a sha256 in uv's download metadata."""
    builds: dict[str, int] = {}
    for item in metadata.values():
        if item.get("name") != "cpython" or item.get("prerelease"):
            continue
        if re.fullmatch(r"[0-9a-f]{64}", item.get("sha256") or ""):
            version = f"{item['major']}.{item['minor']}.{item['patch']}"
            builds[version] = builds.get(version, 0) + 1
    return builds


# ---------------------------------------------------------------- process helpers


def run_raw(
    args: list[str], *, env: dict[str, str] | None = None, input_text: str | None = None
) -> subprocess.CompletedProcess[str]:
    # Fixed argv, no shell; the tools (gh, git, yq, curl, gpgv, openssl, mise) come from PATH.
    return subprocess.run(  # noqa: S603
        args,
        check=False,
        capture_output=True,
        text=True,
        input=input_text,
        env={**os.environ, **(env or {})},
    )


def run(
    args: list[str], *, env: dict[str, str] | None = None, input_text: str | None = None
) -> str:
    proc = run_raw(args, env=env, input_text=input_text)
    if proc.returncode != 0:
        raise BumpError(
            f"{' '.join(args[:3])} failed ({proc.returncode}): {proc.stderr.strip()[-400:]}"
        )
    return proc.stdout


def gh_json(path: str) -> Any:
    return json.loads(run(["gh", "api", path]))


def yq_json(path: str, file: Path) -> Any:
    return json.loads(run(["yq", "-o=json", path, str(file)]))


def yq_line(path: str, file: Path) -> int:
    return int(run(["yq", f"{path} | line", str(file)]).strip())


def fetch(url: str, dest: Path, cacert: Path | None = None) -> Path:
    args = ["curl", "-fsSL", *CURL_LIMITS, "--proto", "=https", "--retry", "3"]
    args += ["-o", str(dest)]
    if cacert:
        args += ["--cacert", str(cacert)]
    run([*args, url])
    return dest


def http_text(url: str, accept: str | None = None) -> str:
    args = ["curl", "-fsSL", *CURL_LIMITS, "--proto", "=https", "--retry", "3"]
    if accept:
        args += ["-H", f"Accept: {accept}"]
    return run([*args, url])


def http_json(url: str, accept: str | None = None) -> Any:
    return json.loads(http_text(url, accept))


def oci_head(url: str, token: str | None = None) -> tuple[int, dict[str, str]]:
    """HEAD an OCI registry URL: status and lower-cased headers of the final response."""
    args = ["curl", "-sSI", *CURL_LIMITS, "--proto", "=https", "--retry", "3"]
    args += ["-H", f"Accept: {OCI_ACCEPT}"]
    if token:
        args += ["-H", f"Authorization: Bearer {token}"]
    blocks = run([*args, url]).strip().split("\r\n\r\n")
    lines = blocks[-1].splitlines()
    headers = {
        k.strip().lower(): v.strip()
        for k, v in (ln.split(":", 1) for ln in lines[1:] if ":" in ln)
    }
    return int(lines[0].split()[1]), headers


def bearer_url(challenge: str) -> str:
    """The token URL a registry's WWW-Authenticate Bearer challenge names."""
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    query = {k: params[k] for k in ("service", "scope") if k in params}
    return f"{params['realm']}?{urlencode(query)}"


def oci_digest(image: str, tag: str) -> str | None:
    """Manifest digest of host/repo:tag, or None when the registry has no such tag."""
    host, _, repo = image.partition("/")
    url = f"https://{host}/v2/{repo}/manifests/{tag}"
    status, headers = oci_head(url)
    if status == 401:
        token = http_json(bearer_url(headers.get("www-authenticate", "")))["token"]
        status, headers = oci_head(url, token)
    if status == 404:
        return None
    digest = headers.get("docker-content-digest", "")
    if status != 200 or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise BumpError(f"{url} returned status {status} and no usable digest")
    return digest


def decoded_text(data: bytes) -> str:
    """UTF-8, or UTF-16 when a byte-order mark says so (PowerShell's hashes.sha256)."""
    return data.decode("utf-16" if data[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8")


def read_exact(path: Path) -> str:
    """The file's text with its line endings unchanged."""
    return path.read_bytes().decode("utf-8")


def write_exact(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8"))


def file_digest(path: Path, algo: str) -> str:
    return hashlib.new(algo, path.read_bytes()).hexdigest()


def parse_date(text: str) -> dt.datetime:
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


# ---------------------------------------------------------------- resolve


def list_releases(
    source: dict[str, Any], policy: dict[str, Any], now: dt.datetime
) -> list[Release]:
    prefix = source.get("tagPrefix", "")
    kind = source["type"]
    out: list[Release] = []
    if kind == "github-release":
        per_page = source.get("perPage", 100)
        for rel in gh_json(f"repos/{source['repo']}/releases?per_page={per_page}"):
            tag = rel["tag_name"]
            if rel["draft"] or rel["prerelease"] or not tag.startswith(prefix):
                continue
            version = tag[len(prefix) :]
            if parse_version(version) is not None and rel.get("published_at"):
                out.append(Release(version, tag, parse_date(rel["published_at"])))
        return out
    if kind == "github-tag":
        for tag in gh_json(f"repos/{source['repo']}/tags?per_page=100"):
            name = tag["name"]
            version = name[len(prefix) :] if name.startswith(prefix) else ""
            if parse_version(version) is not None:
                out.append(
                    Release(version, name, dt.datetime.max.replace(tzinfo=dt.UTC))
                )
        return out
    if kind == "pypi":
        return pypi_releases(
            http_json(f"https://pypi.org/pypi/{source['package']}/json")
        )
    if kind == "npm":
        return npm_releases(
            http_json(f"{NPM_REGISTRY}/{quote(source['package'], safe='@')}")
        )
    if kind == "goproxy":
        return goproxy_versions(
            http_text(f"{GOPROXY}/{goproxy_path(source['package'])}/@v/list")
        )
    if kind == "nuget":
        index = http_json(
            f"{NUGET_REGISTRATION}/{source['package'].lower()}/index.json"
        )
        # A large registration links its pages instead of inlining their leaves.
        pages = [p if "items" in p else http_json(p["@id"]) for p in index["items"]]
        return nuget_releases(pages)
    if kind == "psgallery":
        url: str | None = (
            f"{PSGALLERY}/FindPackagesById()?id='{source['package']}'"
            "&$orderby=Published%20desc"
        )
        while url:
            page, url = parse_psgallery(http_text(url))
            out += page
        return out
    if kind == "python-org":
        return cpython_releases(policy, now)
    raise BumpError(f"unknown source type {kind}")


def cpython_releases(policy: dict[str, Any], now: dt.datetime) -> list[Release]:
    """python.org stable releases that the newest uv past the patch cooldown can install.

    Lanes take uv's newest release on every apply (mise upgrade, winget), so a uv release
    past the cooldown is on every lane that applied since; its download metadata is the
    list of CPython builds, with their sha256, that uv installs.
    """
    wait = int(policy["cooldownDays"]["patch"]) * 86400
    uv = next(
        (
            r
            for r in gh_json("repos/astral-sh/uv/releases?per_page=30")
            if not r["draft"]
            and not r["prerelease"]
            and (now - parse_date(r["published_at"])).total_seconds() >= wait
        ),
        None,
    )
    if uv is None:
        raise BumpError("no astral-sh/uv release is past the cooldown")
    tag = uv["tag_name"]
    tree = gh_json(f"repos/astral-sh/uv/git/trees/{tag}?recursive=1")
    paths = [
        t["path"]
        for t in tree["tree"]
        if re.fullmatch(r"crates/[^/]+/download-metadata\.json", t["path"])
    ]
    if len(paths) != 1:
        raise BumpError(
            f"uv {tag} has {len(paths)} download-metadata.json files, not one"
        )
    builds = uv_cpython_builds(
        http_json(f"https://raw.githubusercontent.com/astral-sh/uv/{tag}/{paths[0]}")
    )
    out: list[Release] = []
    for rel in http_json(
        "https://www.python.org/api/v2/downloads/release/?is_published=true"
    ):
        version = rel["name"].removeprefix("Python ")
        if rel["pre_release"] or version not in builds:
            continue
        meta = {"uv": tag, "builds": builds[version], "slug": rel["slug"]}
        out.append(Release(version, version, parse_date(rel["release_date"]), meta))
    return out


def date_tags(
    source: dict[str, Any], releases: list[Release], current: str
) -> list[Release]:
    """github-tag and goproxy list no date; read it for versions above the pin only (the
    tagged commit's date, or the module proxy's `.info` Time)."""
    if source["type"] not in {"github-tag", "goproxy"}:
        return releases
    cur = parse_version(current) or ()
    dated: list[Release] = []
    for r in releases:
        if (parse_version(r.version) or ()) > cur:
            if source["type"] == "goproxy":
                info = http_json(
                    f"{GOPROXY}/{goproxy_path(source['package'])}/@v/{r.tag}.info"
                )
                date = parse_date(info["Time"])
            else:
                commit = gh_json(f"repos/{source['repo']}/commits/{r.tag}")
                date = parse_date(commit["commit"]["committer"]["date"])
            r = Release(r.version, r.tag, date, r.meta)
        dated.append(r)
    return dated


def with_image(
    source: dict[str, Any], releases: list[Release], current: str
) -> list[Release]:
    """Drop releases above the pin whose version has no tag in source.requireImage."""
    image = source.get("requireImage")
    if not image:
        return releases
    cur = parse_version(current) or ()
    return [
        r
        for r in releases
        if (parse_version(r.version) or ()) <= cur or oci_digest(image, r.version)
    ]


def release_url(source: dict[str, Any], release: Release) -> str:
    kind, v = source["type"], release.version
    if kind == "github-release":
        return f"https://github.com/{source['repo']}/releases/tag/{release.tag}"
    if kind == "github-tag":
        return f"https://github.com/{source['repo']}/tree/{release.tag}"
    if kind == "pypi":
        return f"https://pypi.org/project/{source['package']}/{v}/"
    if kind == "npm":
        return f"https://www.npmjs.com/package/{source['package']}/v/{v}"
    if kind == "psgallery":
        return f"https://www.powershellgallery.com/packages/{source['package']}/{v}"
    if kind == "goproxy":
        return f"https://pkg.go.dev/{source['package']}@{release.tag}"
    if kind == "nuget":
        return f"https://www.nuget.org/packages/{source['package']}/{v}"
    return f"https://www.python.org/downloads/release/{release.meta['slug']}/"


# ---------------------------------------------------------------- verify and compute new values


class Verifier:
    def __init__(
        self,
        name: str,
        tool: dict[str, Any],
        release: Release,
        work: Path,
        policy: dict[str, Any],
    ) -> None:
        self.name, self.tool, self.release, self.work = name, tool, release, work
        self.policy = policy
        self.verify = tool.get("verify", {})
        self.sums: dict[str, list[str]] | None = None
        self.cacert: Path | None = None
        self.notes: list[str] = []
        self.manifest: dict[str, Any] | None = None
        self.downloads: dict[str, Path] = {}
        self.assets: dict[str, Path] = {}

    def download_asset(self, asset: str) -> Path:
        """Each asset fetched once per bump, so every check reads the same bytes."""
        if asset not in self.assets:
            repo = self.tool["source"]["repo"]
            run(
                [
                    "gh",
                    "release",
                    "download",
                    self.release.tag,
                    "-R",
                    repo,
                    "-p",
                    asset,
                    "-D",
                    str(self.work),
                    "--clobber",
                ]
            )
            self.assets[asset] = self.work / asset
        return self.assets[asset]

    def download(self, url: str) -> Path:
        """Each url fetched once per bump, so a zip and its member hash read the same bytes."""
        if url not in self.downloads:
            self.downloads[url] = fetch(
                url, self.work / f"download-{len(self.downloads)}"
            )
        return self.downloads[url]

    def checksums(self) -> dict[str, list[str]]:
        if self.sums is not None:
            return self.sums
        spec = self.verify.get("checksums")
        if not spec:
            raise BumpError("a digest names an asset but verify.checksums is not set")
        path = self.download_asset(fill(spec["asset"], self.release.version))
        gpg = self.verify.get("signature", {}).get("gpg")
        if gpg:
            text = self.gpg_verified(path, gpg)
            self.notes.append(
                f"{path.name} signature checked against {gpg['fingerprint']}"
            )
        else:
            text = decoded_text(path.read_bytes())
            self.notes.append(f"sums from the release's {path.name}")
        self.sums = parse_sums(text)
        return self.sums

    def gpg_verified(self, signed: Path, gpg: dict[str, str]) -> str:
        keyring = self.work / "keyring.gpg"
        run(
            [
                "gpg",
                "--batch",
                "--yes",
                "--dearmor",
                "--output",
                str(keyring),
                str(self.policy["_dir"] / gpg["key"]),
            ]
        )
        plain = self.work / f"{signed.name}.txt"
        status = run(
            [
                "gpgv",
                "--keyring",
                str(keyring),
                "--status-fd",
                "1",
                "--output",
                str(plain),
                str(signed),
            ],
        )
        valid = [
            line.split()
            for line in status.splitlines()
            if line.startswith("[GNUPG:] VALIDSIG ")
        ]
        # VALIDSIG's last field is the primary key fingerprint.
        if not valid or any(v[-1].upper() != gpg["fingerprint"].upper() for v in valid):
            raise BumpError(f"{signed.name} is not signed by {gpg['fingerprint']}")
        return plain.read_text(encoding="utf-8")

    def ca(self) -> Path | None:
        script = self.verify.get("caFromScript")
        if not script:
            return None
        if self.cacert is None:
            text = fetch(script, self.work / "ca-script").read_text(encoding="utf-8")
            m = re.search(
                r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", text, re.S
            )
            if not m:
                raise BumpError(f"{script} embeds no certificate")
            self.cacert = self.work / "ca.pem"
            self.cacert.write_text(m.group(0) + "\n", encoding="utf-8")
            self.notes.append(f"digests fetched under the CA embedded in {script}")
        return self.cacert

    def digest(self, spec: dict[str, Any], version: str, path: str = "") -> str:
        algo = spec.get("algo", "sha256")
        if "asset" in spec:
            value = lookup_sum(
                self.checksums(), fill(spec["asset"], version, path), algo
            )
        elif "url" in spec:
            body = fetch(
                fill(spec["url"], version, path), self.work / "digest", self.ca()
            )
            value = (body.read_text(encoding="utf-8").split() or [""])[0].lower()
            if not re.fullmatch(rf"[0-9a-f]{{{HEX[algo]}}}", value):
                raise BumpError(f"{spec['url']} served no {algo}")
        elif "download" in spec:
            archive = self.download(fill(spec["download"], version, path))
            if "member" in spec:
                value = zip_member_digest(archive, fill(spec["member"], version), algo)
            else:
                value = file_digest(archive, algo)
        elif "assetFile" in spec:
            asset = self.download_asset(fill(spec["assetFile"], version, path))
            value = file_digest(asset, algo)
        elif "oci" in spec:
            found = oci_digest(spec["oci"], fill(spec.get("tag", "{version}"), version))
            if not found:
                raise BumpError(f"{spec['oci']} has no tag for {version}")
            value = found
        elif "manifest" in spec:
            value = self.manifest_value(spec["manifest"])
            # The value is written into a tracked file, so it must be exactly what the field is.
            if "pattern" not in spec or not re.fullmatch(spec["pattern"], value):
                raise BumpError(
                    f"manifest value at {spec['manifest']} fails its required pattern"
                )
        else:
            raise BumpError("a digest names no asset, url, download, oci or manifest")
        return apply_case(value, spec.get("case"))

    def manifest_value(self, path: str) -> str:
        """One string from the release's JSON manifest, whose bytes the checksums cover."""
        if self.manifest is None:
            spec = self.verify.get("manifest")
            if not spec:
                raise BumpError(
                    "a field reads the manifest but verify.manifest is not set"
                )
            name = fill(spec["asset"], self.release.version)
            file = self.download_asset(name)
            if file_digest(file, "sha256") != lookup_sum(
                self.checksums(), name, "sha256"
            ):
                raise BumpError(f"{name} does not match the release checksums")
            self.manifest = json.loads(file.read_text(encoding="utf-8"))
        value: Any = self.manifest
        for key in path.strip(".").split("."):
            value = value.get(key) if isinstance(value, dict) else None
        if not isinstance(value, str) or not value:
            raise BumpError(f"the release manifest has no string at {path}")
        return value

    def publisher(self) -> None:
        """Run the checks not derived from the release's own download."""
        if "authenticode" in self.verify:
            self.authenticode(self.verify["authenticode"])
        if "attestation" in self.verify:
            self.attestation(self.verify["attestation"])

    def authenticode(self, spec: dict[str, str]) -> None:
        name = fill(spec["asset"], self.release.version)
        file = self.download_asset(name)
        der = fetch(spec["caUrl"], self.work / "ca.der")
        if file_digest(der, "sha256") != spec["caSha256"].lower():
            raise BumpError(f"{spec['caUrl']} is not the pinned root certificate")
        ca = self.work / "ca.pem"
        run(["openssl", "x509", "-inform", "DER", "-in", str(der), "-out", str(ca)])
        proc = run_raw(["osslsigncode", "verify", "-CAfile", str(ca), "-in", str(file)])
        out = proc.stdout
        signer = re.search(r"Signer #0:\s*\n\s*Subject: (.+)", out)
        if (
            proc.returncode != 0
            or "Signature verification: ok" not in out
            or "Number of verified signatures: 1" not in out
            or signer is None
            or signer.group(1).strip() != spec["subject"]
        ):
            raise BumpError(
                f"{name}: Authenticode check failed against {spec['subject']}"
            )
        if file_digest(file, "sha256") != lookup_sum(self.checksums(), name, "sha256"):
            raise BumpError(f"{name} does not match the release checksums")
        self.notes.append(f"Authenticode signer checked: {spec['subject']}")

    def attestation(self, spec: dict[str, Any]) -> None:
        common = [
            *["--repo", spec["repo"], "--signer-workflow", spec["signerWorkflow"]],
            *["--source-ref", f"refs/tags/{self.release.tag}"],
            "--deny-self-hosted-runners",
        ]
        if "sourceDigest" in spec:
            sha = self.manifest_value(spec["sourceDigest"])
            common += ["--signer-digest", sha, "--source-digest", sha]
        subjects = [
            str(self.download_asset(fill(a, self.release.version)))
            for a in spec.get("assets", [])
        ]
        oci = spec.get("oci")
        if oci:
            image = self.manifest_value(oci["image"])
            subjects.append(f"oci://{image}@{self.manifest_value(oci['digest'])}")
        for subject in subjects:
            run(["gh", "attestation", "verify", subject, *common])
        self.notes.append(
            f"{len(subjects)} subjects attested by {spec['signerWorkflow']}"
        )

    def registry(self) -> None:
        """Check and record the registry's own integrity data for the chosen version."""
        source, rel = self.tool["source"], self.release
        kind = source["type"]
        if kind == "pypi":
            self.notes.append(self.pypi_note(source["package"], rel))
        elif kind == "npm":
            self.notes.append(self.npm_note(source["package"], rel))
        elif kind == "psgallery":
            self.notes.append(self.psgallery_note(source["package"], rel))
        elif kind == "goproxy":
            self.notes.append(self.gosum_note(source["package"], rel))
        elif kind == "nuget":
            self.notes.append(self.nuget_note(source["package"], rel))
        elif kind == "python-org":
            self.notes.append(
                f"python.org stable release; uv {rel.meta['uv']}'s download metadata"
                + f" carries a sha256 for {rel.meta['builds']} CPython {rel.version} builds"
            )

    @staticmethod
    def pypi_note(package: str, rel: Release) -> str:
        files = [
            f
            for f in rel.meta
            if re.fullmatch(r"[0-9a-f]{64}", f["digests"].get("sha256", ""))
        ]
        if len(files) != len(rel.meta):
            raise BumpError(f"PyPI lists a {package} {rel.version} file with no sha256")
        simple = http_json(
            f"https://pypi.org/simple/{package}/", "application/vnd.pypi.simple.v1+json"
        )
        names = {f["filename"] for f in files}
        listed = {f["filename"]: f for f in simple["files"] if f["filename"] in names}
        for f in files:
            if (
                listed.get(f["filename"], {}).get("hashes", {}).get("sha256")
                != f["digests"]["sha256"]
            ):
                raise BumpError(
                    f"PyPI's JSON and simple APIs disagree on {f['filename']}"
                )
        attested = sum(1 for f in listed.values() if f.get("provenance"))
        return (
            f"PyPI: {len(files)} files, each with a sha256 the JSON and simple APIs agree on; "
            f"{attested} with a PEP 740 attestation. The pin carries no hash, so the digest is "
            "checked at bump time only"
        )

    def npm_note(self, package: str, rel: Release) -> str:
        dist = rel.meta.get("dist", {})
        integrity = dist.get("integrity", "")
        if not integrity.startswith("sha512-"):
            raise BumpError(
                f"npm lists no sha512 dist.integrity for {package}@{rel.version}"
            )
        keys: dict[str, str] = self.policy["npmRegistryKeys"]
        sigs = [s for s in dist.get("signatures", []) if s.get("keyid") in keys]
        if not sigs:
            raise BumpError(
                f"{package}@{rel.version} carries no signature by a committed npm key"
            )
        message = self.work / "npm-message"
        message.write_bytes(npm_signed_message(package, rel.version, integrity))
        for i, sig in enumerate(sigs):
            pem = self.work / f"npm-key-{i}.pem"
            pem.write_text(
                f"-----BEGIN PUBLIC KEY-----\n{keys[sig['keyid']]}\n-----END PUBLIC KEY-----\n",
                encoding="utf-8",
            )
            der = self.work / f"npm-sig-{i}.der"
            der.write_bytes(base64.b64decode(sig["sig"]))
            proc = run_raw(
                [
                    "openssl",
                    "dgst",
                    "-sha256",
                    "-verify",
                    str(pem),
                    "-signature",
                    str(der),
                    str(message),
                ]
            )
            if proc.returncode != 0:
                raise BumpError(
                    f"{package}@{rel.version} registry signature {sig['keyid']} fails"
                )
        attested = (
            "a provenance attestation"
            if dist.get("attestations")
            else "no provenance attestation"
        )
        return (
            f"npm: dist.integrity {integrity[:19]}..., registry signature verified against "
            f"{sigs[0]['keyid']}; {attested}"
        )

    def psgallery_note(self, package: str, rel: Release) -> str:
        meta = rel.meta
        if not meta.get("hash") or not meta.get("algo"):
            raise BumpError(
                f"PSGallery lists no PackageHash for {package} {rel.version}"
            )
        nupkg = self.download(f"{PSGALLERY}/package/{package}/{rel.version}")
        if not nupkg_hash_matches(nupkg.read_bytes(), meta["hash"], meta["algo"]):
            raise BumpError(
                f"{package} {rel.version} .nupkg does not match its PackageHash"
            )
        return f"PSGallery: the .nupkg matches its {meta['algo']} PackageHash"

    @staticmethod
    def gosum_note(module: str, rel: Release) -> str:
        record = http_text(f"{GOSUMDB}/lookup/{goproxy_path(module)}@{rel.tag}")
        hashes = [
            line
            for line in record.splitlines()
            if re.fullmatch(
                rf"{re.escape(module)} {re.escape(rel.tag)}(/go\.mod)? h1:\S+", line
            )
        ]
        if len(hashes) != 2:
            raise BumpError(
                f"sum.golang.org has no module and go.mod hash for {module}@{rel.tag}"
            )
        return (
            f"sum.golang.org records {module}@{rel.tag}; go install checks the module "
            "against it at install"
        )

    def nuget_note(self, package: str, rel: Release) -> str:
        leaf = http_json(rel.meta["catalog"])
        package_hash, algo = leaf.get("packageHash"), leaf.get("packageHashAlgorithm")
        if not package_hash or not algo:
            raise BumpError(f"NuGet lists no packageHash for {package} {rel.version}")
        nupkg = self.download(rel.meta["nupkg"])
        if not nupkg_hash_matches(nupkg.read_bytes(), package_hash, algo):
            raise BumpError(
                f"{package} {rel.version} .nupkg does not match its packageHash"
            )
        return f"NuGet: the .nupkg matches its catalog {algo} packageHash"

    def verification(self) -> str:
        if "note" in self.verify:
            self.notes.insert(0, self.verify["note"])
        if "unverified" in self.verify:
            self.notes.insert(0, f"unverified: {self.verify['unverified']}")
        return "; ".join(dict.fromkeys(self.notes)) or "none"


def zip_member_digest(archive: Path, member: str, algo: str) -> str:
    with zipfile.ZipFile(archive) as zf:
        try:
            data = zf.read(member)
        except KeyError:
            raise BumpError(f"{archive.name} has no member {member}") from None
    return hashlib.new(algo, data).hexdigest()


def planned_edits(
    name: str,
    tool: dict[str, Any],
    release: Release,
    work: Path,
    policy: dict[str, Any],
) -> tuple[list[dict[str, Any]], str]:
    """[{path, old, new, line}] for every scalar the bump rewrites, and the verification note."""
    file = Path(tool["file"])
    version = release.version
    verifier = Verifier(name, tool, release, work, policy)
    verifier.registry()
    edits = [
        {
            "path": tool["version"],
            "new": fill(tool.get("format", "{version}"), version),
            "file": tool["file"],
        }
    ]
    for item in tool.get("fields", []):
        new = (
            fill(item["template"], version)
            if "template" in item
            else verifier.digest(item["digest"], version)
        )
        edits.append(
            {"path": item["path"], "new": new, "file": item.get("file", tool["file"])}
        )
    listing = tool.get("fileList")
    if listing:
        edits += file_list_edits(tool, listing, release, verifier, file)
    verifier.publisher()
    for edit in edits:
        pin_file = Path(edit["file"])
        text = read_exact(pin_file)
        if isinstance(edit["path"], dict):
            edit["old"], edit["line"] = regex_pin(text, edit["path"]["regex"])
            continue
        edit["old"] = yq_json(edit["path"], pin_file)
        if not isinstance(edit["old"], str):
            raise BumpError(f"{edit['path']} is not a string scalar in {pin_file}")
        edit["line"] = locate_line(
            text, edit["path"], edit["old"], yq_line(edit["path"], pin_file)
        )
    if tool.get("reportUnpinned"):
        pinned = {
            fill(f["digest"]["asset"], version)
            for f in tool["fields"]
            if "asset" in f.get("digest", {})
        }
        extra = sorted(set(verifier.checksums()) - pinned)
        verifier.notes.append(
            f"release assets not pinned: {', '.join(extra) or 'none'}"
        )
    return edits, verifier.verification()


def file_list_edits(
    tool: dict[str, Any],
    listing: dict[str, str],
    release: Release,
    verifier: Verifier,
    file: Path,
) -> list[dict[str, Any]]:
    entries = yq_json(listing["path"], file)
    tree = gh_json(
        f"repos/{tool['source']['repo']}/git/trees/{release.tag}?recursive=1"
    )
    match = re.compile(listing["treeMatch"])
    upstream = {
        t["path"]
        for t in tree["tree"]
        if t["type"] == "blob" and match.search(t["path"])
    }
    listed = {e["path"] for e in entries if match.search(e["path"])}
    if upstream != listed:
        added, gone = sorted(upstream - listed), sorted(listed - upstream)
        raise BumpError(
            f"{release.tag} changes the file list (added {added}, removed {gone}); edit it by hand"
        )
    edits: list[dict[str, Any]] = []
    for i, entry in enumerate(entries):
        url = fill(listing["url"], release.version, entry["path"])
        edits.append(
            {"path": f"{listing['path']}[{i}].url", "new": url, "file": tool["file"]}
        )
        sha = file_digest(fetch(url, verifier.work / "file"), "sha256")
        edits.append(
            {"path": f"{listing['path']}[{i}].sha256", "new": sha, "file": tool["file"]}
        )
    return edits


# ---------------------------------------------------------------- rewrite


def rewrite(edits: list[dict[str, Any]]) -> None:
    for name in dict.fromkeys(e["file"] for e in edits):
        file = Path(name)
        text = read_exact(file)
        for edit in (e for e in edits if e["file"] == name):
            if edit["old"] != edit["new"]:
                text = replace_on_line(text, edit["line"], edit["old"], edit["new"])
        write_exact(file, text)


def run_hooks(
    policy: dict[str, Any], ready: list[tuple[dict[str, Any], dict[str, Any], Any]]
) -> None:
    """Run the policy's afterBump commands; each reads the bump from VERSION_BUMP_READY."""
    payload = [
        {"name": row["tool"], "version": row["target"], "tool": tool}
        for row, tool, _ in ready
    ]
    env = {"VERSION_BUMP_READY": json.dumps(payload)}
    for argv in policy.get("afterBump", []):
        run(argv, env=env)


def changed_paths() -> list[str]:
    """Tracked files the bump rewrote; a bump never adds a file."""
    return run(["git", "diff", "--name-only"]).split()


# ---------------------------------------------------------------- commands


def synced_cooldown_days(path: Path, policy_path: Path) -> dict[str, int]:
    """cooldownDays from the standards dependabot-policy copy the standards sync places here."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(
            f"{policy_path} sets no cooldownDays and {path} is absent: the repository must"
            " receive the standards dependabot-policy sync component or set cooldownDays"
        ) from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}") from None
    days = doc.get("cooldownDays") if isinstance(doc, dict) else None
    if not isinstance(days, dict) or not all(
        type(days.get(c)) is int and days[c] >= 0 for c in COOLDOWN_CLASSES
    ):
        raise SystemExit(
            f"{path} cooldownDays must give a non-negative integer for each of"
            f" {', '.join(COOLDOWN_CLASSES)}"
        )
    return {c: days[c] for c in COOLDOWN_CLASSES}


def load_policy(path: Path, dependabot_policy: Path) -> dict[str, Any]:
    """The version-bump policy; its own cooldownDays wins over the synced org policy's."""
    policy: dict[str, Any] = yq_json(".", path)
    policy["_dir"] = path.resolve().parent
    if "cooldownDays" not in policy:
        policy["cooldownDays"] = synced_cooldown_days(dependabot_policy, path)
    return policy


def read_pin(path: str | dict[str, str], file: Path) -> Any:
    if isinstance(path, dict):
        return regex_pin(read_exact(file), path["regex"])[0]
    return yq_json(path, file)


def selected_tools(policy: dict[str, Any], only: str) -> dict[str, dict[str, Any]]:
    """The tools named (a group name selects all of its tools), else every tool."""
    tools = policy["tools"]
    if not only.strip():
        return tools
    names = [n.strip() for n in only.split(",") if n.strip()]
    groups = group_units(tools)
    unknown = [n for n in names if n not in tools and n not in groups]
    if unknown:
        raise SystemExit(f"unknown tools: {', '.join(unknown)}")
    wanted = {t for n in names for t in groups.get(n, [n])}
    return {n: t for n, t in tools.items() if n in wanted}


def iso(d: dt.datetime | None) -> str | None:
    return None if d is None or d.year == dt.MAXYEAR else d.isoformat()


def resolve_tool(
    row: dict[str, Any],
    tool: dict[str, Any],
    policy: dict[str, Any],
    now: dt.datetime,
    work: Path,
) -> list[dict[str, Any]] | None:
    """Fill row in place, so a failure part way keeps what was measured; the edits, if any."""
    name = row["tool"]
    scalar = read_pin(tool["version"], Path(tool["file"]))
    row["current"] = pinned_version(tool, str(scalar))
    releases = with_image(
        tool["source"],
        date_tags(
            tool["source"], list_releases(tool["source"], policy, now), row["current"]
        ),
        row["current"],
    )
    sel = select(releases, row["current"], policy, tool, now)
    if sel.beyond_line:
        row["latestOutsideLine"] = sel.beyond_line.version
    row |= {
        "latest": sel.latest.version if sel.latest else row["current"],
        "latestDate": iso(sel.latest.date) if sel.latest else None,
        "daysBehind": days_between(
            sel.oldest_newer.date if sel.oldest_newer else None, now
        ),
        "cooldownDays": sel.cooldown,
        "cooldownApplied": bool(sel.latest and sel.chosen != sel.latest),
        "exception": None,
        "target": sel.chosen.version if sel.chosen else None,
    }
    if sel.chosen is None:
        row["outcome"] = "current" if sel.latest is None else "held-by-cooldown"
        return None
    row["sourceType"] = tool["source"]["type"]
    row["targetCooldown"] = cooldown_days(
        policy, tool, row["current"], sel.chosen.version
    )
    work.mkdir(parents=True, exist_ok=True)
    edits, verification = planned_edits(name, tool, sel.chosen, work, policy)
    row["verification"] = verification
    row["edits"] = [
        {"path": pin_label(e["path"]), "old": e["old"], "new": e["new"]} for e in edits
    ]
    row["releaseUrl"] = release_url(tool["source"], sel.chosen)
    row["outcome"] = "resolved"
    return edits


def apply_bump(
    bump: dict[str, Any],
    ready: list[tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]],
    out: Path,
    policy: dict[str, Any],
) -> None:
    """Rewrite every ready pin of one bump, run the hooks and capture the changed files."""
    try:
        for _, _, edits in ready:
            rewrite(edits)
        run_hooks(policy, ready)
        paths = changed_paths()
        # Saved flat, by position in paths: --out may sit inside the source tree, where a
        # captured copy could be read as data by the next bump's afterBump hook.
        dest = out / "bumps" / bump["name"] / "files"
        dest.mkdir(parents=True, exist_ok=True)
        for i, p in enumerate(paths):
            shutil.copyfile(p, dest / str(i))
        bump["paths"] = paths
    finally:
        tracked = run(["git", "diff", "--name-only"]).split()
        if tracked:
            run(["git", "restore", "--source=HEAD", "--", *tracked])


def prepare_bump(
    unit: str,
    names: list[str],
    tools: dict[str, dict[str, Any]],
    policy: dict[str, Any],
    now: dt.datetime,
    out: Path,
    dry_run: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    bump: dict[str, Any] = {
        "name": unit,
        "branch": f"{BRANCH_PREFIX}{unit}",
        "tools": names,
    }
    rows: list[dict[str, Any]] = []
    ready: list[tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]] = []
    with tempfile.TemporaryDirectory(dir=out) as tmp:
        for name in names:
            tool = tools[name]
            row: dict[str, Any] = {
                "tool": name,
                "bump": unit,
                "class": tool.get("class"),
                "file": tool.get("file"),
            }
            try:
                edits = resolve_tool(row, tool, policy, now, Path(tmp) / name)
                if edits is not None:
                    ready.append((row, tool, edits))
            except Exception as exc:  # noqa: BLE001  # one tool's bad data must not end the run
                row["outcome"], row["detail"] = "failed", failure_text(exc)
            rows.append(row)
            print(
                json.dumps({k: v for k, v in row.items() if k != "edits"}), flush=True
            )
            for edit in row.get("edits", []):
                print(f"  {edit['path']}: {edit['old']} -> {edit['new']}")
        bump["targets"] = targets_marker([r for r, _, _ in ready])
        if ready:
            if dry_run:
                bump["outcome"] = "dry-run"
            else:
                try:
                    apply_bump(bump, ready, out, policy)
                    bump["outcome"] = "prepared"
                except Exception as exc:  # noqa: BLE001  # recorded as this bump's failure
                    bump["outcome"], bump["detail"] = "failed", failure_text(exc)
            for row, _, _ in ready:
                row["outcome"] = (
                    "failed" if bump["outcome"] == "failed" else bump["outcome"]
                )
                if bump.get("detail"):
                    row["detail"] = bump["detail"]
        elif all(r["outcome"] in {"current", "held-by-cooldown"} for r in rows):
            # A pin made current by another route leaves the bot's pull request stale.
            stale = bot_prs(bump["branch"])
            if stale:
                bump["stalePr"] = stale[0]["number"]
                bump["outcome"] = "dry-run" if dry_run else "stale-pr"
    bump.setdefault("outcome", "none")
    return bump, rows


def cmd_prepare(args: argparse.Namespace) -> int:
    # Each bump captures and then restores every changed tracked file, so it needs a
    # clean tree: uncommitted work would be swept into the bump and then lost.
    if not args.dry_run and changed_paths():
        raise SystemExit("prepare needs a clean tree; commit or stash first")
    policy = load_policy(Path(args.policy), Path(args.dependabot_policy))
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    now = parse_date(args.now) if args.now else dt.datetime.now(dt.UTC)
    tools = selected_tools(policy, args.only)
    rows: list[dict[str, Any]] = []
    bumps: list[dict[str, Any]] = []
    for unit, names in group_units(tools).items():
        bump, unit_rows = prepare_bump(
            unit, names, tools, policy, now, out, args.dry_run
        )
        bumps.append(bump)
        rows += unit_rows
    rows.extend(
        {"tool": exc["tool"], "exception": exc["reason"], "outcome": "exception"}
        for exc in policy.get("exceptions", [])
    )
    results = {
        "generatedAt": now.isoformat(),
        "repository": os.environ.get("GITHUB_REPOSITORY"),
        "policy": args.policy,
        "prNotes": policy.get("prNotes", []),
        "tools": rows,
        "bumps": bumps,
    }
    (out / "results.json").write_text(
        json.dumps(results, indent=2) + "\n", encoding="utf-8"
    )
    return 0


# ---------------------------------------------------------------- publish


def pr_title(bump: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    if len(rows) == 1:
        return f"chore(deps): bump {rows[0]['tool']} to {rows[0]['target']}"
    return f"chore(deps): bump {len(rows)} {bump['name']} pins"


def pr_body(
    bump: dict[str, Any],
    rows: list[dict[str, Any]],
    workflow_url: str,
    policy_path: str,
    notes: list[str],
) -> str:
    summary = "\n".join(
        f"- {r['tool']} {r['current']} -> {r['target']} ([release]({r['releaseUrl']})),"
        + f" a {r['class']} release past its {r['targetCooldown']}-day cooldown"
        for r in rows
    )
    changes = "\n".join(
        f"- `{e['path']}`: `{e['old']}` -> `{e['new']}`"
        for r in rows
        for e in r["edits"]
    )
    verification = "\n".join(f"- {r['tool']}: {r['verification']}" for r in rows)
    files = "\n".join(f"- `{p}`" for p in bump["paths"])
    note_lines = "".join(f"- {n}\n" for n in notes)
    return f"""No related issue: scheduled pin bump under `{policy_path}`.

## Summary

{summary}

## Fix

{changes}

Files:
{files}

## Verification

{verification}
{note_lines}
## Related

- Opened by {workflow_url}

<!-- version-bump-targets: {bump["targets"]} -->
"""


def bot_prs(branch: str, repo: str | None = None) -> list[dict[str, Any]]:
    """Open same-repository pull requests from branch authored by a bot account.

    `gh pr list --head` matches the branch name only, so a fork's branch of the same
    name is filtered out here.
    """
    fields = "number,title,body,mergeable,isCrossRepository,author"
    args = ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", fields]
    if repo:
        args += ["-R", repo]
    prs: list[dict[str, Any]] = json.loads(run(args))
    return [p for p in prs if not p["isCrossRepository"] and p["author"].get("is_bot")]


def own_prs(branch: str, repo: str, app_slug: str) -> list[dict[str, Any]]:
    """The bot's own pull requests from branch: gh names an App author app/<slug>."""
    logins = {f"app/{app_slug}", f"{app_slug}[bot]"}
    return [p for p in bot_prs(branch, repo) if p["author"]["login"] in logins]


def tag_cooldown(rows: list[dict[str, Any]]) -> int:
    """Longest cooldown among a bump's author-dated rows, run again from the bot's commit."""
    return max(
        (int(r["targetCooldown"]) for r in rows if r.get("sourceType") in AUTHOR_DATED),
        default=0,
    )


def has_major(rows: list[dict[str, Any]]) -> bool:
    """Whether any row moves to a release of class major, a 0.x minor move included."""
    return any(change_class(r["current"], r["target"]) == "major" for r in rows)


def arm_auto_merge(bump: dict[str, Any], repo: str, tip: dict[str, Any]) -> None:
    """Arm auto-merge, except while a tag source in the bump is still inside its cooldown.

    A tag's commit date (and the module proxy's .info Time for a git-sourced module) is set
    by whoever made the commit, so for those sources the cooldown also runs from the bot's
    own commit, whose date GitHub sets. A bump holding a major move is never armed: the org
    update policy sends majors to review, so its pull request waits for a person.
    """
    if bump.get("hasMajor"):
        run_raw(["gh", "pr", "merge", str(bump["pr"]), "-R", repo, "--disable-auto"])
        bump["autoMerge"] = False
        bump["detail"] = "a major release waits for review"
        return
    wait = int(bump.get("tagCooldown", 0))
    if wait:
        age = dt.datetime.now(dt.UTC) - parse_date(tip["date"])
        if age.total_seconds() < wait * 86400:
            # A pull request rebuilt for a newer tag may still carry an earlier arm.
            # Disabling it where none is armed fails harmlessly, so the exit is ignored.
            run_raw(
                ["gh", "pr", "merge", str(bump["pr"]), "-R", repo, "--disable-auto"]
            )
            bump["autoMerge"] = False
            bump["detail"] = "auto-merge waits for the cooldown from first sighting"
            return
    run(["gh", "pr", "merge", str(bump["pr"]), "-R", repo, "--auto", "--squash"])
    bump["autoMerge"] = True


def publish_bump(
    bump: dict[str, Any],
    rows: list[dict[str, Any]],
    out: Path,
    repo: str,
    base: str,
    app_slug: str,
    workflow_url: str,
    results: dict[str, Any],
    base_branch: str,
) -> None:
    branch = bump["branch"]
    title = pr_title(bump, rows)
    bump["tagCooldown"] = tag_cooldown(rows)
    bump["hasMajor"] = has_major(rows)
    prs = own_prs(branch, repo, app_slug)
    tip = branch_tip(repo, branch, f"{app_slug}[bot]")
    marker = TARGETS_MARKER.search(prs[0].get("body") or "") if prs else None
    if (
        prs
        and tip
        and marker
        and marker.group(1) == bump["targets"]
        and prs[0]["mergeable"] != "CONFLICTING"
    ):
        # Re-armed every run, so a failed arm on an earlier run recovers.
        bump["outcome"], bump["pr"] = "already-open", prs[0]["number"]
        arm_auto_merge(bump, repo, tip)
        return
    commit = signed_commit(bump, out, repo, base, title, results["policy"])
    update_ref(repo, branch, tip["sha"] if tip else "0" * 40, commit["sha"])
    body = out / "bumps" / bump["name"] / "body.md"
    text = pr_body(bump, rows, workflow_url, results["policy"], results["prNotes"])
    body.write_text(text, encoding="utf-8")
    if prs:
        number = prs[0]["number"]
        run(
            [
                *["gh", "pr", "edit", str(number), "-R", repo],
                *["--title", title, "--body-file", str(body)],
            ]
        )
        bump["outcome"] = "pr-updated"
    else:
        url = run(
            [
                *["gh", "pr", "create", "-R", repo, "--base", base_branch],
                *["--head", branch],
                *["--title", title, "--body-file", str(body)],
            ]
        ).strip()
        number = int(url.rsplit("/", 1)[-1])
        bump["outcome"] = "pr-opened"
    bump["pr"] = number
    arm_auto_merge(bump, repo, commit)


def branch_tip(repo: str, branch: str, app_login: str) -> dict[str, Any] | None:
    """{sha, date} of the branch tip when this bot made it; None when absent.

    Fails on a tip carrying anyone else's commit.
    """
    proc = run_raw(["gh", "api", f"repos/{repo}/branches/{branch}", "--jq", ".commit"])
    if proc.returncode != 0:
        if "HTTP 404" in proc.stderr:
            return None
        raise BumpError(f"could not read {branch}: {proc.stderr.strip()}")
    tip: dict[str, Any] = json.loads(proc.stdout)
    author: dict[str, Any] = tip.get("author") or {}
    login = author.get("login")
    if login != app_login or tip["commit"]["committer"]["email"] != SIGNER_EMAIL:
        raise BumpError(
            f"{branch} carries a commit not made by {app_login}; merge or delete it, then re-run"
        )
    return {"sha": tip["sha"], "date": tip["commit"]["committer"]["date"]}


def signed_commit(
    bump: dict[str, Any], out: Path, repo: str, base: str, title: str, policy_path: str
) -> dict[str, Any]:
    """Create the GitHub-signed commit; returns its {sha, date}."""
    files = out / "bumps" / bump["name"] / "files"
    entries: list[dict[str, str]] = []
    index = out / "bumps" / bump["name"] / "index"
    env = {"GIT_INDEX_FILE": str(index)}
    run(["git", "read-tree", base], env=env)
    for i, path in enumerate(bump["paths"]):
        content = read_exact(files / str(i))
        staged = run(["git", "ls-files", "-s", "--", path]).split()
        mode = staged[0] if staged else "100644"
        entries.append({"path": path, "mode": mode, "type": "blob", "content": content})
        blob = run(["git", "hash-object", "-w", "--stdin"], input_text=content).strip()
        run(
            ["git", "update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}"],
            env=env,
        )
    expected = run(["git", "write-tree"], env=env).strip()
    base_tree = run(["git", "rev-parse", f"{base}^{{tree}}"]).strip()
    tree = json.loads(
        run(
            ["gh", "api", f"repos/{repo}/git/trees", "--input", "-"],
            input_text=json.dumps({"base_tree": base_tree, "tree": entries}),
        )
    )["sha"]
    # Same tree id as the local index proves GitHub stored the exact bytes.
    if tree != expected:
        raise BumpError(f"GitHub's tree {tree} differs from the local tree {expected}")
    message = f"{title}\n\nOpened by the version-bump bot under {policy_path}.\n"
    commit = json.loads(
        run(
            ["gh", "api", f"repos/{repo}/git/commits", "--input", "-"],
            input_text=json.dumps(
                {"message": message, "tree": tree, "parents": [base]}
            ),
        )
    )
    if (
        not commit["verification"]["verified"]
        or commit["committer"]["email"] != SIGNER_EMAIL
    ):
        raise BumpError(
            f"commit {commit['sha']} came back unsigned or not committed by GitHub"
        )
    return {"sha": commit["sha"], "date": commit["committer"]["date"]}


def update_ref(repo: str, branch: str, before: str, after: str) -> None:
    node = run(["gh", "api", f"repos/{repo}", "--jq", ".node_id"]).strip()
    # beforeOid is a lease: refused if the branch moved since branch_tip read it.
    query = (
        "mutation($repo: ID!, $name: GitRefname!, $before: GitObjectID!, $after: GitObjectID!) {"
        " updateRefs(input: {repositoryId: $repo, refUpdates: [{name: $name, beforeOid: $before,"
        " afterOid: $after, force: true}]}) { clientMutationId } }"
    )
    run(
        [
            *["gh", "api", "graphql", "-f", f"query={query}", "-f", f"repo={node}"],
            *["-f", f"name=refs/heads/{branch}", "-f", f"before={before}"],
            *["-f", f"after={after}"],
        ]
    )


def close_stale(bump: dict[str, Any], repo: str, app_slug: str) -> None:
    """Close the bot's pull request for pins now current; its branch goes with it."""
    branch = bump["branch"]
    branch_tip(repo, branch, f"{app_slug}[bot]")  # refuses a foreign commit
    if bump["stalePr"] not in {p["number"] for p in own_prs(branch, repo, app_slug)}:
        raise BumpError(f"#{bump['stalePr']} is not this bot's pull request")
    number = str(bump["stalePr"])
    comment = (
        "Every pin in this bump is at its newest release past the cooldown; closing."
    )
    run(
        [
            "gh",
            "pr",
            "close",
            number,
            "-R",
            repo,
            "--comment",
            comment,
            "--delete-branch",
        ]
    )
    bump["outcome"], bump["pr"] = "stale-pr-closed", bump["stalePr"]


def checked_out_default_branch(repo: str, head: str) -> str:
    """The default branch; refuses a checkout with commits that branch does not have.

    Each bump commit is parented on the checkout and opened against the default branch, so
    a checkout ahead of it would carry those commits into the auto-merged pull request.
    """
    branch = run(["gh", "api", f"repos/{repo}", "--jq", ".default_branch"]).strip()
    compare = f"repos/{repo}/compare/{branch}...{head}"
    ahead = int(run(["gh", "api", compare, "--jq", ".ahead_by"]).strip())
    if ahead:
        raise SystemExit(
            f"publish needs a checkout of {branch}: HEAD is {ahead} commit(s) ahead of it"
        )
    return branch


def cmd_publish(args: argparse.Namespace) -> int:
    out = Path(args.out).resolve()
    results = json.loads((out / "results.json").read_text(encoding="utf-8"))
    repo = os.environ["GITHUB_REPOSITORY"]
    base = run(["git", "rev-parse", "HEAD"]).strip()
    base_branch = checked_out_default_branch(repo, base)
    workflow_url = os.environ.get("RUN_URL", "the version-bump workflow")
    for bump in results["bumps"]:
        if bump.get("outcome") not in {"prepared", "stale-pr"}:
            continue
        rows = [
            r
            for r in results["tools"]
            if r.get("bump") == bump["name"] and r.get("outcome") == "prepared"
        ]
        try:
            if bump["outcome"] == "stale-pr":
                close_stale(bump, repo, args.app_slug)
            else:
                publish_bump(
                    bump,
                    rows,
                    out,
                    repo,
                    base,
                    args.app_slug,
                    workflow_url,
                    results,
                    base_branch,
                )
        except Exception as exc:  # noqa: BLE001  # recorded as this bump's failure
            bump["outcome"], bump["detail"] = "failed", failure_text(exc)
        for r in rows:
            r["outcome"], r["pr"] = bump["outcome"], bump.get("pr")
            if bump.get("detail"):
                r["detail"] = bump["detail"]
        print(
            json.dumps(
                {k: bump.get(k) for k in ("name", "targets", "outcome", "pr", "detail")}
            ),
            flush=True,
        )
    (out / "results.json").write_text(
        json.dumps(results, indent=2) + "\n", encoding="utf-8"
    )
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    results = json.loads((Path(args.out) / "results.json").read_text(encoding="utf-8"))
    lines = [
        "## Version bumps",
        "",
        "| " + " | ".join(SUMMARY_COLUMNS) + " |",
        "|" + "---|" * len(SUMMARY_COLUMNS),
    ]
    for r in results["tools"]:
        cooldown = (
            f"{r['cooldownDays']}d{' (held)' if r.get('cooldownApplied') else ''}"
            if "cooldownDays" in r
            else ""
        )
        outcome = r.get("outcome", "")
        if r.get("pr"):
            outcome += f" #{r['pr']}"
        if r.get("detail"):
            outcome += f": {r['detail']}"
        latest = r.get("latest", "")
        if r.get("latestOutsideLine"):
            latest += f" ({r['latestOutsideLine']} outside the pinned line)"
        cells = [
            r["tool"],
            r.get("current", ""),
            latest,
            (r.get("latestDate") or "")[:10],
            r.get("target") or "",
        ]
        cells += [
            str(r.get("daysBehind", "")),
            cooldown,
            r.get("exception") or "",
            outcome.replace("|", "\\|"),
        ]
        lines.append("| " + " | ".join(cells) + " |")
    text = "\n".join(lines) + "\n"
    target = os.environ.get("GITHUB_STEP_SUMMARY")
    if target:
        with Path(target).open("a", encoding="utf-8") as fh:
            fh.write(text)
    else:
        print(text)
    failed = [r["tool"] for r in results["tools"] if r.get("outcome") == "failed"]
    failed += [
        f"bump {b['name']}"
        for b in results.get("bumps", [])
        if b.get("outcome") == "failed"
    ]
    if failed:
        print(
            f"::error::Version bump failed for: {', '.join(dict.fromkeys(failed))}",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--policy", required=True, help="policy file, relative to the root")
    p.add_argument(
        "--dependabot-policy",
        default=DEPENDABOT_POLICY,
        help="synced org policy giving cooldownDays when the policy file sets none",
    )
    p.add_argument("--out", required=True)
    p.add_argument("--only", default="", help="comma-separated tool or group names")
    p.add_argument(
        "--dry-run", action="store_true", help="resolve and verify, write nothing"
    )
    p.add_argument("--now", help="ISO time to judge cooldowns against (tests)")
    p.set_defaults(func=cmd_prepare)
    p = sub.add_parser("publish")
    p.add_argument("--out", required=True)
    p.add_argument("--app-slug", required=True)
    p.set_defaults(func=cmd_publish)
    p = sub.add_parser("summary")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_summary)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
