#!/usr/bin/env python3
"""End to end UI test with a fake Bluetooth trainer, HR strap and speed/cadence sensor.

    ~/.venv/bin/python tools/ui_test.py --out /path/for/screenshots
"""

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parent.parent
FIXTURES = REPO / "test" / "fixtures"
PORT = 8097
# served under a subpath, so a root absolute URL breaks the test
URL = f"http://127.0.0.1:{PORT}/vigo/"


def wait_for_server():
    for _ in range(50):
        try:
            urllib.request.urlopen(URL, timeout=0.5)
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("dev server did not start")


def wait_until(page, expression, timeout=5000):
    # wait_for_function evals a string in the page, which the app's CSP blocks
    deadline = time.monotonic() + timeout / 1000
    while not page.evaluate(expression):
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {expression}")
        page.wait_for_timeout(50)


def brake_writes(page):
    return page.evaluate("window.__ble.writes")


def targets(page):
    return [w[1] | (w[2] << 8) for w in brake_writes(page) if w[0] == 0]


# records the frequency of every tone the app plays in window.__beeps
FAKE_AUDIO = """
window.__beeps = [];
class FakeParam { setValueAtTime() {} linearRampToValueAtTime() {} }
window.AudioContext = class {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createOscillator() {
        const frequency = new FakeParam();
        return {frequency, connect: (node) => node, start: () => window.__beeps.push(frequency.value), stop() {}};
    }
    createGain() { return {gain: new FakeParam(), connect: (node) => node}; }
};
"""


def beeps(page):
    return page.evaluate("window.__beeps")


# Google sign-in, stubbed: the token names the account, window.__account picks it (A unless set)
FAKE_GIS = """
window.google = {accounts: {oauth2: {
    initTokenClient: (config) => ({requestAccessToken: (opts) => {
        (window.__gisPrompts ??= []).push(opts?.prompt);
        setTimeout(() => config.callback({access_token: `tok-${window.__account ?? 'A'}`, expires_in: 3599}), 0);
    }}),
    hasGrantedAllScopes: () => true,
    revoke: (token, done) => done?.(),
}}};
"""

CLIENT_ID = "123-test.apps.googleusercontent.com"
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH",
}


class FakeDrive:
    """Drive's files API for the calls vigo makes, one file store per account."""

    def __init__(self):
        self.files = {}    # account -> {id: {"version": int, "text": str}}
        self.uploads = []  # (account, method, file id)
        self.next_id = 1

    def handle(self, route):
        request = route.request
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer tok-"):
            return self.reply(route, {"error": "no token"}, 401)
        account = auth.removeprefix("Bearer tok-")
        files = self.files.setdefault(account, {})
        url = urllib.parse.urlparse(request.url)
        query = urllib.parse.parse_qs(url.query)
        path = url.path
        if path == "/drive/v3/about":
            return self.reply(route, {"user": {"permissionId": f"perm{account}"}})
        if path == "/drive/v3/files":
            assert "key='vigo'" in query["q"][0], query
            return self.reply(route, {"files": [{"id": i, "version": str(f["version"])} for i, f in reversed(files.items())]})
        if path.startswith("/drive/v3/files/"):
            file_id = path.rsplit("/", 1)[1]
            if file_id not in files:
                return self.reply(route, {"error": "not found"}, 404)
            if query.get("alt") == ["media"]:
                return route.fulfill(status=200, headers=CORS, content_type="application/json", body=files[file_id]["text"])
            return self.reply(route, {"id": file_id, "version": str(files[file_id]["version"]), "trashed": False})
        if path == "/upload/drive/v3/files" and request.method == "POST":
            body = request.post_data
            boundary = request.headers["content-type"].split("boundary=")[1]
            parts = body.split(f"--{boundary}")
            meta = json.loads(parts[1].split("\r\n\r\n", 1)[1])
            assert meta["appProperties"] == {"vigo": "data"}, meta
            text = parts[2].split("\r\n\r\n", 1)[1].removesuffix("\r\n")
            file_id = f"file{self.next_id}"
            self.next_id += 1
            files[file_id] = {"version": 1, "text": text}
            self.uploads.append((account, "create", file_id))
            return self.reply(route, {"id": file_id, "version": "1"})
        if path.startswith("/upload/drive/v3/files/") and request.method == "PATCH":
            file_id = path.rsplit("/", 1)[1]
            if file_id not in files:
                return self.reply(route, {"error": "not found"}, 404)
            files[file_id] = {"version": files[file_id]["version"] + 1, "text": request.post_data}
            self.uploads.append((account, "update", file_id))
            return self.reply(route, {"id": file_id, "version": str(files[file_id]["version"])})
        raise AssertionError(f"unexpected Drive call {request.method} {request.url}")

    @staticmethod
    def reply(route, body, status=200):
        route.fulfill(status=status, headers=CORS, content_type="application/json", body=json.dumps(body))

    def data(self, account="A"):
        (only,) = self.files[account].values()
        return json.loads(only["text"])

    def edit(self, account, fn):
        """Another device changes the file."""
        (f,) = self.files[account].values()
        data = json.loads(f["text"])
        fn(data)
        f["text"] = json.dumps(data)
        f["version"] += 1


