#!/usr/bin/env python3
"""Spinning ASCII NixOS snowflake wallpaper (donut.c style) on a GTK layer-shell surface.

Run via the nix-spin systemd user service (home/nix-spin.nix), which provides the GTK libs.
  --preview out.png [--angle 0.35]   render one frame to PNG for tuning
"""
import argparse
import fcntl
import math
import os
import sys
import time

import cairo
import gi
import numpy as np

gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SVG = os.path.join(HERE, "nix-logo.svg")

COLS, ROWS = 112, 60
FPS, PERIOD = 15, 12  # 180 frames per full turn
RAMP = ".,-~:;=!*#$@"
FONT = "SUSE Mono"
# Catppuccin Mocha, one per lambda, indexed by the lambda's position (0 = right, then
# counter-clockwise in 60° steps), matching the Catppuccin NixOS logo
COLORS = [(0xf9, 0xe2, 0xaf), (0xfa, 0xb3, 0x87), (0xf5, 0xc2, 0xe7),  # yellow, peach, pink
          (0xcb, 0xa6, 0xf7), (0x89, 0xb4, 0xfa), (0xa6, 0xe3, 0xa1)]  # mauve, blue, green
COLORS = [tuple(c / 255 for c in rgb) for rgb in COLORS]
LIGHT = np.array([-0.35, 0.45, 0.82]) / np.linalg.norm([-0.35, 0.45, 0.82])
AMBIENT = 0.22
DEPTH = 0.16  # half thickness of the extruded logo
MASK_PX = 100
WALL_STEPS = 12


def mask():
    """Logo silhouette as a MASK_PX x MASK_PX bool array (True = inside)."""
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, MASK_PX, MASK_PX)
    rect = Rsvg.Rectangle()
    rect.x, rect.y, rect.width, rect.height = 0, 0, MASK_PX, MASK_PX
    Rsvg.Handle.new_from_file(SVG).render_document(cairo.Context(surf), rect)
    surf.flush()
    px = np.frombuffer(surf.get_data(), np.uint8).reshape(MASK_PX, surf.get_stride() // 4, 4)
    return px[:, :MASK_PX, 3] > 128  # ARGB32 is BGRA in memory


def labels(m):
    """Colour index per mask pixel: flood-fill the six separate lambdas, then index each
    by the angle of its centroid (see COLORS)."""
    comp = np.zeros(m.shape, int)
    n = 0
    for seed in zip(*np.nonzero(m)):
        if comp[seed]:
            continue
        n += 1
        comp[seed] = n
        stack = [seed]
        while stack:
            i, j = stack.pop()
            for a, b in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                if 0 <= a < MASK_PX and 0 <= b < MASK_PX and m[a, b] and not comp[a, b]:
                    comp[a, b] = n
                    stack.append((a, b))
    out = np.zeros(m.shape, np.uint8)
    for k in range(1, n + 1):
        i, j = np.nonzero(comp == k)
        angle = math.degrees(math.atan2(MASK_PX / 2 - i.mean(), j.mean() - MASK_PX / 2))
        out[comp == k] = round(angle / 60) % len(COLORS)
    return out


def mesh():
    """Points, normals and colour indices: front/back faces plus extruded side walls
    (incl. inner cutouts)."""
    m = mask()
    lab = labels(m)
    i, j = np.nonzero(m)
    x = (j - MASK_PX / 2) / (MASK_PX / 2)
    y = (MASK_PX / 2 - i) / (MASK_PX / 2)
    ones, zeros = np.ones_like(x), np.zeros_like(x)

    pts = [np.c_[x, y, ones * DEPTH], np.c_[x, y, -ones * DEPTH]]
    nrm = [np.c_[zeros, zeros, ones], np.c_[zeros, zeros, -ones]]
    col = [lab[i, j], lab[i, j]]

    # Edge pixels: any 4-neighbour outside. Outward normal points away from the inside.
    p = np.pad(m, 1).astype(float)
    left, right = p[1:-1, :-2], p[1:-1, 2:]
    up, down = p[:-2, 1:-1], p[2:, 1:-1]
    edge = m & ((left + right + up + down) < 4)
    nx, ny = (left - right)[edge], (down - up)[edge]
    length = np.hypot(nx, ny)
    keep = length > 0
    ei, ej = np.nonzero(edge)
    ex = ((ej - MASK_PX / 2) / (MASK_PX / 2))[keep]
    ey = ((MASK_PX / 2 - ei) / (MASK_PX / 2))[keep]
    nx, ny = (nx / np.where(length, length, 1))[keep], (ny / np.where(length, length, 1))[keep]
    for z in np.linspace(-DEPTH, DEPTH, WALL_STEPS):
        pts.append(np.c_[ex, ey, np.full_like(ex, z)])
        nrm.append(np.c_[nx, ny, np.zeros_like(nx)])
        col.append(lab[ei, ej][keep])
    return np.vstack(pts), np.vstack(nrm), np.concatenate(col)


def frame(points, normals, colors, angle):
    """One frame at the given Y rotation: visible cells (row * COLS + col), their RAMP
    index, both sorted by colour, and the cell count per colour."""
    ca, sa = math.cos(angle), math.sin(angle)
    tilt = 0.14 + 0.10 * math.sin(angle)
    ct, st = math.cos(tilt), math.sin(tilt)

    def rotate(v):
        x = v[:, 0] * ca + v[:, 2] * sa
        z = -v[:, 0] * sa + v[:, 2] * ca
        return x, v[:, 1] * ct - z * st, v[:, 1] * st + z * ct

    rx, ry, rz = rotate(points)
    nx, ny, nz = rotate(normals)
    front = nz > -0.15
    rx, ry, rz, nx, ny, nz = rx[front], ry[front], rz[front], nx[front], ny[front], nz[front]
    colors = colors[front]

    persp = 4 / (4 - rz)
    col = (COLS / 2 + rx * persp * COLS * 0.42).astype(int)
    row = (ROWS / 2 - ry * persp * ROWS * 0.42).astype(int)
    inside = (col >= 0) & (col < COLS) & (row >= 0) & (row < ROWS)
    cell = (row * COLS + col)[inside]
    lum = (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2] + AMBIENT)[inside]
    depth = rz[inside]
    colors = colors[inside]

    # Z-buffer: per cell keep the nearest point (largest z)
    order = np.lexsort((depth, cell))
    cell, lum, colors = cell[order], lum[order], colors[order]
    last = np.r_[cell[1:] != cell[:-1], True]
    cell, lum, colors = cell[last], lum[last], colors[last]
    ch = np.clip((lum * (len(RAMP) - 1)).astype(int), 0, len(RAMP) - 1)
    by = np.argsort(colors, kind="stable")
    return (cell[by].astype(np.int16), ch[by].astype(np.uint8),
            np.bincount(colors, minlength=len(COLORS)).tolist())


