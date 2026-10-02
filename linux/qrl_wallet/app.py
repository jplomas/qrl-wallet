"""GTK + WebKitGTK shell for QRL Wallet."""

from __future__ import annotations

import os
import signal
import subprocess
import sys

import gi

gi.require_version("Gtk", "3.0")

# Prefer WebKit2 4.1, fall back to 4.0.
try:
    gi.require_version("WebKit2", "4.1")
except ValueError:
    gi.require_version("WebKit2", "4.0")

from gi.repository import Gtk, WebKit2, GLib  # noqa: E402

from .server import NativeBackendManager


class QRLWalletWindow(Gtk.Window):
    def __init__(self, manager: NativeBackendManager, server_url: str) -> None:
        super().__init__(title="QRL Wallet")
        self.set_default_size(1300, 840)
        self.connect("destroy", self._on_destroy)

        self._manager = manager
        self._allowed_origin = _origin(server_url)

        self._webview = WebKit2.WebView()
        settings = self._webview.get_settings()
        settings.set_user_agent(manager.user_agent)
        settings.set_enable_developer_extras(False)

        self._webview.connect("decide-policy", self._on_decide_policy)
        self._webview.connect("create", self._on_create)
        self._webview.connect("load-changed", self._on_load_changed)

        # Inject desktop detection before page scripts run.
        self._webview.run_javascript("window.__QRL_NATIVE_DESKTOP__ = true;")

        content_manager = self._webview.get_user_content_manager()
        script = WebKit2.UserScript.new(
            "window.__QRL_NATIVE_DESKTOP__ = true;",
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START,
            None,
            None,
        )
        content_manager.add_script(script)

        self.add(self._webview)
        self._webview.load_uri(server_url)
        self.show_all()

    def _on_load_changed(self, webview, event):
        if event == WebKit2.LoadEvent.COMMITTED:
            webview.run_javascript("window.__QRL_NATIVE_DESKTOP__ = true;")

    def _on_decide_policy(self, webview, decision, decision_type):
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False

        request = decision.get_request()
        uri = request.get_uri()
        if not uri:
            decision.ignore()
            return True

        if uri.startswith("http://") or uri.startswith("https://"):
            if _origin(uri) == self._allowed_origin:
                decision.use()
            else:
                _open_external(uri)
                decision.ignore()
            return True

        decision.ignore()
        return True

    def _on_create(self, webview, navigation_action):
        request = navigation_action.get_request()
        uri = request.get_uri() if request else None
        if uri:
            if _origin(uri) == self._allowed_origin:
                self._webview.load_uri(uri)
            else:
                _open_external(uri)
        return None

    def _on_destroy(self, *_args):
        self._manager.stop()
        Gtk.main_quit()


def _origin(url: str) -> str | None:
    try:
        from urllib.parse import urlparse

        parsed = urlparse(url)
        if not parsed.scheme or not parsed.hostname:
            return None
        if parsed.port:
            return f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        return f"{parsed.scheme}://{parsed.hostname}"
    except Exception:
        return None


def _open_external(url: str) -> None:
    try:
        subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    manager = NativeBackendManager()

    def handle_signal(_signum, _frame):
        manager.stop()
        Gtk.main_quit()

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    try:
        server = manager.start()
    except Exception as exc:
        dialog = Gtk.MessageDialog(
            message_type=Gtk.MessageType.ERROR,
            buttons=Gtk.ButtonsType.CLOSE,
            text="Failed to start QRL Wallet",
            secondary_text=str(exc),
        )
        dialog.run()
        dialog.destroy()
        return 1

    QRLWalletWindow(manager, server.url)
    Gtk.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
