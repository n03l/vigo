#!/usr/bin/env python3
"""A fake FTMS smart trainer over real Bluetooth, to test vigo without one.

Runs on Linux with BlueZ (a Raspberry Pi works) and advertises a Fitness Machine (0x1826) trainer,
plus Cycling Power (0x1818) unless --no-cps. Open vigo in Chrome on another device (phone or laptop)
and register it as the trainer. Every control point command it gets is logged; the power it reports
eases towards the target, at 85 ± 3 rpm.

    python3 -m venv ~/ftms && ~/ftms/bin/pip install bless
    ~/ftms/bin/python tools/ftms_emulator.py [--name FTMS-EMU] [--no-cps] [--reject-control]

The user needs access to BlueZ over D-Bus (on Raspberry Pi OS the default user has it, else use sudo).
A dev tool only: no network, nothing stored. `--self-test` checks the protocol logic without Bluetooth.
"""

import argparse
import asyncio
import logging
import random
import struct
import time

FTMS = "00001826-0000-1000-8000-00805f9b34fb"
FTMS_FEATURE = "00002acc-0000-1000-8000-00805f9b34fb"
INDOOR_BIKE_DATA = "00002ad2-0000-1000-8000-00805f9b34fb"
POWER_RANGE = "00002ad8-0000-1000-8000-00805f9b34fb"
CONTROL_POINT = "00002ad9-0000-1000-8000-00805f9b34fb"
CPS = "00001818-0000-1000-8000-00805f9b34fb"
CPS_MEASUREMENT = "00002a63-0000-1000-8000-00805f9b34fb"
CPS_FEATURE = "00002a65-0000-1000-8000-00805f9b34fb"
SENSOR_LOCATION = "00002a5d-0000-1000-8000-00805f9b34fb"

SUCCESS, NOT_SUPPORTED, INVALID_PARAMETER, NOT_PERMITTED = 0x01, 0x02, 0x03, 0x05
MAX_POWER = 2000

log = logging.getLogger("ftms")


class Trainer:
    """The control point state machine and the simulated rider, no Bluetooth in here."""

    def __init__(self, reject_control=False):
        self.reject_control = reject_control
        self.in_control = False
        self.started = False
        self.target = 0
        self.power = 0.0
        self.cadence = 85.0
        self.crank_revs = 0.0
        self.crank_time = 0.0  # s, of the last whole crank revolution

    # bytes -> bytes, the indication answering a control point write
    def control(self, data):
        if not data:
            return bytes([0x80, 0x00, INVALID_PARAMETER])
        op = data[0]
        result = self._control(op, bytes(data[1:]))
        log.info("control point %s -> %s", data.hex(" "), {SUCCESS: "ok", NOT_SUPPORTED: "not supported",
                 INVALID_PARAMETER: "invalid parameter", NOT_PERMITTED: "not permitted"}[result])
        return bytes([0x80, op, result])

    def _control(self, op, params):
        if op == 0x00:  # request control
            if self.reject_control:
                return NOT_PERMITTED
            self.in_control = True
            return SUCCESS
        if not self.in_control:
            return NOT_PERMITTED
        if op == 0x01:  # reset
            self.in_control = self.started = False
            self.target = 0
            return SUCCESS
        if op == 0x05:  # set target power, sint16 W
            if len(params) != 2:
                return INVALID_PARAMETER
            watts = struct.unpack("<h", params)[0]
            if not 0 <= watts <= MAX_POWER:
                return INVALID_PARAMETER
            self.target = watts
            log.info("target %d W%s", watts, "" if self.started else " (not started yet)")
            return SUCCESS
        if op == 0x07:  # start or resume
            self.started = True
            return SUCCESS
        if op == 0x08:  # stop (1) or pause (2)
            if len(params) != 1 or params[0] not in (1, 2):
                return INVALID_PARAMETER
            self.started = False
            log.info("%s", "stop" if params[0] == 1 else "pause")
            return SUCCESS
        return NOT_SUPPORTED

    # advance the rider by dt seconds
    def step(self, dt):
        goal = self.target if self.started else 60  # freewheeling-ish when not in ERG
        self.power += (goal - self.power) * min(1.0, dt / 1.5)
        self.cadence = max(60.0, min(110.0, self.cadence + random.uniform(-1, 1)))
        self.cadence += (85 - self.cadence) * 0.1
        before = int(self.crank_revs)
        self.crank_revs += self.cadence / 60 * dt
        if int(self.crank_revs) != before:
            self.crank_time = time.monotonic()

    def reported_power(self):
        return max(0, round(self.power + random.uniform(-3, 3)))

    # flags: more data (no speed), cadence, power
    def indoor_bike_data(self):
        return struct.pack("<HHh", 0x0044 | 0x0001, round(self.cadence * 2), self.reported_power())

    # flags: crank revolution data
    def cycling_power(self):
        return struct.pack("<HhHH", 0x0020, self.reported_power(),
                           int(self.crank_revs) & 0xFFFF, round(self.crank_time * 1024) & 0xFFFF)


