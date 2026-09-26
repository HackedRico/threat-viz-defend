import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

# =============================================================================
# Module Overview
# =============================================================================
# Where slow work runs. Drawing a map or finding threats takes a model call of
# up to two minutes, so routes answer at once and hand the call to a `Jobs`.
# `ThreadJobs` runs it on a small pool, which also caps concurrent model calls;
# `InlineJobs` runs it on the spot, which keeps tests deterministic.

log = logging.getLogger(__name__)


class Jobs(Protocol):
    """Anything that runs a no-argument function, now or later."""

    def submit(self, work: Callable[[], None], label: str) -> None:
        """Run `work`; failures are logged, never raised to the caller."""
        ...


class ThreadJobs:
    """Runs jobs on a bounded thread pool."""

    def __init__(self, workers: int = 8) -> None:
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="job")

    def submit(self, work: Callable[[], None], label: str) -> None:
        """Queue `work` on the pool."""
        self._pool.submit(_guarded, work, label)

    def shutdown(self) -> None:
        """Stop taking jobs and wait for running ones."""
        self._pool.shutdown(wait=True, cancel_futures=True)


class InlineJobs:
    """Runs each job immediately in the caller's thread."""

    def submit(self, work: Callable[[], None], label: str) -> None:
        """Run `work` now."""
        _guarded(work, label)


def _guarded(work: Callable[[], None], label: str) -> None:
    """Run `work`, logging anything it raises; a job's own code records failures on its board."""
    try:
        work()
    except Exception:
        log.exception("[jobs] %s failed unexpectedly.", label)
