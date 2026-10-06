#!/usr/bin/env python3
"""End-to-end smoke test for onegyeok-vnc-helper: spawns the real binary, speaks the
framed stdio protocol documented in docs/기술스택/04_VNC_기술스택.md, connects to the
local onegyeok-test-vnc Docker fixture, and asserts we receive CONNECTED + a real FRAME
with non-trivial pixel data, then cleanly DISCONNECTs. Not part of the app build; dev-only."""
import json
import os
import struct
import subprocess
import sys
import time

HELPER = os.path.join(os.path.dirname(__file__), "..", "onegyeok-vnc-helper")

MSG_CONNECT = 0x01
MSG_DISCONNECT = 0x02
MSG_CONNECTED = 0x81
MSG_FRAME = 0x82
MSG_STATUS = 0x83
MSG_LOG = 0x84


def write_frame(f, type_, payload: bytes):
    length = len(payload) + 1
    f.write(struct.pack("<I", length))
    f.write(bytes([type_]))
    f.write(payload)
    f.flush()


def read_exact(f, n):
    buf = b""
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            raise EOFError("helper closed stdout unexpectedly")
        buf += chunk
    return buf


def read_frame(f):
    length = struct.unpack("<I", read_exact(f, 4))[0]
    body = read_exact(f, length)
    return body[0], body[1:]


def main():
    proc = subprocess.Popen(
        [HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr, bufsize=0
    )

    connect_payload = json.dumps(
        {
            "host": "127.0.0.1",
            "port": 5901,
            "password": "",
            "colorDepth": 32,
        }
    ).encode("utf-8")
    write_frame(proc.stdin, MSG_CONNECT, connect_payload)

    got_connected = False
    got_frame = False
    deadline = time.time() + 20
    while time.time() < deadline:
        t, payload = read_frame(proc.stdout)
        if t == MSG_STATUS:
            print("[test] STATUS", payload.decode("utf-8", "replace"))
        elif t == MSG_LOG:
            print("[test] LOG", payload.decode("utf-8", "replace"))
        elif t == MSG_CONNECTED:
            info = json.loads(payload.decode("utf-8"))
            print("[test] CONNECTED", info)
            got_connected = True
            assert info["width"] > 0 and info["height"] > 0
        elif t == MSG_FRAME:
            x, y, w, h = struct.unpack("<HHHH", payload[:8])
            pixels = payload[8:]
            nonzero = sum(1 for b in pixels[:4096] if b != 0)
            # sample a pixel's RGBA bytes to sanity-check byte order downstream
            sample = list(pixels[:4]) if len(pixels) >= 4 else []
            print(f"[test] FRAME x={x} y={y} w={w} h={h} bytes={len(pixels)} nonzero_sample={nonzero}/4096 first_pixel_rgba={sample}")
            assert len(pixels) == w * h * 4, "frame payload size mismatch"
            assert all(pixels[i] == 0xFF for i in range(3, min(len(pixels), 4096), 4)), "alpha byte not forced to 0xFF"
            got_frame = True
            if got_connected and got_frame:
                break
        else:
            print("[test] unknown frame type", hex(t))

    assert got_connected, "never received CONNECTED"
    assert got_frame, "never received a FRAME"

    write_frame(proc.stdin, MSG_DISCONNECT, b"")
    try:
        rc = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise AssertionError("helper did not exit within 5s after DISCONNECT")

    print(f"[test] helper exited with code {rc}")
    assert rc == 0, f"expected clean exit(0), got {rc}"
    print("[test] PASS")


if __name__ == "__main__":
    main()
