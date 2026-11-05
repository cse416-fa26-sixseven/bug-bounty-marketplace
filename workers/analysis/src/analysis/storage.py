"""Reads the sources the API stored: a local directory shared with it (dev,
compose) or the Azure Blob container it writes to (AKS). Keys are the
API's `source_reference` / `test_file_reference` values, relative POSIX paths
such as `contracts/<id>/<sha256>.sol`."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from azure.core.exceptions import ResourceNotFoundError

if TYPE_CHECKING:
    from .config import Settings


class SourceStore(Protocol):
    """One way to read a stored source. Raises FileNotFoundError (with
    `filename` set to the key) when the object does not exist."""

    def read(self, key: str) -> bytes: ...


def assert_storage_key(key: str) -> None:
    """Refuses keys that are not plain relative paths (`..`, absolute paths,
    backslashes, empty segments), mirroring the API's checks."""
    segments = key.split("/")
    bad = (
        key == ""
        or key.startswith("/")
        or "\\" in key
        or any(segment in ("", ".", "..") for segment in segments)
    )
    if bad:
        raise ValueError(f"Storage key escapes the storage root: {key}")


def read_source(storage_dir: Path, key: str) -> bytes:
    """Reads `key` under `storage_dir`. Refuses keys that escape the root,
    mirroring the API's LocalSourceStorage. Raises FileNotFoundError if absent."""
    root = storage_dir.resolve()
    target = (root / key).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"Storage key escapes the storage root: {key}")
    return target.read_bytes()


class LocalSourceStore:
    """The directory the API's LocalSourceStorage writes to."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def read(self, key: str) -> bytes:
        try:
            return read_source(self.root, key)
        except FileNotFoundError as err:
            # Report the key, like the Blob store, not the absolute path.
            raise FileNotFoundError(err.errno, err.strerror, key) from err


class BlobDownload(Protocol):
    def readall(self) -> bytes: ...


class BlobContainer(Protocol):
    """The subset of azure.storage.blob.ContainerClient the store uses."""

    def download_blob(self, blob: str) -> BlobDownload: ...


class BlobSourceStore:
    """The Blob container the API's BlobSourceStorage writes to. Authenticates
    with the ambient Azure identity (workload identity on AKS), never a key."""

    def __init__(self, container: BlobContainer) -> None:
        self.container = container

    @classmethod
    def from_container_url(cls, container_url: str) -> BlobSourceStore:
        """`container_url` is https://<account>.blob.core.windows.net/<container>.
        Nothing is contacted until the first read."""
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import ContainerClient

        client = ContainerClient.from_container_url(
            container_url, credential=DefaultAzureCredential()
        )
        return cls(client)

    def read(self, key: str) -> bytes:
        assert_storage_key(key)
        try:
            return self.container.download_blob(key).readall()
        except ResourceNotFoundError as err:
            # Only a missing blob is a missing source. A missing container is
            # a 404 too (ContainerNotFound) but a deployment error: re-raised,
            # so the job is retried instead of failing for good.
            if getattr(err, "error_code", None) != "BlobNotFound":
                raise
            raise FileNotFoundError(2, "Blob not found", key) from err


def open_store(settings: Settings) -> SourceStore | None:
    """The store the settings select: the Blob container URL wins over the
    local directory; None when neither is set. A malformed container URL
    raises ValueError, so callers at start-up fail loudly."""
    if settings.source_storage_blob_container_url:
        return BlobSourceStore.from_container_url(settings.source_storage_blob_container_url)
    if settings.source_storage_dir is not None:
        return LocalSourceStore(settings.source_storage_dir)
    return None
