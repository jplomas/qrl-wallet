"""Local backend lifecycle for the native Linux wallet shell."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ServerInfo:
    url: str
    port: int
    host: str
    mode: str
    process: subprocess.Popen


class NativeBackendManager:
    def __init__(self, repo_root: Path | None = None) -> None:
        self.repo_root = Path(repo_root or resolve_repo_root())
        self.process: subprocess.Popen | None = None
        version = "1.9.1"
        pkg = self.repo_root / "package.json"
        if pkg.exists():
            try:
                version = json.loads(pkg.read_text()).get("version", version)
            except Exception:
                pass
        self.user_agent = (
            f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            f"(KHTML, like Gecko) QRLWallet-Native/{version} Safari/537.36"
        )

    def start(self, timeout: float = 60.0) -> ServerInfo:
        host = "127.0.0.1"
        port = free_port()
        url = f"http://{host}:{port}/"
        server_js = self.repo_root / "native" / "backend" / "server.js"
        if not server_js.exists():
            raise FileNotFoundError(f"Native backend missing: {server_js}")

        env = os.environ.copy()
        env.update(
            {
                "BIND_IP": host,
                "PORT": str(port),
                "QRL_WALLET_ROOT": str(self.repo_root),
            }
        )

        self.process = subprocess.Popen(
            ["node", str(server_js)],
            cwd=str(self.repo_root),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        wait_for_ready(f"{url}api/health", timeout=timeout)
        return ServerInfo(url=url, port=port, host=host, mode="native", process=self.process)

    def stop(self) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def resolve_repo_root() -> Path:
    env_root = os.environ.get("QRL_WALLET_ROOT")
    if env_root:
        return Path(env_root).resolve()

    here = Path(__file__).resolve()
    for candidate in [here.parent, *here.parents]:
        if (candidate / "package.json").exists() and (candidate / "native").exists():
            return candidate

    raise FileNotFoundError("Unable to locate repository root (package.json)")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_ready(url: str, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as response:
                if 200 <= response.status < 500:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.15)
    raise TimeoutError(f"Timed out waiting for native backend at {url}")
