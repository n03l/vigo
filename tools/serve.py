#!/usr/bin/env python3
"""Static dev server for vigo.

Serves src/ on 127.0.0.1:8090 by default. There is no login, so requests are accepted only
when the Host header is localhost or the bound address (blocks DNS rebinding), and binding
to anything but loopback prints a warning.

    python3 tools/serve.py                               # http://localhost:8090
    python3 tools/serve.py --host 192.168.1.107 --port 8090
    python3 tools/serve.py --prefix /vigo/                   # like GitHub Pages: http://localhost:8090/vigo/
"""

import argparse
import functools
import http.server
import io
import ipaddress
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "src"


def git_commit():
    """The checked out commit, with -dirty when there are local changes, like the deploy writes."""
    try:
        sha = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=REPO, capture_output=True, text=True,
                             check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True, text=True,
                               check=True).stdout.strip()
        return sha + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "dev"


def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class Handler(http.server.SimpleHTTPRequestHandler):
    allowed_hosts = frozenset()
    prefix = "/"

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def host_allowed(self):
        host = self.headers.get("Host", "").lower()
        return host in self.allowed_hosts

    def send_head(self):
        if not self.host_allowed():
            self.send_error(421, "Host not allowed")
            return None
        if self.prefix != "/":
            path = self.path.split("?", 1)[0]
            if path == self.prefix.rstrip("/"):
                self.send_response(301)
                self.send_header("Location", self.prefix)
                self.end_headers()
                return None
            if not path.startswith(self.prefix):
                self.send_error(404, "Not found")
                return None
            self.path = "/" + self.path[len(self.prefix):]
        if self.path.split("?", 1)[0] == "/version.json":
            body = json.dumps({"commit": git_commit()}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return io.BytesIO(body)
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "Not found")
        return None

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--prefix", default="/", help="serve under this path, e.g. /vigo/ as on GitHub Pages")
    args = parser.parse_args()
    prefix = "/" + args.prefix.strip("/") + "/" if args.prefix.strip("/") else "/"

    names = {"localhost", "127.0.0.1", "[::1]", args.host.lower()}
    hosts = {f"{name}:{args.port}" for name in names}
    if args.port == 80:
        hosts |= names

    handler = functools.partial(Handler, directory=str(ROOT))
    Handler.allowed_hosts = frozenset(hosts)
    Handler.prefix = prefix

    server = http.server.ThreadingHTTPServer((args.host, args.port), handler)
    if not is_loopback(args.host):
        print(
            "\n"
            "  WARNING: serving on a non-loopback address. There is no login:\n"
            f"  anyone on the network who can reach {args.host}:{args.port} can load the app.\n",
            file=sys.stderr,
        )
    print(f"vigo: serving {ROOT} on http://{args.host}:{args.port}{prefix}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
