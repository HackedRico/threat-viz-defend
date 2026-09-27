import io
import re
import tarfile
from dataclasses import dataclass, replace
from datetime import datetime

import httpx

from app.boards.ingest import PROSE_CHARS, Material, SourceItem, build_material, path_rank
from app.domain.masking import MAX_FILE_BYTES, MAX_FILES, skip_reason
from app.errors import bad_request

# =============================================================================
# Module Overview
# =============================================================================
# Reads a public GitHub repository without cloning it. `parse_repo_url` accepts
# only github.com URLs, so the server never fetches an address a user chose;
# `fetch_repo` downloads the tarball from GitHub's archive host with hard caps on
# download size, file count and bytes read, then hands text files to ingest.
# A `/tree/<ref>/<folder>` URL reads only that folder.

_URL = re.compile(
    r"^https://github\.com/(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/(?P<repo>[A-Za-z0-9._-]{1,100}?)"
    r"(?:\.git)?(?:/(?P<kind>tree|blob)/(?P<rest>[A-Za-z0-9._/-]{1,200}?))?/?$"
)
# Copied from a browser's address bar: `www.` and the host in any case; https only.
_HOST = re.compile(r"^https://(?:www\.)?github\.com/", re.IGNORECASE)
MAX_ARCHIVE_BYTES = 30_000_000
MAX_READ_BYTES = 4_000_000
# Walking an archive decompresses every member, even skipped ones, so its size and entry count are capped.
MAX_MEMBERS = 20_000
MAX_EXPANDED_BYTES = 300_000_000


@dataclass(frozen=True)
class RepoRef:
    """A public GitHub repository, with the branch, tag or commit and folder its URL named, if any."""

    owner: str
    repo: str
    # Everything after `/tree/`: a ref that may hold slashes, then maybe a folder. `_download` tells them apart.
    ref: str | None

    @property
    def archive_url(self) -> str:
        """The tarball URL on GitHub's archive host, when all of `ref` is the branch, tag or commit."""
        return self.archive_url_for(self.ref)

    def archive_url_for(self, ref: str | None) -> str:
        """The tarball URL for `ref` on GitHub's archive host."""
        return f"https://codeload.github.com/{self.owner}/{self.repo}/tar.gz/{ref or 'HEAD'}"

    @property
    def label(self) -> str:
        """`owner/repo` or `owner/repo@ref`."""
        return f"{self.owner}/{self.repo}" + (f"@{self.ref}" if self.ref else "")


def parse_repo_url(url: str) -> RepoRef:
    """Validate a github.com repository URL, raising 400 for anything else."""
    text = _HOST.sub("https://github.com/", re.split(r"[?#]", url.strip(), maxsplit=1)[0])
    match = _URL.match(text)
    if match is None or ".." in text:
        raise bad_request("Paste a public repository URL such as https://github.com/owner/repo.")
    rest = (match["rest"] or "").strip("/")
    # A `/blob/<ref>/<file>` link reads the whole repository at that ref.
    if match["kind"] == "blob":
        rest = rest.split("/", 1)[0]
    return RepoRef(match["owner"], match["repo"], rest or None)


def fetch_repo(ref: RepoRef, now: datetime, client: httpx.Client | None = None) -> Material:
    """Download a repository tarball and turn its readable text files into material."""
    own_client = client is None
    http = client or httpx.Client(timeout=30.0, follow_redirects=False)
    try:
        archive, folder = _download(http, ref)
    except httpx.HTTPError as exc:
        raise ValueError(f"Could not reach GitHub to read {ref.label}. Check the network, then try again.") from exc
    finally:
        if own_client:
            http.close()
    try:
        items = _text_files(archive, folder)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise ValueError(f"The archive GitHub sent for {ref.label} could not be read. Try again.") from exc
    if folder and not items:
        raise ValueError(f"{ref.label} has no readable files in {folder}. Check the folder in the URL.")
    material = build_material(items, now)
    # The sidebar lists the repository once, by name, rather than as an anonymous code folder.
    total = sum(int(source["bytes"]) for source in material.sources)
    source = {**material.sources[0], "name": ref.label, "kind": "github", "bytes": total} if material.sources else None
    return replace(material, sources=[source] if source else [])


