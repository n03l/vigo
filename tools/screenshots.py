#!/usr/bin/env python3
"""Screenshots for the README, taken mid ride with fake Bluetooth devices and a fake clock.

    ~/.venv/bin/python tools/screenshots.py
"""

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "docs" / "screenshots"
PORT = 8096
URL = f"http://127.0.0.1:{PORT}/vigo/"


def wait_for_server():
    for _ in range(50):
        try:
            urllib.request.urlopen(URL, timeout=0.5)
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("dev server did not start")


def live(page):
    # after jumping the clock, let a few seconds of sensor data come in so no tile reads -- or 0
    page.clock.run_for(3000)
    expect(page.locator("#v-power")).not_to_have_text("--")
    expect(page.locator("#v-cadence")).not_to_have_text("0")
    expect(page.locator("#v-hr")).not_to_have_text("--")


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
        # plain device names instead of the test fakes
        context.add_init_script("""sessionStorage.setItem('fakeble.names',
            JSON.stringify({trainer: 'RAMPA 12345', hr: 'HR strap', csc: 'Speed/cad'}))""")
        context.add_init_script(path=str(REPO / "tools" / "fake_ble.js"))
        # the committed id, without the + for local changes
        commit = subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=REPO, capture_output=True,
                                text=True, check=True).stdout.strip()
        context.route("**/version.json", lambda route: route.fulfill(json={"commit": commit}))
        page = context.new_page()
        page.on("dialog", lambda d: d.accept())
        page.clock.install()
        page.goto(URL + "#/settings")

        page.fill("#ftp", "250")
        page.locator("#ftp").dispatch_event("change")
        for label in ("trainer", "heart rate", "speed/cadence"):
            page.get_by_role("button", name=f"Register {label}", exact=True).click()
        for kind in ("trainer", "hr", "csc"):
            expect(page.locator(f"#dev-{kind}")).to_have_attribute("data-status", "connected")

        page.locator('[data-tab="workouts"]').click()
        page.get_by_role("button", name="Sweet Spot 3×10").click()

        # 22 minutes into the workout: second sweet spot interval
        page.click("#btn-start")
        page.clock.run_for(22 * 60 * 1000)
        live(page)
        page.screenshot(path=str(OUT / "ride-desktop.png"))

        page.click("#btn-start")  # pause, so the tabs come back
        page.click("#btn-end")
        page.click("#btn-discard")
        page.locator('[data-tab="workouts"]').click()
        page.screenshot(path=str(OUT / "workouts-desktop.png"))
        browser.close()


def main():
    server = subprocess.Popen([sys.executable, str(REPO / "tools" / "serve.py"), "--port", str(PORT), "--prefix", "/vigo/"],
                              stderr=subprocess.DEVNULL)
    try:
        wait_for_server()
        run()
    finally:
        server.terminate()
    print(f"screenshots in {OUT}")


if __name__ == "__main__":
    main()
