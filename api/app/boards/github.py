import io
import re
import tarfile
from dataclasses import dataclass
from datetime import datetime

import httpx

from app.boards.ingest import Material, SourceItem, build_material
from app.domain.masking import MAX_FILE_BYTES, MAX_FILES, skip_reason
from app.errors import bad_request

# =============================================================================
# Module Overview
# =============================================================================
# Reads a public GitHub repository without cloning it. `parse_repo_url` accepts
# only github.com URLs, so the server never fetches an address a user chose;
# `fetch_repo` downloads the tarball from GitHub's archive host with hard caps on
# download size, file count and bytes read, then hands text files to ingest.

_URL = re.compile(
    r"^https://github\.com/(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/(?P<repo>[A-Za-z0-9._-]{1,100}?)"
    r"(?:\.git)?(?:/tree/(?P<ref>[A-Za-z0-9._/-]{1,200}))?/?$"
)
MAX_ARCHIVE_BYTES = 30_000_000
MAX_READ_BYTES = 4_000_000


@dataclass(frozen=True)
class RepoRef:
    """A public GitHub repository and optional branch, tag or commit."""

    owner: str
    repo: str
    ref: str | None

    @property
    def archive_url(self) -> str:
        """The tarball URL on GitHub's archive host."""
        return f"https://codeload.github.com/{self.owner}/{self.repo}/tar.gz/{self.ref or 'HEAD'}"

    @property
    def label(self) -> str:
        """`owner/repo` or `owner/repo@ref`."""
        return f"{self.owner}/{self.repo}" + (f"@{self.ref}" if self.ref else "")


def parse_repo_url(url: str) -> RepoRef:
    """Validate a github.com repository URL, raising 400 for anything else."""
    match = _URL.match(url.strip())
    if match is None or ".." in url:
        raise bad_request("Paste a public repository URL such as https://github.com/owner/repo.")
    return RepoRef(match["owner"], match["repo"], match["ref"])


def fetch_repo(ref: RepoRef, now: datetime, client: httpx.Client | None = None) -> Material:
    """Download a repository tarball and turn its readable text files into material."""
    own_client = client is None
    http = client or httpx.Client(timeout=30.0, follow_redirects=False)
    try:
        archive = _download(http, ref)
    finally:
        if own_client:
            http.close()
    return build_material(_text_files(archive), now)


def _download(http: httpx.Client, ref: RepoRef) -> bytes:
    """Stream the tarball, stopping at `MAX_ARCHIVE_BYTES`."""
    with http.stream("GET", ref.archive_url) as response:
        if response.status_code == 404:
            raise ValueError(f"GitHub has no public repository or ref {ref.label}. Check the URL.")
        if response.status_code != 200:
            raise ValueError(f"GitHub answered {response.status_code} for {ref.label}. Try again later.")
        buffer = io.BytesIO()
        for chunk in response.iter_bytes():
            buffer.write(chunk)
            if buffer.tell() > MAX_ARCHIVE_BYTES:
                raise ValueError(
                    f"{ref.label} is over {MAX_ARCHIVE_BYTES // 1_000_000} MB. Upload its key folder instead."
                )
    return buffer.getvalue()


def _text_files(archive: bytes) -> list[SourceItem]:
    """Readable text files from a tarball, capped in count and total bytes."""
    items: list[SourceItem] = []
    read = 0
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        for member in tar:
            if len(items) >= MAX_FILES or read >= MAX_READ_BYTES:
                break
            if not member.isfile() or member.size > MAX_FILE_BYTES:
                continue
            # Archives start with one `<repo>-<sha>/` folder; drop it so paths read like the repository.
            path = member.name.split("/", 1)[1] if "/" in member.name else member.name
            if not path or skip_reason(path):
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            data = handle.read(MAX_FILE_BYTES)
            read += len(data)
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                continue
            items.append(SourceItem(name=path, kind="code", text=text))
    return items
