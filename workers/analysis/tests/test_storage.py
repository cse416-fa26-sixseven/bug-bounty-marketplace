from pathlib import Path

import pytest
from azure.core.exceptions import ResourceNotFoundError

from analysis.config import Settings
from analysis.storage import (
    BlobSourceStore,
    LocalSourceStore,
    assert_storage_key,
    open_store,
)


class _Download:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def readall(self) -> bytes:
        return self.data


class FakeContainer:
    """Stands in for azure.storage.blob.ContainerClient."""

    def __init__(self, blobs: dict[str, bytes]) -> None:
        self.blobs = blobs
        self.requested: list[str] = []

    def download_blob(self, blob: str) -> _Download:
        self.requested.append(blob)
        if blob not in self.blobs:
            err = ResourceNotFoundError("The specified blob does not exist.")
            err.error_code = "BlobNotFound"  # what the SDK sets from x-ms-error-code
            raise err
        return _Download(self.blobs[blob])


def test_blob_store_reads_the_blob_named_by_the_key():
    container = FakeContainer({"contracts/c1/abc.sol": b"contract V {}"})
    assert BlobSourceStore(container).read("contracts/c1/abc.sol") == b"contract V {}"
    assert container.requested == ["contracts/c1/abc.sol"]


def test_blob_store_raises_file_not_found_with_the_key_as_filename():
    store = BlobSourceStore(FakeContainer({}))
    with pytest.raises(FileNotFoundError) as info:
        store.read("contracts/c1/missing.sol")
    assert info.value.filename == "contracts/c1/missing.sol"


def test_blob_store_reraises_a_missing_container():
    class NoContainer:
        def download_blob(self, blob: str):
            err = ResourceNotFoundError("The specified container does not exist.")
            err.error_code = "ContainerNotFound"
            raise err

    with pytest.raises(ResourceNotFoundError):
        BlobSourceStore(NoContainer()).read("contracts/c1/a.sol")


@pytest.mark.parametrize(
    "key", ["../outside.sol", "/abs.sol", "a//b.sol", "a/./b.sol", "a\\b.sol", ""]
)
def test_blob_store_refuses_keys_that_are_not_plain_relative_paths(key: str):
    container = FakeContainer({})
    with pytest.raises(ValueError):
        BlobSourceStore(container).read(key)
    assert container.requested == []


def test_assert_storage_key_accepts_the_api_key_shapes():
    assert_storage_key("contracts/contract_1/abc.sol")
    assert_storage_key("pocs/poc_1/abc.t.sol")


def test_local_store_reads_under_the_root(tmp_path: Path):
    (tmp_path / "contracts").mkdir()
    (tmp_path / "contracts" / "a.sol").write_bytes(b"x")
    store = LocalSourceStore(tmp_path)
    assert store.read("contracts/a.sol") == b"x"
    with pytest.raises(FileNotFoundError) as info:
        store.read("contracts/b.sol")
    assert info.value.filename == "contracts/b.sol"
    with pytest.raises(ValueError):
        store.read("../outside.sol")


def test_open_store_prefers_blob_then_local_then_none(tmp_path: Path):
    url = "https://acct.blob.core.windows.net/sources"
    with pytest.raises(ValueError):
        open_store(Settings.from_env({"SOURCE_STORAGE_BLOB_CONTAINER_URL": "not a url"}))
    both = Settings.from_env(
        {"SOURCE_STORAGE_BLOB_CONTAINER_URL": url, "SOURCE_STORAGE_DIR": str(tmp_path)}
    )
    # Building the client only parses the URL; nothing is contacted.
    blob = open_store(both)
    assert isinstance(blob, BlobSourceStore)
    assert blob.container.container_name == "sources"
    assert blob.container.account_name == "acct"

    local = open_store(Settings.from_env({"SOURCE_STORAGE_DIR": str(tmp_path)}))
    assert isinstance(local, LocalSourceStore)
    assert local.root == tmp_path

    assert open_store(Settings.from_env({})) is None


def test_settings_know_whether_a_store_is_configured(tmp_path: Path):
    assert Settings.from_env({}).source_storage_configured is False
    assert Settings.from_env({"SOURCE_STORAGE_DIR": str(tmp_path)}).source_storage_configured
    assert Settings.from_env(
        {"SOURCE_STORAGE_BLOB_CONTAINER_URL": "https://a.blob.core.windows.net/c"}
    ).source_storage_configured