def drive_pass(browser, out, errors, dialogs):
    """Google Drive sync between two devices, on stubbed Google routes."""
    fake = FakeDrive()

    def on_dialog(d):
        dialogs.append((d.type, d.message))
        d.accept()

    def device(name):
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        context.route("**/config.json", lambda r: r.fulfill(json={"googleClientId": CLIENT_ID}))
        context.route("https://accounts.google.com/gsi/client", lambda r: r.fulfill(content_type="text/javascript", body=FAKE_GIS))
        context.route("https://www.googleapis.com/**", fake.handle)
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(f"console ({name}): {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror ({name}): {e}\n{e.stack}"))
        page.on("dialog", on_dialog)
        page.goto(URL + "#/settings")
        return context, page

    def titles(page):
        page.locator('[data-tab="workouts"]').click()
        names = page.locator("#workout-list .row-title").all_text_contents()
        page.locator('[data-tab="settings"]').click()
        return names

    def upload(page, name):
        page.locator('[data-tab="workouts"]').click()
        page.set_input_files("#file", str(FIXTURES / name))
        page.wait_for_timeout(200)
        page.locator('[data-tab="settings"]').click()

    def delete(page, name):
        page.locator('[data-tab="workouts"]').click()
        page.get_by_role("button", name=f"Delete {name}", exact=True).click()
        page.wait_for_timeout(200)
        page.locator('[data-tab="settings"]').click()

    def sync_now(page):
        page.get_by_role("button", name="Sync now", exact=True).first.click()

    def synced(page):
        expect(page.locator("#drive-status")).to_contain_text("Synced", timeout=5000)

    def drive_names(account="A"):
        return sorted(w["fileName"] for w in fake.data(account)["workouts"])

    # device 1 has its own workout and connects: the file is created with it
    ctx1, one = device("one")
    expect(one.locator("#btn-drive-connect")).to_be_visible()
    expect(one.locator("#drive-intro")).to_contain_text("vigo data.json")
    shoot = lambda page, name: page.screenshot(path=str(out / f"{name}.png"), full_page=True)
    shoot(one, "drive-connect-desktop")
    upload(one, "short.mrc")
    one.click("#btn-drive-connect")
    synced(one)
    assert fake.uploads == [("A", "create", "file1")], fake.uploads
    assert fake.data()["format"] == "vigo-backup"
    assert drive_names() == ["short.mrc"], drive_names()
    shoot(one, "drive-synced-desktop")
    one.set_viewport_size({"width": 390, "height": 844})
    one.locator("#drive-card").scroll_into_view_if_needed()
    one.screenshot(path=str(out / "drive-synced-phone.png"))
    one.set_viewport_size({"width": 1280, "height": 800})

    # nothing changed: Sync now uploads nothing
    sync_now(one)
    synced(one)
    assert len(fake.uploads) == 1, fake.uploads

    # a fresh device 2 takes Drive's copy without asking
    ctx2, two = device("two")
    two.click("#btn-drive-connect")
    synced(two)
    assert "Short test" in titles(two), titles(two)
    assert len(fake.uploads) == 1, fake.uploads

    # a change on device 2 goes up, device 1 picks it up, a deletion included
    upload(two, "steps.erg")
    delete(two, "Short test")
    sync_now(two)
    synced(two)
    assert drive_names() == ["steps.erg"], drive_names()
    sync_now(one)
    synced(one)
    assert "Steps" in titles(one) and "Short test" not in titles(one), titles(one)

    # settings travel too
    one.fill("#ftp", "277")
    one.locator("#ftp").dispatch_event("change")
    one.wait_for_timeout(200)
    sync_now(one)
    synced(one)
    assert fake.data()["settings"]["ftp"] == 277
    sync_now(two)
    synced(two)
    expect(two.locator("#ftp")).to_have_value("277")

    # a ride travels too, its name stays text
    hostile = "<img src=x onerror=alert(1)>"
    t0 = 1_790_000_000
    backup = {"format": "vigo-backup", "version": 1, "settings": {"ftp": 277}, "workouts": [], "rides": [{
        "interrupted": False, "workoutName": hostile, "ftp": 277, "events": [{"t": t0, "type": "start"}],
        "samples": [[t0 + i, 200, 140, 90, 8, 8 * i] for i in range(120)],
    }]}
    (out / "drive-ride-backup.json").write_text(json.dumps(backup))
    two.set_input_files("#restore-file", str(out / "drive-ride-backup.json"))
    expect(two.locator("#backup-status")).to_contain_text("Restored 0 workouts and 1 ride")
    sync_now(two)
    synced(two)
    assert [r["workoutName"] for r in fake.data()["rides"]] == [hostile]
    sync_now(one)
    synced(one)
    one.locator('[data-tab="history"]').click()
    expect(one.locator("#history-list li")).to_have_count(1)
    expect(one.locator("#history-list li").first).to_contain_text(hostile)
    assert one.locator("img").count() == 0
    one.locator('[data-tab="settings"]').click()

    # both change: device 1 is asked, merging keeps both
    upload(one, "sweetspot.mrc")
    upload(two, "short.mrc")
    sync_now(two)
    synced(two)
    uploads = len(fake.uploads)
    sync_now(one)
    conflict = one.locator('.banner[data-id="drive"]')
    expect(conflict).to_contain_text("both changed")
    expect(conflict).to_contain_text("Drive has 2 uploaded workouts and 1 ride; this device has 2 uploaded workouts and 1 ride")
    assert len(fake.uploads) == uploads
    shoot(one, "drive-conflict-desktop")
    one.set_viewport_size({"width": 390, "height": 844})
    one.evaluate("scrollTo(0, 0)")
    one.screenshot(path=str(out / "drive-conflict-phone.png"))
    one.set_viewport_size({"width": 1280, "height": 800})
    conflict.get_by_role("button", name="Merge both").click()
    synced(one)
    expect(conflict).to_have_count(0)
    assert drive_names() == ["short.mrc", "steps.erg", "sweetspot.mrc"], drive_names()
    assert {"Short test", "Steps", "Sweet spot 2x10"} <= set(titles(one)), titles(one)

    # another device syncs while the choice is open: Keep this device's doesn't overwrite it, it asks again
    delete(one, "Steps")
    fake.edit("A", lambda d: d["settings"].update(ftp=260))
    sync_now(one)
    expect(conflict).to_contain_text("both changed")
    fake.edit("A", lambda d: d["settings"].update(ftp=261))
    uploads = len(fake.uploads)
    conflict.get_by_role("button", name="Keep this device’s").click()
    expect(conflict).to_contain_text("Drive changed again on another device. Choose again.")
    assert len(fake.uploads) == uploads, fake.uploads[uploads:]
    conflict.get_by_role("button", name="Keep this device’s").click()
    synced(one)
    assert fake.data()["settings"]["ftp"] == 277 and "steps.erg" not in drive_names(), drive_names()

    # deleting everything after a sync, while Drive changed: asked, not silently restored
    for name in [n for n in titles(one) if n in ("Short test", "Sweet spot 2x10")]:
        delete(one, name)
    fake.edit("A", lambda d: d["settings"].update(ftp=262))
    sync_now(one)
    expect(conflict).to_contain_text("both changed")
    assert "Short test" not in titles(one)
    conflict.get_by_role("button", name="Use Drive’s copy").click()
    synced(one)
    assert "Short test" in titles(one), titles(one)
    expect(one.locator("#ftp")).to_have_value("262")

    # after a reload Google asks for a tap; another account is refused before any file is read or written
    one.reload()
    expect(one.locator('.banner[data-id="drive"]')).to_contain_text("waiting for you to sign in")
    expect(one.locator("#drive-status")).to_contain_text("Sign in to sync")
    one.evaluate("window.__account = 'B'")
    uploads = len(fake.uploads)
    sync_now(one)
    expect(one.locator("#drive-error")).to_contain_text("different Google account")
    assert len(fake.uploads) == uploads and "B" not in fake.files or not fake.files["B"], fake.files.keys()
    one.evaluate("window.__account = 'A'")
    sync_now(one)
    synced(one)
    assert one.evaluate("window.__gisPrompts").count("select_account") == 1

    # two tabs: the older one stops saving and says so
    newer = ctx1.new_page()
    newer.on("pageerror", lambda e: errors.append(f"pageerror (newer): {e}"))
    newer.on("console", lambda m: m.type == "error" and errors.append(f"console (newer): {m.text}"))
    newer.on("dialog", on_dialog)
    newer.goto(URL + "#/settings")
    expect(newer.locator("#drive-status")).to_contain_text("Sign in to sync")
    one.fill("#ftp", "230")
    one.locator("#ftp").dispatch_event("change")
    expect(one.locator('.banner[data-id="other-tab"]')).to_contain_text("open in another tab")
    assert newer.evaluate("JSON.parse(localStorage.getItem('vigo.settings')).ftp") == 262
    expect(one.locator("#btn-drive-sync")).to_be_disabled()
    shoot(one, "drive-other-tab-desktop")

    # disconnect keeps the file in Drive and forgets the state
    newer.get_by_role("button", name="Disconnect").click()
    expect(newer.locator("#btn-drive-connect")).to_be_visible()
    newer.reload()
    expect(newer.locator("#btn-drive-connect")).to_be_visible()
    expect(newer.locator('.banner[data-id="drive"]')).to_have_count(0)
    assert fake.files["A"], "the file in Drive is kept"

    ctx1.close()
    ctx2.close()