def self_test():
    t = Trainer()
    assert t.control(b"\x05\xc8\x00") == bytes([0x80, 0x05, NOT_PERMITTED]), "control first"
    assert t.control(b"\x00") == bytes([0x80, 0x00, SUCCESS])
    assert t.control(b"\x07") == bytes([0x80, 0x07, SUCCESS])
    assert t.control(b"\x05\xc8\x00") == bytes([0x80, 0x05, SUCCESS]) and t.target == 200
    assert t.control(b"\x05\xc8") == bytes([0x80, 0x05, INVALID_PARAMETER])
    assert t.control(b"\x05\xff\xff") == bytes([0x80, 0x05, INVALID_PARAMETER])  # -1 W
    assert t.control(b"\x08\x02") == bytes([0x80, 0x08, SUCCESS]) and not t.started
    assert t.control(b"\x08\x07") == bytes([0x80, 0x08, INVALID_PARAMETER])
    assert t.control(b"\x42") == bytes([0x80, 0x42, NOT_SUPPORTED])
    assert t.control(b"") == bytes([0x80, 0x00, INVALID_PARAMETER])
    t.control(b"\x07")
    for _ in range(40):
        t.step(0.25)
    assert abs(t.power - 200) < 5, t.power
    flags, cadence, power = struct.unpack("<HHh", t.indoor_bike_data())
    assert flags == 0x45 and 150 <= cadence <= 190 and 190 <= power <= 210, (flags, cadence, power)
    assert Trainer(reject_control=True).control(b"\x00") == bytes([0x80, 0x00, NOT_PERMITTED])
    print("self test passed")


async def serve(args):
    from bless import BlessServer, GATTAttributePermissions, GATTCharacteristicProperties

    Props, Perms = GATTCharacteristicProperties, GATTAttributePermissions
    trainer = Trainer(reject_control=args.reject_control)
    loop = asyncio.get_running_loop()
    server = BlessServer(name=args.name, loop=loop)

    def on_read(characteristic, **_):
        return characteristic.value

    def on_write(characteristic, value, **_):
        if str(characteristic.uuid).lower() != CONTROL_POINT:
            return
        reply = trainer.control(bytes(value))

        # answer after the write itself has completed
        def indicate():
            server.get_characteristic(CONTROL_POINT).value = bytearray(reply)
            server.update_value(FTMS, CONTROL_POINT)
        loop.call_soon(indicate)

    server.read_request_func = on_read
    server.write_request_func = on_write

    async def add(service, uuid, props, value=b"", perms=Perms.readable):
        await server.add_new_characteristic(service, uuid, props, bytearray(value), perms)

    await server.add_new_service(FTMS)
    # features: cadence, power measurement; target settings: power
    await add(FTMS, FTMS_FEATURE, Props.read, struct.pack("<II", 0x4002, 0x0008))
    await add(FTMS, INDOOR_BIKE_DATA, Props.notify)
    await add(FTMS, POWER_RANGE, Props.read, struct.pack("<hhH", 0, MAX_POWER, 1))
    await add(FTMS, CONTROL_POINT, Props.write | Props.indicate, b"", Perms.writeable)
    if not args.no_cps:
        await server.add_new_service(CPS)
        await add(CPS, CPS_MEASUREMENT, Props.notify)
        await add(CPS, CPS_FEATURE, Props.read, struct.pack("<I", 0x08))  # crank revolution data
        await add(CPS, SENSOR_LOCATION, Props.read, b"\x0d")  # rear hub

    await server.start()
    log.info("advertising as %s (FTMS%s)%s", args.name, "" if args.no_cps else " + Cycling Power",
             ", refusing control" if args.reject_control else "")

    tick, last_log = 0.25, 0.0
    try:
        while True:
            await asyncio.sleep(tick)
            trainer.step(tick)
            server.get_characteristic(INDOOR_BIKE_DATA).value = bytearray(trainer.indoor_bike_data())
            server.update_value(FTMS, INDOOR_BIKE_DATA)
            if not args.no_cps:
                server.get_characteristic(CPS_MEASUREMENT).value = bytearray(trainer.cycling_power())
                server.update_value(CPS, CPS_MEASUREMENT)
            if time.monotonic() - last_log > 5:
                last_log = time.monotonic()
                log.info("power %.0f W, target %d W, %s, %.0f rpm", trainer.power, trainer.target,
                         "started" if trainer.started else "paused", trainer.cadence)
    finally:
        await server.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", default="FTMS-EMU", help="advertised name (default FTMS-EMU)")
    parser.add_argument("--no-cps", action="store_true", help="no Cycling Power, data on Indoor Bike Data only")
    parser.add_argument("--reject-control", action="store_true", help="refuse control, to test the error path")
    parser.add_argument("--self-test", action="store_true", help="check the protocol logic and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    if args.self_test:
        self_test()
        return
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        # dbus_next.errors.DBusError, without importing dbus_next here
        if "org.bluez" not in str(error):
            raise
        raise SystemExit(f"BlueZ isn't running ({error}).\n"
                         "Install and start it: sudo apt install bluez pi-bluetooth && "
                         "sudo systemctl enable --now bluetooth\n"
                         "Then `bluetoothctl show` should list a powered controller.")


if __name__ == "__main__":
    main()