def _download(http: httpx.Client, ref: RepoRef) -> tuple[bytes, str | None]:
    """Stream the tarball, stopping at `MAX_ARCHIVE_BYTES`; returns it with the folder the URL named, if any."""
    parts = ref.ref.split("/") if ref.ref else []
    # Branch names may hold slashes, so try the shortest ref first; GitHub answers 404 fast for one that is not.
    for cut in range(1, len(parts) + 1) if parts else [0]:
        candidate = "/".join(parts[:cut]) or None
        with http.stream("GET", ref.archive_url_for(candidate)) as response:
            if response.status_code == 404:
                continue
            if response.status_code != 200:
                raise ValueError(f"GitHub answered {response.status_code} for {ref.label}. Try again later.")
            buffer = io.BytesIO()
            for chunk in response.iter_bytes():
                buffer.write(chunk)
                if buffer.tell() > MAX_ARCHIVE_BYTES:
                    raise ValueError(
                        f"{ref.label} is over {MAX_ARCHIVE_BYTES // 1_000_000} MB. Upload its key folder instead."
                    )
            return buffer.getvalue(), "/".join(parts[cut:]) or None
    raise ValueError(f"GitHub has no public repository or ref {ref.label}. Check the URL.")


def _text_files(archive: bytes, folder: str | None = None) -> list[SourceItem]:
    """The most telling readable text files from a tarball, capped in count and total bytes."""
    # Archive order puts whole `docs/` or `examples/` trees first, so pick by rank before reading anything.
    candidates: list[tuple[tuple[int, int, str], str, str]] = []
    for member, path in _members(archive, folder):
        inside = path[len(folder) + 1 :] if folder else path
        candidates.append((path_rank(inside, member.size), member.name, path))
    chosen: dict[str, str] = {}
    budget = MAX_READ_BYTES
    prose = 0
    for (rank, size, _), name, path in sorted(candidates):
        if len(chosen) >= MAX_FILES:
            break
        # A repository with thousands of doc pages must still leave room for its code.
        if rank in (0, 1) and prose + size > PROSE_CHARS:
            continue
        if size <= budget:
            chosen[name] = path
            budget -= size
            prose += size if rank in (0, 1) else 0
    items: list[SourceItem] = []
    seen = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar:
            seen += 1
            # Every chosen member came before the first pass stopped, so the second pass never walks further.
            if seen > MAX_MEMBERS or len(items) == len(chosen):
                break
            tar.members = []  # type: ignore[attr-defined]  # a real attribute the stubs omit
            if member.name not in chosen:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            try:
                text = handle.read(MAX_FILE_BYTES).decode("utf-8")
            except UnicodeDecodeError:
                continue
            if "\x00" in text[:8000]:
                continue
            items.append(SourceItem(name=chosen[member.name], kind="code", text=text))
    return items


def _members(archive: bytes, folder: str | None) -> list[tuple[tarfile.TarInfo, str]]:
    """Every file member the policy lets through, with its path inside the repository."""
    found: list[tuple[tarfile.TarInfo, str]] = []
    seen = 0
    expanded = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar:
            seen += 1
            expanded += max(member.size, 0)
            if seen > MAX_MEMBERS or expanded > MAX_EXPANDED_BYTES:
                break
            # tarfile keeps every header it walks; clearing them keeps memory flat on huge archives.
            tar.members = []  # type: ignore[attr-defined]  # a real attribute the stubs omit
            if not member.isfile() or member.size == 0 or member.size > MAX_FILE_BYTES:
                continue
            # Archives start with one `<repo>-<sha>/` folder; drop it so paths read like the repository.
            path = member.name.split("/", 1)[1] if "/" in member.name else member.name
            if folder and not path.startswith(f"{folder}/"):
                continue
            if path and not skip_reason(path):
                found.append((member, path))
    return found