def run(out):
    errors = []
    dialogs = []

    with sync_playwright() as p:
        # Chrome's local network checks stop a test page on another origin from framing the
        # local server at all, turn them off so the frame test reaches vigo's own guard
        browser = p.chromium.launch(args=["--disable-features=LocalNetworkAccessChecks"])
        context = browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=True)
        context.add_init_script(FAKE_AUDIO)
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}\n{e.stack}"))

        def on_dialog(d):
            dialogs.append((d.type, d.message))
            d.accept()

        page.on("dialog", on_dialog)
        page.goto(URL)

        rows = page.locator("#workout-list li")
        history = page.locator("#history-list li")
        body = page.locator("body")

        def tab(name):
            page.locator(f'[data-tab="{name}"]').click()
            expect(body).to_have_attribute("data-view", name)

        def shoot(name):
            page.screenshot(path=str(out / f"{name}.png"), full_page=True)

        def device_row(kind):
            return page.locator(f'#device-list [data-kind="{kind}"]')

        def register_all():
            for kind, label in (("trainer", "trainer"), ("hr", "heart rate"), ("csc", "speed/cadence")):
                page.get_by_role("button", name=f"Register {label}", exact=True).click()
                expect(page.locator(f"#dev-{kind}")).to_have_attribute("data-status", "connected")

        def expect_connected(*kinds, status="connected"):
            for kind in kinds:
                expect(page.locator(f"#dev-{kind}")).to_have_attribute("data-status", status, timeout=6000)

        # a fresh browser opens on the ride view with the first built-in selected
        expect(body).to_have_attribute("data-view", "ride")
        expect(page.locator("#workout-name")).to_have_text("Recovery")
        expect(page.locator("#workout-list")).to_be_hidden()
        expect(page.locator("#btn-start")).to_be_enabled()
        expect(page.locator("#version")).to_have_text(re.compile(r"^[0-9a-f]{7}\+?$"))
        expect(page.locator("#version")).to_have_attribute("href", re.compile(r"^https://github\.com/n03l/vigo/commit/[0-9a-f]{7}$"))
        expect(page.get_by_role("link", name="vigo on GitHub")).to_have_attribute("href", "https://github.com/n03l/vigo")

        # settings page
        tab("settings")
        expect(page).to_have_title("Settings · vigo")
        page.fill("#ftp", "250")
        page.locator("#ftp").dispatch_event("change")
        expect(page.locator("#wheel option")).to_have_count(12)
        expect(page.locator("#wheel option:checked")).to_have_text("700×25c")
        page.select_option("#wheel", label="700×23c")
        expect(page.locator("#wheel option:checked")).to_have_text("700×23c")
        # heart rate zones: 50 to 90% of max HR, follow max HR, editable one by one
        expect(page.locator("#max-hr")).to_have_value("190")
        assert [page.input_value(f"#hr-z{i}") for i in range(1, 6)] == ["95", "114", "133", "152", "171"]
        page.fill("#max-hr", "160")
        page.locator("#max-hr").dispatch_event("change")
        assert [page.input_value(f"#hr-z{i}") for i in range(1, 6)] == ["80", "96", "112", "128", "144"]
        page.fill("#hr-z5", "120")
        page.locator("#hr-z5").dispatch_event("change")
        expect(page.locator("#hr-error")).to_contain_text("Zones must go up")
        page.fill("#hr-z5", "135")
        page.locator("#hr-z5").dispatch_event("change")
        expect(page.locator("#hr-error")).to_be_hidden()
        wait_until(page, "JSON.stringify(JSON.parse(localStorage.getItem('vigo.settings')).hrZones) === '[80,96,112,128,135]'")
        shoot("settings-desktop")

        # workouts page: built-ins, picking one goes back to the ride view
        tab("workouts")
        expect(rows).to_have_count(7)
        expect(page.locator("#workout-list .icon-button")).to_have_count(0)
        shoot("workouts-desktop")
        page.get_by_role("button", name="Sweet spot 3×10").click()
        expect(body).to_have_attribute("data-view", "ride")
        expect(page.locator("#workout-name")).to_have_text("Sweet spot 3×10")
        expect(page.locator("#v-target")).to_have_text("113")  # 45% of 250
        page.go_back()
        expect(body).to_have_attribute("data-view", "workouts")
        expect(page.get_by_role("button", name="Sweet spot 3×10")).to_have_attribute("aria-pressed", "true")
        page.go_forward()
        expect(body).to_have_attribute("data-view", "ride")

        # an upload stays on the workouts page, at the top and selected, the same file twice is one entry
        tab("workouts")
        page.set_input_files("#file", str(FIXTURES / "short.mrc"))
        expect(rows.first).to_contain_text("Short test")  # FILE NAME = Short_test.mrc
        expect(rows.first).to_contain_text("Three short steps for the tests")
        expect(rows).to_have_count(8)
        expect(body).to_have_attribute("data-view", "workouts")
        page.set_input_files("#file", str(FIXTURES / "short.mrc"))
        expect(rows).to_have_count(8)
        page.reload()
        expect(body).to_have_attribute("data-view", "workouts")
        expect(rows).to_have_count(8)
        tab("ride")
        expect(page.locator("#workout-name")).to_have_text("Short test")
        expect(page.locator("#workout-description")).to_have_text("Three short steps for the tests")
        expect(page.locator("#workout-meta")).to_contain_text("0:09")
        expect(page.locator("#cue-text")).to_be_hidden()
        expect(page.locator("#v-target")).to_have_text("125")

        # history starts empty
        tab("history")
        expect(page.locator("#history-empty")).to_be_visible()
        tab("ride")

        # start needs the trainer
        page.click("#btn-start")
        expect(page.locator(".banner.error")).to_contain_text("No trainer is registered")
        expect(body).to_have_attribute("data-state", "idle")
        assert brake_writes(page) == [], brake_writes(page)
        shoot("no-trainer-desktop")

        # devices are registered in Settings, the header buttons lead there
        page.click("#dev-trainer")
        expect(body).to_have_attribute("data-view", "settings")
        expect(page.locator("#device-mode")).to_contain_text("Automatic")
        expect(device_row("trainer")).to_contain_text("Not registered")
        register_all()
        expect(page.locator("#dev-trainer .device-name")).to_have_text("RAMPA 12345")
        expect(device_row("trainer")).to_contain_text("RAMPA 12345")
        expect(page.locator(".banner.error")).to_have_count(0)
        shoot("settings-devices-desktop")
        tab("ride")
        expect(page.locator("#v-hr")).to_have_text("140")
        expect(page.locator("#v-hr")).to_have_attribute("data-zone", "5")  # 140 >= the edited 135
        assert page.evaluate("getComputedStyle(document.getElementById('v-hr')).color") == "rgb(236, 75, 75)"
        tab("settings")
        page.fill("#max-hr", "190")
        page.locator("#max-hr").dispatch_event("change")
        tab("ride")
        expect(page.locator("#v-hr")).to_have_attribute("data-zone", "3")
        assert page.evaluate("getComputedStyle(document.getElementById('v-hr')).color") == "rgb(47, 191, 106)"
        expect(page.locator("#v-cadence")).to_have_text("85", timeout=4000)
        expect(page.locator("#v-speed")).to_contain_text("30.2 km/h")  # 4 rev/s x 2.096 m
        shoot("ride-desktop")

        # power scale on the left from the start, sensor scales only once their lines have points
        expect(page.locator(".axis-power text").first).to_be_visible()
        assert page.locator(".axis-hr text").count() == 0
        assert page.locator(".axis-cadence text").count() == 0

        # ride: 3 s at 125 W, 3 s at 250 W, a 3 s ramp 150 -> 300 W
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "running")
        expect(page.locator(".tabs")).to_be_hidden()
        wait_until(page, "window.__ble.writes.length > 0")
        assert targets(page)[0] == 125, targets(page)
        # the file's text messages show over the chart for their duration
        expect(page.locator("#cue-text")).to_have_text("Easy start")
        # the power doubles at 3 s: the Interval tile counts down, with beeps
        expect(page.locator("#tile-interval")).to_have_class(re.compile(r"\bcountdown\b"))
        expect(page.locator("#v-next")).to_have_text(re.compile(r"^250 W in [1-3]$"))
        assert 880 in beeps(page), beeps(page)
        expect(page.locator("#v-power")).not_to_have_text("--", timeout=3000)
        expect(page.locator("#cue-text")).to_have_text("Hold it", timeout=5000)
        # heart rate and cadence lines next to power, in the legend once they have points
        wait_until(page, "document.querySelector('.hr-trace').getAttribute('points').split(' ').length >= 2")
        wait_until(page, "document.querySelector('.cadence-trace').getAttribute('points').split(' ').length >= 2")
        for line in ("power", "heartRate", "cadence"):
            expect(page.locator(f'#chart-legend [data-line="{line}"]')).to_be_visible()
        assert page.locator(".axis-hr text").all_text_contents() == ["80", "120", "160", "200"]
        assert page.locator(".axis-cadence text").all_text_contents() == ["40", "80", "120", "160"]
        expect(page.locator("#chart")).to_have_class(re.compile(r"\bhas-hr\b.*\bhas-cadence\b|\bhas-cadence\b.*\bhas-hr\b"))

        # the ride screen can't be left mid ride
        page.evaluate("location.hash = '#/history'")
        page.wait_for_timeout(100)
        expect(body).to_have_attribute("data-view", "ride")
        page.screenshot(path=str(out / "riding-desktop.png"))

        # pause releases the brake, resume sends the target again
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "paused")
        page.wait_for_timeout(200)
        assert brake_writes(page)[-1] == [0x01, 0x00], brake_writes(page)
        page.wait_for_timeout(1000)
        page.click("#btn-start")
        page.wait_for_timeout(200)
        assert targets(page)[-1] in (125, 250), targets(page)

        # out of range warning
        page.evaluate("window.__ble.outOfRange(true)")
        expect(page.locator("#v-target-note")).to_have_text("Pedal faster")
        page.evaluate("window.__ble.outOfRange(false)")

        # losing the trainer pauses the workout, reconnecting resumes it
        wait_until(page, "window.__ble.target === 250", timeout=6000)
        page.evaluate("window.__ble.dropTrainer()")
        expect(body).to_have_attribute("data-state", "paused")
        expect(page.locator(".banner.warn")).to_contain_text("Trainer disconnected")
        page.click("#btn-start")  # resume while the trainer is away
        expect(page.locator(".banner.error")).to_contain_text("reconnecting")
        expect(body).to_have_attribute("data-state", "paused")
        expect(page.locator("#dev-trainer")).to_have_attribute("data-status", "connected", timeout=4000)
        expect(page.locator(".banner.error")).to_have_count(0)
        expect(body).to_have_attribute("data-state", "running")
        page.wait_for_timeout(300)
        assert targets(page)[-1] == 250, targets(page)

        # bias
        page.click("#bias-up")
        expect(page.locator("#bias")).to_have_text("105%")
        page.wait_for_timeout(300)
        assert targets(page)[-1] == 263, targets(page)
        page.click("#bias-down")

        # the ramp, then the end of the workout
        expect(page.locator("#summary")).to_be_visible(timeout=12000)
        # go beeps at the changes, the alarm when the trainer dropped, a countdown to the end, then the chime
        assert 1320 in beeps(page) and 330 in beeps(page), beeps(page)
        assert beeps(page)[-5:] == [880, 880, 660, 880, 1320], beeps(page)
        expect(page.locator("#tile-interval")).not_to_have_class(re.compile(r"\bcountdown\b"))
        ramp = [t for t in targets(page) if t not in (125, 250, 263)]
        assert len(ramp) >= 2 and all(150 <= t <= 300 for t in ramp), targets(page)
        assert ramp == sorted(ramp), ramp
        assert brake_writes(page)[-1] == [0x01, 0x00], brake_writes(page)
        expect(page.locator("#summary-stats")).to_contain_text("Average power")
        expect(page.locator("#summary-saved")).to_have_text("Saved to history.")
        expect(page.locator("#v-target")).to_have_text("--")
        expect(page.locator("#cue-text")).to_be_hidden()
        page.screenshot(path=str(out / "summary-desktop.png"))

        with page.expect_download() as info:
            page.click("#btn-download")
        download = info.value
        fit = Path(download.path()).read_bytes()
        assert fit[8:12] == b".FIT", fit[:14]
        assert download.suggested_filename.startswith("vigo-") and download.suggested_filename.endswith(".fit")
        assert b"Short test\0" in fit and b"Indoor cycling\0" in fit and b"RAMPA 12345\0" in fit, "FIT names"
        page.click("#btn-close")
        assert page.evaluate("localStorage.getItem('vigo.ride')") is None
        expect(page.locator(".tabs")).to_be_visible()
        tab("history")
        expect(history).to_have_count(1)
        expect(history.first).to_contain_text("Short test")
        shoot("history-desktop")

        # phone layout, mid ride
        page.set_viewport_size({"width": 390, "height": 844})
        tab("ride")
        shoot("ride-phone")
        page.click("#btn-start")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(out / "riding-phone.png"))
        assert page.evaluate("document.documentElement.scrollWidth") <= 390, "horizontal scroll on phone"

        # a reload mid ride puts the autosaved part in the history
        page.wait_for_timeout(1000)
        page.evaluate("window.onbeforeunload = null")
        page.reload()
        expect(page.locator(".banner.info")).to_contain_text("interrupted")
        expect(history).to_have_count(2)
        assert page.evaluate("localStorage.getItem('vigo.ride')") is None
        page.get_by_role("button", name="OK").click()
        expect(page.locator(".banner.info")).to_have_count(0)
        tab("history")
        expect(history.first).to_contain_text("stopped early")
        shoot("history-phone")

        # history: download, survive a reload on the history page, delete
        with page.expect_download() as info:
            history.nth(1).get_by_role("button", name="Download Short test as .FIT").click()
        assert Path(info.value.path()).read_bytes()[8:12] == b".FIT"
        page.reload()
        expect(body).to_have_attribute("data-view", "history")
        expect(history).to_have_count(2)
        history.first.get_by_role("button", name="Delete ride Short test").click()
        expect(history).to_have_count(1)
        assert any("Delete the ride" in m for _, m in dialogs)

        tab("settings")
        shoot("settings-phone")
        tab("ride")
        page.set_viewport_size({"width": 844, "height": 390})
        page.screenshot(path=str(out / "ride-phone-landscape.png"))
        page.set_viewport_size({"width": 390, "height": 844})

        # hostile workout name renders as text, in the list and in the history
        hostile = "<img src=x onerror=alert(1)>"
        tab("workouts")
        page.set_input_files("#file", str(FIXTURES / "hostile-name.mrc"))
        expect(rows.first).to_contain_text(hostile)
        tab("ride")
        expect(page.locator("#workout-name")).to_have_text(hostile)
        expect(page.locator("#workout-description")).to_have_text("<script>alert(2)</script> & <img src=x onerror=alert(3)>")
        expect_connected("trainer")  # came back by itself after the reloads
        # with the sounds off nothing plays
        tab("settings")
        page.uncheck("#sound")
        wait_until(page, "JSON.parse(localStorage.getItem('vigo.settings')).sound === false")
        tab("ride")
        silent_from = len(beeps(page))
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "running")
        page.wait_for_timeout(1200)
        expect(page.locator("#cue-text")).to_have_text(hostile)
        page.click("#btn-skip")
        page.click("#btn-skip")
        expect(page.locator("#summary")).to_be_visible()
        page.click("#btn-close")
        assert beeps(page)[silent_from:] == [], beeps(page)
        tab("settings")
        page.check("#sound")
        assert beeps(page)[-1] == 880, "turning sounds on plays a sample"
        tab("history")
        expect(history.first).to_contain_text(hostile)
        assert page.locator("img").count() == 0

        # backup: settings, uploads and rides in one file
        tab("settings")
        with page.expect_download() as info:
            page.click("#btn-backup")
        backup_path = out / "backup.json"
        info.value.save_as(backup_path)
        backup = json.loads(backup_path.read_text())
        assert backup["format"] == "vigo-backup" and backup["version"] == 1, backup.keys()
        ride_count = history.count()
        assert len(backup["rides"]) == ride_count and ride_count >= 2, (len(backup["rides"]), ride_count)
        assert any(hostile in w["text"] for w in backup["workouts"]), [w["fileName"] for w in backup["workouts"]]
        assert "devices" not in backup
        expect(page.locator("#backup-status")).to_contain_text(f"{ride_count} rides")
        upload_count = len(backup["workouts"])

        # a bad file shows an error and keeps the previous workout
        tab("workouts")
        page.set_input_files("#file", files=[{"name": "bad.mrc", "mimeType": "text/plain",
                                              "buffer": b"[COURSE HEADER]\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 50\n1 999\n"}])
        expect(page.locator("#setup-error")).to_contain_text("line 6")
        expect(page.locator("#workout-name")).to_have_text(hostile)
        expect(rows).to_have_count(9)

        # uploads can be deleted, built-ins can't
        expect(page.locator("#workout-list .icon-button")).to_have_count(2)
        page.get_by_role("button", name=f"Delete {hostile}").click()
        expect(rows).to_have_count(8)
        expect(page.locator("#workout-name")).to_have_text("Short test")
        shoot("workouts-phone")

        # a wheel size from before the list is kept as a custom entry
        page.evaluate("localStorage.setItem('vigo.settings', JSON.stringify({ftp: 250, wheel: 2110}))")
        page.goto(URL + "#/settings")
        page.reload()  # only the hash changed, so goto alone doesn't reload
        expect(page.locator("#wheel option:checked")).to_have_text("Custom (2110 mm)")
        page.select_option("#wheel", label="29×2.1")
        wait_until(page, "JSON.parse(localStorage.getItem('vigo.settings')).wheel === 2288")

        # saved devices connect by themselves after a reload
        page.reload()
        expect_connected("trainer", "hr", "csc")
        expect(page.locator(".banner.info")).to_have_count(0)

        # a trainer that is off is searched for until it shows up
        page.evaluate("window.__ble.setAvailable('trainer', false)")
        page.reload()
        expect_connected("trainer", status="searching")
        expect(device_row("trainer")).to_contain_text("searching")
        expect_connected("hr", "csc")
        page.wait_for_timeout(2500)  # a few failed attempts
        expect(device_row("trainer")).to_contain_text("last try: Bluetooth Device is no longer in range.")
        expect(page.get_by_role("button", name="Stop trainer")).to_be_visible()
        page.evaluate("window.__ble.setAvailable('trainer', true)")
        expect_connected("trainer")
        expect(device_row("trainer")).not_to_contain_text("last try")

        # switched on while vigo is still searching, and connected by hand: it stays connected
        page.evaluate("window.__ble.setAvailable('trainer', false)")
        expect_connected("trainer", status="reconnecting")
        page.wait_for_timeout(1500)
        page.evaluate("window.__ble.setAvailable('trainer', true, {advertise: false})")
        page.get_by_role("button", name="Replace trainer").click()
        expect_connected("trainer")
        page.wait_for_timeout(12000)  # longer than the retry timeout
        expect_connected("trainer")
        tab("ride")
        page.click("#btn-start")  # nothing to complain about once it's there
        expect(body).to_have_attribute("data-state", "running")

        # End opens one dialog with the ride so far: keep riding, Esc, discard
        page.wait_for_timeout(1200)
        dialogs_before = len(dialogs)
        rides_before = history.count()
        summary = page.locator("#summary")
        page.click("#btn-end")
        expect(summary).to_be_visible()
        expect(page.locator("#summary-title")).to_have_text("End the workout?")
        expect(page.locator("#summary-saved")).to_have_text("The ride is paused.")
        expect(body).to_have_attribute("data-state", "paused")
        page.wait_for_timeout(200)
        assert brake_writes(page)[-1] == [0x01, 0x00], "the trainer lets go while deciding"
        assert len(dialogs) == dialogs_before, "no browser popup on End"
        page.screenshot(path=str(out / "end-ask-desktop.png"))
        page.get_by_role("button", name="Keep riding").click()
        expect(summary).to_be_hidden()
        expect(body).to_have_attribute("data-state", "running")
        page.click("#btn-end")
        expect(summary).to_be_visible()
        page.keyboard.press("Escape")
        expect(summary).to_be_hidden()
        expect(body).to_have_attribute("data-state", "running")
        page.click("#btn-end")
        page.get_by_role("button", name="Discard ride").click()
        expect(summary).to_be_hidden()
        expect(body).to_have_attribute("data-state", "finished")
        page.wait_for_timeout(300)
        assert history.count() == rides_before, "a discarded ride is not saved"
        assert page.evaluate("localStorage.getItem('vigo.ride')") is None

        # auto connect can be turned off
        tab("settings")
        page.uncheck("#auto-connect")
        page.reload()
        page.wait_for_timeout(1500)
        expect_connected("trainer", "hr", "csc", status="disconnected")
        page.get_by_role("button", name="Connect trainer").click()  # no picker needed, the browser still allows it
        expect_connected("trainer")
        page.check("#auto-connect")

        # unregister the heart rate strap: disconnected, forgotten, not connected after a reload
        page.reload()
        expect_connected("trainer", "hr", "csc")
        page.get_by_role("button", name="Unregister heart rate").click()
        expect(device_row("hr")).to_contain_text("Not registered")
        expect_connected("hr", status="disconnected")
        assert "hr" in page.evaluate("window.__ble.forgotten")
        assert any("Unregister HRM-Fake?" in m for _, m in dialogs)
        page.reload()
        expect_connected("trainer", "csc")
        page.wait_for_timeout(1000)
        expect_connected("hr", status="disconnected")
        expect(page.get_by_role("button", name="Unregister heart rate")).to_be_hidden()

        # a hostile device name is text
        page.evaluate(f"sessionStorage.setItem('fakeble.names', JSON.stringify({{trainer: 'RAMPA 12345', hr: {json.dumps(hostile)}, csc: 'CSC-Fake'}}))")
        page.reload()
        page.get_by_role("button", name="Register heart rate", exact=True).click()
        expect(device_row("hr")).to_contain_text(hostile)
        assert page.locator("img").count() == 0
        page.set_viewport_size({"width": 390, "height": 844})
        shoot("settings-devices-phone")

        # a very hard workout: capped at 2 x FTP, shown, and confirmed before starting
        page.set_viewport_size({"width": 1280, "height": 800})
        tab("workouts")
        page.set_input_files("#file", files=[{"name": "sprints.mrc", "mimeType": "text/plain",
            "buffer": b"[COURSE HEADER]\nFILE NAME = Way too hard\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 250\n0.05 250\n[END COURSE DATA]\n"}])
        expect(rows.first).to_contain_text("Way too hard")
        tab("ride")
        expect(page.locator("#workout-meta")).to_contain_text("avg 500 W")
        expect(page.locator("#workout-meta")).to_contain_text("peaks at 500 W (capped)")
        expect(page.locator("#v-target")).to_have_text("500")
        expect_connected("trainer")
        writes_before = len(brake_writes(page))
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "running")
        assert any("Way too hard goes up to 500 W, 200% of your FTP. Start it?" == m for _, m in dialogs), dialogs[-3:]
        wait_until(page, f"window.__ble.writes.length > {writes_before}")
        sent = [w[1] | (w[2] << 8) for w in brake_writes(page)[writes_before:] if w[0] == 0]
        assert sent and max(sent) == 500, sent

        # End, then Save ride: the same dialog turns into the saved summary
        page.wait_for_timeout(1200)
        rides_before = history.count()
        page.click("#btn-end")
        page.get_by_role("button", name="Save ride").click()
        expect(page.locator("#summary-title")).to_have_text("Ride done")
        expect(page.locator("#summary-saved")).to_have_text("Saved to history.")
        expect(page.get_by_role("button", name="Download .FIT")).to_be_visible()
        expect(page.get_by_role("button", name="Save ride")).to_be_hidden()
        expect(history).to_have_count(rides_before + 1)
        expect(history.first).to_contain_text("Way too hard")
        page.screenshot(path=str(out / "end-saved-desktop.png"))
        page.click("#btn-close")

        # unknown views fall back to the ride view
        page.goto(URL + "#/__proto__")
        expect(body).to_have_attribute("data-view", "ride")

        # inside another page's frame vigo refuses to run, so its buttons can't be clickjacked
        # the framing page is another origin (localhost vs 127.0.0.1); a blank page can't frame a local server
        evil = f"http://localhost:{PORT}/framing-page.html"
        page.route(evil, lambda route: route.fulfill(
            content_type="text/html", body=f'<!doctype html><iframe src="{URL}" width="900" height="600"></iframe>'))
        page.goto(evil)
        frame = page.frame_locator("iframe")
        expect(frame.locator("body")).to_contain_text("only works when it is opened directly")
        expect(frame.locator("#btn-start")).to_have_count(0)
        expect(frame.get_by_role("link", name="Open vigo")).to_have_attribute("target", "_top")

        context.close()

        # Chrome without the Web Bluetooth flags: no getDevices, one tap per saved device
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script("window.__bleNoGetDevices = true")
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}\n{e.stack}"))
        page.on("dialog", on_dialog)
        body = page.locator("body")
        page.goto(URL + "#/settings")
        expect(page.locator("#device-mode")).to_contain_text("chrome://flags/#enable-experimental-web-platform-features")
        expect(page.locator("#device-mode")).to_contain_text("chrome://flags/#enable-web-bluetooth-new-permissions-backend")
        register_all()
        shoot("settings-one-tap-desktop")
        page.reload()
        info = page.locator(".banner.info")
        expect(info).to_contain_text("need a tap")
        expect(info.get_by_role("button")).to_have_count(3)
        page.wait_for_timeout(500)
        expect_connected("trainer", "hr", "csc", status="disconnected")

        # start offers to connect the saved trainer
        page.locator('[data-tab="ride"]').click()
        page.click("#btn-start")
        expect(page.locator(".banner.error")).to_contain_text("RAMPA 12345 is not connected")
        page.locator(".banner.error").get_by_role("button", name="Connect RAMPA 12345").click()
        expect_connected("trainer")
        assert page.evaluate("window.__ble.requests.at(-1).filters[0].name") == "RAMPA 12345"
        expect(page.locator(".banner.error")).to_have_count(0)
        expect(info.get_by_role("button")).to_have_count(2)
        info.get_by_role("button", name="Connect HRM-Fake").click()
        expect_connected("hr")
        info.get_by_role("button", name="Connect CSC-Fake").click()
        expect_connected("csc")
        expect(info).to_have_count(0)
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(URL + "#/settings")
        shoot("settings-one-tap-phone")
        context.close()

        # the experimental flag without the new permissions backend: getDevices() exists,
        # but Chrome forgets the devices on every reload, so it falls back to one tap each
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script("window.__bleNoPersist = true")
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}\n{e.stack}"))
        page.on("dialog", on_dialog)
        body = page.locator("body")
        page.goto(URL + "#/settings")
        expect(page.locator("#device-mode")).to_contain_text("Automatic")
        register_all()
        page.reload()
        info = page.locator(".banner.info")
        expect(info).to_contain_text("need a tap")
        expect(info.get_by_role("button")).to_have_count(3)
        expect_connected("trainer", "hr", "csc", status="disconnected")
        expect(page.locator("#device-mode")).to_contain_text("Chrome forgot your devices")
        expect(page.locator("#device-mode")).to_contain_text("chrome://flags/#enable-web-bluetooth-new-permissions-backend")
        info.get_by_role("button", name="Connect RAMPA 12345").click()
        expect_connected("trainer")
        assert page.evaluate("window.__ble.requests.at(-1).filters[0].name") == "RAMPA 12345"
        info.get_by_role("button", name="Connect HRM-Fake").click()
        info.get_by_role("button", name="Connect CSC-Fake").click()
        expect_connected("hr", "csc")
        expect(info).to_have_count(0)

        # a ride works as usual, and a dropout reconnects without a picker
        page.locator('[data-tab="ride"]').click()
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "running")
        requests = page.evaluate("window.__ble.requests.length")
        page.evaluate("window.__ble.dropTrainer()")
        expect_connected("trainer", status="reconnecting")
        expect_connected("trainer")
        expect(body).to_have_attribute("data-state", "running")
        assert page.evaluate("window.__ble.requests.length") == requests, "no picker for a reconnect"
        shoot("settings-forgot-desktop")
        context.close()

        # FTMS trainers: with Cycling Power, with only Indoor Bike Data (cadence 92 from there), and
        # one with an Elite service that has no brake, which has to fall through to FTMS
        for trainer, cadence, name in (("ftms", "90", "KICKR-Fake"), ("ftms-ibd", "92", "KICKR-Fake"),
                                       ("elite-ftms", "90", "Drivo-Fake")):
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            context.add_init_script(f"try {{ sessionStorage.setItem('fakeble.trainer', {json.dumps(json.dumps(trainer))}) }} catch(_) {{}}")
            context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
            page = context.new_page()
            page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}\n{e.stack}"))
            page.on("dialog", on_dialog)
            body = page.locator("body")
            page.goto(URL + "#/settings")
            page.get_by_role("button", name="Register trainer", exact=True).click()
            expect_connected("trainer")
            expect(device_row("trainer")).to_contain_text(name)
            expect(device_row("trainer")).to_contain_text("connected · FTMS")
            assert brake_writes(page) == [[0x00]], brake_writes(page)  # control requested, nothing else yet
            shoot(f"settings-devices-{trainer}-desktop")

            # start, then the target
            page.locator('[data-tab="ride"]').click()
            page.click("#btn-start")
            expect(body).to_have_attribute("data-state", "running")
            wait_until(page, "window.__ble.writes.length >= 3")
            writes = brake_writes(page)
            assert writes[:2] == [[0x00], [0x07]] and writes[2][0] == 0x05, writes
            assert page.evaluate("window.__ble.target") > 0
            expect(page.locator("#v-power")).not_to_have_text("--", timeout=3000)
            expect(page.locator("#v-cadence")).to_have_text(cadence, timeout=4000)

            # pause lets go, resume starts again before the target
            page.click("#btn-start")
            expect(body).to_have_attribute("data-state", "paused")
            page.wait_for_timeout(200)
            assert brake_writes(page)[-1] == [0x08, 0x02], brake_writes(page)
            page.click("#btn-start")
            page.wait_for_timeout(300)
            assert brake_writes(page)[-2][0] == 0x07 and brake_writes(page)[-1][0] == 0x05, brake_writes(page)[-3:]

            # a dropout asks for control again, a trainer that refuses keeps being retried
            page.evaluate("window.__ble.refuseControl = true")
            page.evaluate("window.__ble.dropTrainer()")
            expect_connected("trainer", status="reconnecting")
            expect(device_row("trainer")).to_contain_text("control not permitted", timeout=4000)
            mark = len(brake_writes(page))
            page.evaluate("window.__ble.refuseControl = false")
            expect_connected("trainer")
            expect(body).to_have_attribute("data-state", "running")
            page.wait_for_timeout(300)
            after = brake_writes(page)[mark:]
            assert after[:3] == [[0x00], [0x07], after[2]] and after[2][0] == 0x05, after
            expect(page.locator("#v-target-note")).not_to_have_text("Pedal faster")
            page.screenshot(path=str(out / f"riding-{trainer}-desktop.png"))

            page.click("#btn-end")
            page.get_by_role("button", name="Discard ride").click()
            page.wait_for_timeout(200)
            assert brake_writes(page)[-1] == [0x08, 0x02], brake_writes(page)[-3:]
            page.set_viewport_size({"width": 390, "height": 844})
            page.goto(URL + "#/settings")
            expect_connected("trainer")
            shoot(f"settings-devices-{trainer}-phone")
            context.close()

        # auto-start waits for the first pedal strokes, auto-pause stops the clock when the rider stops
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        context.add_init_script(FAKE_AUDIO)
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        page = context.new_page()
        page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}\n{e.stack}"))
        page.on("dialog", on_dialog)
        body = page.locator("body")
        page.goto(URL + "#/settings")

        # restore the backup into this empty browser, a non-backup file is refused
        (out / "not-a-backup.json").write_text('{"hello": 1}')
        page.set_input_files("#restore-file", str(out / "not-a-backup.json"))
        expect(page.locator("#backup-error")).to_contain_text("not a vigo backup")
        page.set_input_files("#restore-file", str(backup_path))
        expect(page.locator("#backup-status")).to_contain_text(f"Restored {upload_count} workout")
        assert any(m.startswith("Restore ") for _, m in dialogs[-1:]), dialogs[-1:]
        expect(page.locator("#ftp")).to_have_value(str(backup["settings"]["ftp"]))
        shoot("settings-backup-desktop")
        page.locator('[data-tab="history"]').click()
        expect(page.locator("#history-list li")).to_have_count(ride_count)
        expect(page.locator("#history-list li").first).to_contain_text(hostile)
        assert page.locator("img").count() == 0
        page.locator('[data-tab="workouts"]').click()
        expect(page.locator("#workout-list")).to_contain_text(hostile)
        page.locator('[data-tab="settings"]').click()

        page.get_by_role("button", name="Register trainer", exact=True).click()
        expect_connected("trainer")
        page.select_option("#auto-pause", "5")
        page.check("#auto-start")
        wait_until(page, "JSON.parse(localStorage.getItem('vigo.settings')).autoStart === true")
        saved = page.evaluate("JSON.parse(localStorage.getItem('vigo.settings'))")
        assert saved["autoPause"] == 5 and saved["autoStart"] is True, saved
        shoot("settings-auto-desktop")
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator("#auto-start").scroll_into_view_if_needed()
        page.screenshot(path=str(out / "settings-auto-phone.png"))
        page.set_viewport_size({"width": 1280, "height": 800})
        page.reload()
        expect(page.locator("#auto-pause")).to_have_value("5")
        expect(page.locator("#auto-start")).to_be_checked()
        expect_connected("trainer")

        page.evaluate("window.__ble.pedaling = false")
        page.locator('[data-tab="ride"]').click()
        page.wait_for_timeout(3200)  # the 3 s power average empties
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "waiting")
        expect(page.locator("#btn-start")).to_have_text("Cancel")
        expect(page.locator("#cue-text")).to_have_text("Start pedaling to begin")
        expect(page.locator(".tabs")).to_be_hidden()
        page.wait_for_timeout(1000)
        expect(page.locator("#v-elapsed")).to_have_text("0:00")
        assert targets(page) == [], brake_writes(page)
        page.screenshot(path=str(out / "waiting-desktop.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(out / "waiting-phone.png"))
        page.set_viewport_size({"width": 1280, "height": 800})
        # Cancel goes back, Start again waits again
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "idle")
        expect(page.locator("#btn-start")).to_have_text("Start")
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "waiting")

        page.evaluate("window.__ble.pedaling = true")
        expect(body).to_have_attribute("data-state", "running", timeout=3000)
        wait_until(page, "window.__ble.writes.some((w) => w[0] === 0)")

        # 3 s for the power average to empty, then the 5 s delay
        page.evaluate("window.__ble.pedaling = false")
        expect(body).to_have_attribute("data-state", "paused", timeout=12000)
        expect(page.locator("#btn-start")).to_have_text("Resume")
        expect(page.locator("#cue-text")).to_have_text("Paused. Pedal to resume")
        page.wait_for_timeout(200)
        assert brake_writes(page)[-1] == [0x01, 0x00], brake_writes(page)[-3:]
        page.evaluate("window.__ble.pedaling = true")
        expect(body).to_have_attribute("data-state", "running", timeout=3000)
        page.wait_for_timeout(300)
        assert brake_writes(page)[-1][0] == 0, brake_writes(page)[-3:]

        # a pause from the button stays, even while pedaling
        page.click("#btn-start")
        expect(body).to_have_attribute("data-state", "paused")
        page.wait_for_timeout(1500)
        expect(body).to_have_attribute("data-state", "paused")
        expect(page.locator("#cue-text")).not_to_have_text("Paused. Pedal to resume")
        page.click("#btn-end")
        page.get_by_role("button", name="Discard ride").click()
        context.close()

        drive_pass(browser, out, errors, dialogs)
        browser.close()

    alerts = [d for d in dialogs if d[0] == "alert"]
    problems = errors + [f"unexpected alert: {m}" for _, m in alerts]
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)
    print(f"ui test passed, screenshots in {out}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    server = subprocess.Popen([sys.executable, str(REPO / "tools" / "serve.py"), "--port", str(PORT), "--prefix", "/vigo/"],
                              stderr=subprocess.DEVNULL)
    try:
        wait_for_server()
        run(args.out)
    finally:
        server.terminate()


if __name__ == "__main__":
    main()