def frames():
    points, normals, colors = mesh()
    n = FPS * PERIOD
    return [frame(points, normals, colors, 2 * math.pi * k / n) for k in range(n)]


class Layout:
    """Font size and text origin so the grid fills ~80% of the output height."""

    def __init__(self, cr, width, height):
        cr.select_font_face(FONT)
        cr.set_font_size(100)
        ext = cr.font_extents()  # ascent, descent, height, max_x_adv, max_y_adv
        char_w = cr.text_extents("@").x_advance
        size = min(height * 0.8 / (ROWS * ext[2] / 100), width * 0.9 / (COLS * char_w / 100))
        self.size = size
        self.line = ext[2] * size / 100
        self.ascent = ext[0] * size / 100
        self.w = COLS * char_w * size / 100
        self.h = ROWS * self.line
        self.x = (width - self.w) / 2
        self.y = (height - self.h) / 2
        self.advance = char_w * size / 100
        # Glyph index per ramp char, so drawing skips text shaping entirely
        cr.set_font_size(size)
        sf = cr.get_scaled_font()
        self.glyph = np.array([sf.text_to_glyphs(0, 0, c, False)[0].index for c in RAMP])

    def draw(self, cr, frame):
        """One show_glyphs call per colour; glyphs built in one vectorised pass."""
        cells, ch, counts = frame
        cr.select_font_face(FONT)
        cr.set_font_size(self.size)
        xs = (self.x + cells % COLS * self.advance).tolist()
        ys = (self.y + self.ascent + cells // COLS * self.line).tolist()
        glyphs = list(map(cairo.Glyph, self.glyph[ch].tolist(), xs, ys))
        start = 0
        for rgb, n in zip(COLORS, counts):
            if n:
                cr.set_source_rgb(*rgb)
                cr.show_glyphs(glyphs[start:start + n])
            start += n


def preview(path, angle):
    w, h = 1920, 1080
    surf = cairo.ImageSurface(cairo.FORMAT_RGB24, w, h)
    cr = cairo.Context(surf)
    cr.set_source_rgb(0, 0, 0)
    cr.paint()
    Layout(cr, w, h).draw(cr, frame(*mesh(), angle))
    surf.write_to_png(path)


def run():
    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    gi.require_version("GtkLayerShell", "0.1")
    from gi.repository import Gdk, GLib, Gtk, GtkLayerShell

    lock = open(os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "nix-spin.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("nix-spin already running", file=sys.stderr)
        sys.exit(0)  # clean exit, so Restart=on-failure does not loop

    anim = frames()

    class Wallpaper(Gtk.Window):
        def __init__(self, monitor):
            super().__init__()
            self.layout = None
            self.set_app_paintable(True)
            GtkLayerShell.init_for_window(self)
            GtkLayerShell.set_namespace(self, "nix-spin")
            GtkLayerShell.set_monitor(self, monitor)
            GtkLayerShell.set_layer(self, GtkLayerShell.Layer.BOTTOM)
            for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM,
                         GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT):
                GtkLayerShell.set_anchor(self, edge, True)
            GtkLayerShell.set_exclusive_zone(self, -1)
            GtkLayerShell.set_keyboard_mode(self, GtkLayerShell.KeyboardMode.NONE)
            self.connect("draw", self.on_draw)
            self.connect("size-allocate", lambda *_: setattr(self, "layout", None))
            self.connect("realize", lambda *_: self.input_shape_combine_region(cairo.Region()))
            self.show_all()

        def on_draw(self, _, cr):
            if self.layout is None:
                self.layout = Layout(cr, self.get_allocated_width(), self.get_allocated_height())
            cr.set_source_rgb(0, 0, 0)
            cr.paint()
            self.layout.draw(cr, anim[current[0]])

        def invalidate(self):
            if self.layout:  # only the logo box, not the whole output
                lay = self.layout
                self.queue_draw_area(int(lay.x) - 2, int(lay.y) - 2, int(lay.w) + 4, int(lay.h) + 4)
            else:
                self.queue_draw()

    display = Gdk.Display.get_default()
    windows = {}

    def add(_display, monitor):
        windows[monitor] = Wallpaper(monitor)

    def remove(_display, monitor):
        win = windows.pop(monitor, None)
        if win:
            win.destroy()

    # Pick the frame from the clock so timing never drifts. GTK only repaints when the
    # compositor sends frame callbacks, so nothing is drawn while outputs are DPMS-off.
    current = [0]
    visible = set()  # monitors whose wallpaper is actually on screen
    timer = [0]

    def tick():
        idx = int(time.monotonic() * FPS) % len(anim)
        if idx != current[0]:
            current[0] = idx
            for monitor in visible:
                windows[monitor].invalidate()
        return True

    def refresh(*_):
        """Animate only monitors showing an empty workspace (no windows, no special
        workspace on top); with none visible the timer is removed, so idle cost is zero."""
        visible.clear()
        try:
            mons, wss = hypr("j/monitors"), hypr("j/workspaces")
        except OSError:  # not under Hyprland: always animate
            visible.update(windows)
        else:
            count = {ws["name"]: ws["windows"] for ws in wss}
            empty = {(m["x"], m["y"]) for m in mons
                     if count.get(m["activeWorkspace"]["name"], 0) == 0 and not m["specialWorkspace"].get("name")}
            visible.update(mon for mon in windows
                           if (mon.get_geometry().x, mon.get_geometry().y) in empty)
        if visible and not timer[0]:
            timer[0] = GLib.timeout_add(1000 // FPS, tick)
        elif not visible and timer[0]:
            GLib.source_remove(timer[0])
            timer[0] = 0
        return False

    for i in range(display.get_n_monitors()):
        add(display, display.get_monitor(i))
    display.connect("monitor-added", lambda *a: (add(*a), refresh()))
    display.connect("monitor-removed", lambda *a: (remove(*a), refresh()))
    watch_hypr_events(refresh)
    refresh()
    Gtk.main()


HYPR_DIR = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "hypr",
                        os.environ.get("HYPRLAND_INSTANCE_SIGNATURE", ""))
# socket2 events that can change whether a monitor's workspace is empty
HYPR_EVENTS = (b"workspace>>", b"focusedmon>>", b"openwindow>>", b"closewindow>>",
               b"movewindow>>", b"activespecial>>", b"monitoradded>>", b"monitorremoved>>")


def hypr(request):
    """One request on Hyprland's command socket (what `hyprctl -j` does, minus the fork)."""
    import json
    import socket
    with socket.socket(socket.AF_UNIX) as s:
        s.connect(os.path.join(HYPR_DIR, ".socket.sock"))
        s.sendall(request.encode())
        data = b"".join(iter(lambda: s.recv(65536), b""))
    return json.loads(data)


def watch_hypr_events(callback):
    """Call `callback` (debounced) on relevant Hyprland events from socket2."""
    import socket
    from gi.repository import GLib
    try:
        sock = socket.socket(socket.AF_UNIX)
        sock.connect(os.path.join(HYPR_DIR, ".socket2.sock"))
    except OSError:
        return
    sock.setblocking(False)
    pending = [0]

    def on_data(*_):
        try:
            data = sock.recv(65536)
        except BlockingIOError:
            return True
        if not data:  # Hyprland went away
            return False
        if any(e in data for e in HYPR_EVENTS) and not pending[0]:
            # events arrive in bursts (e.g. workspace + focusedmon); query once after them
            pending[0] = GLib.timeout_add(50, lambda: (pending.__setitem__(0, 0), callback())[1])
        return True

    GLib.io_add_watch(sock, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_data)
    watch_hypr_events.sock = sock  # keep alive


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preview", metavar="PNG")
    ap.add_argument("--angle", type=float, default=0.35)
    args = ap.parse_args()
    if args.preview:
        preview(args.preview, args.angle)
    else:
        run()
