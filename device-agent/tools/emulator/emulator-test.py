#!/usr/bin/env python3
"""Emulator test of the phone-side touch indicator and of removing the agent. Opt-in, not in CI.

    make -C device-agent/tools emulator-test [VM="SailfishOS-5.1.0.11"] [HEADLESS=1]

Takes a snapshot of the Sailfish SDK emulator, starts it, installs the RPMs from media/agent/i486,
drives the input module the way the mirror does while it changes the clipboard, rotates, locks,
opens the keyboard and swipes, then removes one module and the whole agent and checks that nothing
is left. The snapshot is always restored and deleted and the emulator powered off at the end, also
after a failure or Ctrl+C. Needs VirtualBox, the SDK's SSH key in ~/SailfishOS/vmshare and the helper
binaries built by the make target. Python 3 standard library only.
"""

import argparse
import json
import math
import os
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
REMOTE = '/tmp/agent-emulator-test'  # not named after the package: the leftover check looks for that
FILES = ['device.sh', 'testapp.qml', 'uninstall-check.sh']
PHONE_W, PHONE_H = 720, 1600
MARKER_RADIUS = 20  # TouchOverlay: max(12, min(width, height) / 36) on a 720-wide screen


class Failed(Exception):
    pass


def run(argv, check=True, quiet=False, timeout=600):
    try:
        r = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Failed('%s did not finish within %d s: %s' % (argv[0], timeout, ' '.join(argv[-2:])))
    if check and r.returncode != 0:
        raise Failed('%s failed (%d): %s' % (argv[0], r.returncode, r.stdout.strip()[-400:]))
    if not quiet and r.returncode != 0:
        print('  note: %s exited %d' % (' '.join(argv[:3]), r.returncode))
    return r.stdout


class Vm:
    def __init__(self, name, headless, work):
        self.name = name
        self.headless = headless
        self.snapshot = 'emulator-test-%d' % os.getpid()
        self.taken = False
        self.started = False
        self.shot_file = os.path.join(work, 'screen.png')

    def info(self):
        for _ in range(10):  # the VM is briefly locked while its state changes
            r = subprocess.run(['VBoxManage', 'showvminfo', self.name, '--machinereadable'],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            if r.returncode == 0:
                return dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
            time.sleep(1)
        raise Failed('VBoxManage cannot read the VM %s: %s' % (self.name, r.stdout.strip()[-300:]))

    def state(self):
        return self.info().get('VMState', '').strip('"')

    def ssh_port(self):
        for key, value in self.info().items():
            parts = value.strip('"').split(',')
            if key.startswith('Forwarding') and len(parts) == 6 and parts[5] == '22':
                return int(parts[3])
        raise Failed('the emulator has no SSH port forwarding')

    def take_snapshot(self):
        run(['VBoxManage', 'snapshot', self.name, 'take', self.snapshot, '--description',
             'emulator-test.py; restored and deleted when the test ends'])
        self.taken = True

    def start(self):
        if self.state() != 'running':
            run(['VBoxManage', 'startvm', self.name, '--type', 'headless' if self.headless else 'gui'])
            self.started = True

    def screenshot(self):
        run(['VBoxManage', 'controlvm', self.name, 'screenshotpng', self.shot_file])
        return Image(self.shot_file)

    def restore(self):
        if self.state() in ('running', 'paused', 'stuck'):
            run(['VBoxManage', 'controlvm', self.name, 'poweroff'], check=False, quiet=True)
            for _ in range(60):
                if self.state() not in ('running', 'paused', 'stopping'):
                    break
                time.sleep(1)
        if self.taken:
            run(['VBoxManage', 'snapshot', self.name, 'restore', self.snapshot])
            run(['VBoxManage', 'snapshot', self.name, 'delete', self.snapshot])
            self.taken = False
        if self.state() == 'saved':
            run(['VBoxManage', 'discardstate', self.name], check=False, quiet=True)


class Phone:
    def __init__(self, port, key, work):
        self.base = ['-p', str(port), '-i', key, '-o', 'BatchMode=yes', '-o', 'LogLevel=error',
                     '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
                     '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=auto',
                     '-o', 'ControlPath=' + os.path.join(work, 'ssh-%r@%h:%p'), '-o', 'ControlPersist=120']
        self.host = 'root@127.0.0.1'

    def sh(self, command, check=True, timeout=180):
        return run(['ssh'] + self.base + [self.host, command], check=check, quiet=not check, timeout=timeout)

    def dev(self, *args, check=True, timeout=180):
        return self.sh('sh %s/device.sh %s' % (REMOTE, ' '.join(str(a) for a in args)), check, timeout)

    def put(self, paths, target):
        port = self.base[1]
        run(['scp', '-q', '-P', port] + self.base[2:] + paths + ['%s:%s/' % (self.host, target)])

    def wait(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            r = subprocess.run(['ssh'] + self.base + [self.host, 'true'], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                return
            time.sleep(3)
        raise Failed('no SSH answer from the emulator within %d s' % seconds)


def whitish(rgb):
    """The marker's outline: light and grey (its fill is red, the scaled-down line is not pure white)."""
    return min(rgb) >= 120 and max(rgb) - min(rgb) <= 70


class Image:
    """An 8-bit RGB or RGBA PNG as written by VirtualBox (no interlace)."""

    def __init__(self, path):
        data = open(path, 'rb').read()
        pos, idat = 8, b''
        while pos < len(data):
            length, kind = struct.unpack('>I4s', data[pos:pos + 8])
            body = data[pos + 8:pos + 8 + length]
            if kind == b'IHDR':
                self.w, self.h, depth, color = struct.unpack('>IIBB', body[:10])
                if depth != 8 or color not in (2, 6) or body[12] != 0:
                    raise Failed('unexpected screenshot format')
                self.bpp = 4 if color == 6 else 3
            elif kind == b'IDAT':
                idat += body
            pos += 12 + length
        raw, stride = zlib.decompress(idat), self.w * self.bpp
        rows, prev = [], bytearray(stride)
        for y in range(self.h):
            f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
            for i in range(stride):
                a = line[i - self.bpp] if i >= self.bpp else 0
                b = prev[i]
                c = prev[i - self.bpp] if i >= self.bpp else 0
                if f == 1:
                    line[i] = (line[i] + a) & 255
                elif f == 2:
                    line[i] = (line[i] + b) & 255
                elif f == 3:
                    line[i] = (line[i] + (a + b) // 2) & 255
                elif f == 4:
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            rows.append(bytes(line))
            prev = line
        self.rows = rows

    # Phone pixel to frame pixel; set by Test.calibrate from where the marker shows up.
    mapping = (0.5, 0.0, 0.5, 0.0)

    def at(self, px, py):
        sx, ox, sy, oy = Image.mapping
        return px * sx + ox, py * sy + oy

    def new_white(self, other):
        """Centre of the pixels that are white here but not in the other shot (the marker's outline)."""
        xs, ys = [], []
        for y in range(self.h):
            for x in range(0, self.w):
                if whitish(self.pixel(x, y)) and not whitish(other.pixel(x, y)):
                    xs.append(x)
                    ys.append(y)
        if len(xs) < 8:
            raise Failed('the marker was not found on the screen')
        return sum(xs) / len(xs), sum(ys) / len(ys)

    def pixel(self, x, y):
        x, y = min(max(int(x), 0), self.w - 1), min(max(int(y), 0), self.h - 1)
        i = x * self.bpp
        return self.rows[y][i:i + 3]

    def ring_white(self, px, py):
        """Share of points on the marker's outline around phone point (px, py) that are light grey and
        clearly lighter (in the weakest colour) than the red fill inside, whatever is behind."""
        cx, cy = self.at(px, py)
        r = MARKER_RADIUS * Image.mapping[0]
        hits = 0
        for k in range(48):
            c, s = math.cos(2 * math.pi * k / 48), math.sin(2 * math.pi * k / 48)
            inside = min(self.pixel(cx + r * 0.5 * c, cy + r * 0.5 * s))
            for dr in (-1, 0, 1):
                ring = self.pixel(cx + (r + dr) * c, cy + (r + dr) * s)
                if whitish(ring) and min(ring) >= inside + 30:
                    hits += 1
                    break
        return hits / 48

    def find_marker(self, near, reach=100):
        """The phone point within reach of near where the marker's outline shows best."""
        best = (-1, near)
        for dy in range(-reach, reach + 1, 4):
            for dx in range(-reach, reach + 1, 4):
                point = (near[0] + dx, near[1] + dy)
                best = max(best, (self.ring_white(*point), point))
        return best[1]

    def difference(self, other):
        """Mean absolute difference over the phone area, 0..255, sampled every 4th pixel."""
        width, total, n = min(int(self.at(PHONE_W, 0)[0]), self.w), 0, 0
        for y in range(0, self.h, 4):
            for x in range(0, width, 4):
                a, b = self.pixel(x, y), other.pixel(x, y)
                total += abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
                n += 3
        return total / n


class Test:
    def __init__(self, vm, phone, args):
        self.vm, self.phone, self.args = vm, phone, args
        self.results = []

    def lipstick(self):
        out = self.phone.sh('u=$(id -u defaultuser); runuser -u defaultuser -- env XDG_RUNTIME_DIR=/run/user/$u '
                            'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$u/dbus/user_bus_socket '
                            'systemctl --user show lipstick -p MainPID -p NRestarts', check=False)
        fields = dict(part.split('=', 1) for part in out.split() if '=' in part)
        return fields.get('MainPID'), fields.get('NRestarts')

    def case(self, name, title, body):
        print('-- %s: %s' % (name, title), flush=True)
        before = self.lipstick()
        problems = []
        try:
            body(problems)
        except Failed as e:
            problems.append(str(e))
        finally:
            self.phone.dev('stop', check=False)
            self.phone.dev('clip-stop', check=False)
        after = self.lipstick()
        if after != before:
            problems.append('Lipstick restarted (main PID %s -> %s, restarts %s -> %s)'
                            % (before[0], after[0], before[1], after[1]))
        if problems:
            problems.append('test app log ends: ' + ', '.join(self.app_log()[-8:]))
        verdict = 'FAIL' if problems else 'PASS'
        self.results.append((name, verdict))
        print('%s %s: %s%s' % (verdict, name, title, ''.join('\n     ' + p for p in problems)), flush=True)

    # Helpers used by the cases.

    def calibrate(self):
        """Finds where the phone sits in the emulator's frame from two marker positions."""
        found = []
        self.session()
        for point in ((200, 700), (520, 1000)):
            self.phone.dev('drag', point[0], point[1], point[0], point[1])
            held = self.vm.screenshot()
            self.phone.dev('up')
            time.sleep(1.5)
            found.append(held.new_white(self.vm.screenshot()))
        self.phone.dev('stop')
        (x1, y1), (x2, y2) = found
        sx, sy = (x2 - x1) / 320, (y2 - y1) / 300
        Image.mapping = (sx, x1 - 200 * sx, sy, y1 - 700 * sy)
        print('phone in the frame: scale %.3f x %.3f, offset %.0f, %.0f' % (sx, sy, Image.mapping[1], Image.mapping[3]))
        if not (0.2 < sx < 2 and 0.2 < sy < 2):
            raise Failed('the marker positions make no sense: %s' % found)

    def session(self):
        self.phone.dev('start')
        if self.phone.dev('overlay').strip() != '"overlay":true':
            raise Failed('the indicator was not shown on the phone')

    def app_log(self):
        return self.phone.dev('app-log').splitlines()

    def wait_log(self, line, seconds=5, count=1):
        """True once the app has logged the line at least count times."""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.app_log().count(line) >= count:
                return True
            time.sleep(0.3)
        return False

    def gesture(self, problems, label, p1, p2, check=None):
        """Drags from p1 to p2 with the indicator shown, checks the marker under the finger and its
        fade, then runs check(before, after) for the gesture's own effect."""
        before = self.vm.screenshot()
        self.phone.dev('drag', p1[0], p1[1], p2[0], p2[1])
        time.sleep(1)  # the marker draws at the compositor's pace, slow on the emulator during animations
        held = self.vm.screenshot()
        kept = os.path.join(tempfile.gettempdir(), 'emulator-test-%s.png' % ''.join(c if c.isalnum() else '-' for c in label[:30]))
        shutil.copy(self.vm.shot_file, kept)
        p2 = held.find_marker(p2)  # near the end point, not exactly on it
        self.phone.dev('up')
        time.sleep(1.5)
        after = self.vm.screenshot()
        on, off = held.ring_white(*p2), after.ring_white(*p2)
        if on < 0.5 or off > on - 0.3:
            problems.append('%s: marker not seen under the finger or did not fade (outline %.2f held, %.2f after; '
                            'screen while held: %s)' % (label, on, off, kept))
        else:
            os.remove(kept)
        if check and not check(before, after):
            problems.append('%s: the gesture had no effect' % label)
        print('   %s: marker %.2f held, %.2f after' % (label, on, off), flush=True)
        return before, after

    @staticmethod
    def changed(before, after):
        return before.difference(after) > 6

    # The cases.

    def a_sessions(self, problems):
        self.phone.dev('clip-start', 5)
        killed = 0
        for _ in range(self.args.sessions):
            self.session()
            self.phone.dev('tap', 360, 800)
            killed += self.phone.dev('stop').strip() == 'killed'
        self.phone.dev('clip-stop')
        self.phone.dev('clip', 20, 10)
        if killed:
            problems.append('%d of %d sessions did not end within 500 ms' % (killed, self.args.sessions))

    def b_killed(self, problems):
        for _ in range(self.args.kills):
            self.session()
            self.phone.dev('tap', 360, 800)
            self.phone.dev('kill9')
            self.phone.dev('clip', 3, 0)
            time.sleep(0.1)
            self.phone.dev('clip', 3, 0)
            time.sleep(1)
            self.phone.dev('clip', 3, 10)

    def g_toggles(self, problems):
        self.session()
        self.phone.dev('tap', 100, 100)
        rss0, fds0 = map(int, self.phone.dev('usage').split())
        self.phone.sh('for i in $(seq 200); do sh %s/device.sh send \'{"overlay":true}\'; '
                      'sh %s/device.sh send \'{"overlay":false}\'; done' % (REMOTE, REMOTE))
        self.session_overlay_again()
        self.phone.dev('tap', 100, 100)
        self.phone.dev('clip', 10, 10)
        rss1, fds1 = map(int, self.phone.dev('usage').split())
        print('   module memory %d -> %d kB, open files %d -> %d' % (rss0, rss1, fds0, fds1))
        if fds1 != fds0 or rss1 - rss0 > 1024:
            problems.append('the module grew: memory %d -> %d kB, open files %d -> %d' % (rss0, rss1, fds0, fds1))

    def session_overlay_again(self):
        if self.phone.dev('overlay').strip() != '"overlay":true':
            raise Failed('the indicator was not shown after the toggles')

    def f_taps(self, problems):
        self.session()
        before = len([l for l in self.app_log() if l.startswith('tap ')])
        for _ in range(3):
            self.phone.dev('tap', 360, 800)
        if not self.wait_log('tap %d' % (before + 3)):
            problems.append('taps did not reach the app under the indicator')
        self.gesture(problems, 'press and hold', (360, 820), (360, 800))

    def e_keyboard(self, problems):
        self.session()
        self.phone.dev('clip-start', 50)
        opened, closed = self.app_log().count('keyboard true'), self.app_log().count('keyboard false')
        self.phone.dev('tap', 360, 150)  # the text field
        if not self.wait_log('keyboard true', 10, opened + 1):
            problems.append('a tap on the text field did not open the keyboard')
        time.sleep(1)
        self.phone.dev('tap', 360, 1420)
        if not self.wait_log('text 1'):
            problems.append('a key tap did not reach the keyboard')
        self.phone.dev('app-cmd', 'notype')
        if not self.wait_log('keyboard false', 10, closed + 1):
            problems.append('the keyboard did not close')

    def c_rotation(self, problems):
        self.session()
        self.phone.dev('clip-start', 50)
        for word, page in (('land', 'page 2'), ('port', 'page 1'), ('land', 'page 2'), ('port', 'page 1')):
            turned = self.app_log().count(page)
            self.phone.dev('app-cmd', word)
            if not self.wait_log(page, 10, turned + 1):
                problems.append('the app did not turn to %s' % word)
            time.sleep(1.5)  # the turn is animated
            taps = len([l for l in self.app_log() if l.startswith('tap ')])
            self.phone.dev('tap', 360, 800)
            if not self.wait_log('tap %d' % (taps + 1)):
                problems.append('a tap after turning to %s did not reach the app' % word)

    def d_lock_display(self, problems):
        self.session()
        self.phone.dev('tap', 360, 800)
        self.phone.dev('mce', 'req_tklock_mode_change', 'string:locked')
        self.phone.dev('mce', 'req_display_state_off')
        time.sleep(2)
        self.phone.dev('clip', 20, 20)
        self.phone.dev('stop')  # the session ends while the display is off
        self.phone.dev('clip', 20, 10)
        self.session()
        self.phone.dev('clip', 20, 10)
        self.phone.dev('mce', 'req_display_state_on')
        time.sleep(2)
        self.phone.dev('clip', 10, 10)
        self.gesture(problems, 'lock screen', (360, 820), (360, 800))
        self.phone.dev('mce', 'req_tklock_mode_change', 'string:unlocked')
        time.sleep(2)

    def h_swipes(self, problems):
        self.session()
        log = lambda line: (lambda b, a, n=self.app_log().count(line): self.wait_log(line, 5, n + 1))
        self.gesture(problems, 'top to bottom in the app (pulley menu)', (360, 500), (360, 1000), log('pulley true'))
        self.gesture(problems, 'left to right in the app (to home)', (1, 800), (650, 800), log('active false'))
        self.gesture(problems, 'left to right on home (events view)', (1, 800), (650, 800), self.changed)
        self.gesture(problems, 'top to bottom on home (top menu)', (360, 1), (360, 1200), self.changed)

    def u_uninstall(self, problems):
        scripts = uninstall_scripts(self.args.node)
        self.phone.dev('app-stop', check=False)
        self.phone.sh(scripts['moduleRemove'], check=False)
        user = self.phone.dev('asuser', 'sh', '-c', quote(scripts['moduleCleanup']), 'sh', '/run/user', check=False)
        check = self.phone.sh('sh %s/uninstall-check.sh; echo "exit $?"' % REMOTE, check=False)
        left = [l for l in check.splitlines() if l.startswith('left:') and ('input' in l or 'touch-overlay' in l)]
        print('   after removing the input module, left of it: %s' % ('; '.join(left) or 'nothing'))
        if left or 'sfdev-clean:left' in user:
            problems.append('after removing the input module: ' + '; '.join(left or [user.strip()]))
        if 'sailfish-devagent-input' in self.phone.sh('rpm -qa', check=False):
            problems.append('the input package is still installed')
        self.phone.sh(scripts['uninstall'], check=False)
        user = self.phone.dev('asuser', 'sh', '-c', quote(scripts['cleanup']), 'sh',
                              *[quote(a) for a in scripts['cleanupArgs']], check=False)
        check = self.phone.sh('sh %s/uninstall-check.sh; echo "exit $?"' % REMOTE, check=False)
        print('   after removing everything: ' + ' | '.join(check.strip().splitlines()))
        if not check.strip().endswith('exit 0'):
            problems.append('something of the agent is left: ' + '; '.join(check.strip().splitlines()))
        if 'sfdev-clean:left' in user:
            problems.append('the cleanup reported: ' + user.strip())


def quote(text):
    return "'" + text.replace("'", "'\\''") + "'"


def uninstall_scripts(node):
    """The extension's own removal scripts, read from src/agent/uninstallCore.ts."""
    esbuild = os.path.join(ROOT, 'node_modules', '.bin', 'esbuild')
    if not os.path.exists(esbuild):
        raise Failed('node_modules missing: run npm ci first')
    out = tempfile.mkdtemp(prefix='emulator-test-')
    try:
        bundle = os.path.join(out, 'u.cjs')
        run([esbuild, os.path.join(ROOT, 'src', 'agent', 'uninstallCore.ts'), '--bundle', '--platform=node',
             '--format=cjs', '--log-level=error', '--outfile=' + bundle])
        code = ("const m=require(%s);console.log(JSON.stringify({uninstall:m.UNINSTALL_SCRIPT,cleanup:m.CLEANUP_SCRIPT,"
                "cleanupArgs:m.CLEANUP_ARGS,moduleRemove:m.uninstallModulesScript(['input']),"
                "moduleCleanup:m.moduleCleanupScript(['input'])}))" % json.dumps(bundle))
        return json.loads(run([node, '-e', code]))
    finally:
        shutil.rmtree(out, ignore_errors=True)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument('--vm', default=os.environ.get('VM', 'SailfishOS-5.1.0.11'))
    p.add_argument('--helpers', required=True, help='folder with clip and uitouch built for i486')
    p.add_argument('--headless', action='store_true', default=os.environ.get('HEADLESS') == '1')
    p.add_argument('--key', default=os.path.expanduser('~/SailfishOS/vmshare/ssh/private_keys/sdk'))
    p.add_argument('--rpms', default=os.path.join(ROOT, 'media', 'agent', 'i486'))
    p.add_argument('--node', default=shutil.which('node') or 'node')
    p.add_argument('--sessions', type=int, default=60)
    p.add_argument('--kills', type=int, default=10)
    p.add_argument('--cases', default='abgfechdu', help='letters of the cases to run, in this order')
    args = p.parse_args()

    rpms = sorted(os.path.join(args.rpms, f) for f in os.listdir(args.rpms) if f.endswith('.rpm'))
    if not rpms:
        raise SystemExit('no RPMs in %s' % args.rpms)
    if not os.path.exists(args.key):
        raise SystemExit('no SSH key at %s' % args.key)
    work = tempfile.mkdtemp(prefix='emulator-test-')
    vm = Vm(args.vm, args.headless, work)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    test = None
    try:
        if vm.state() not in ('poweroff', 'aborted', 'saved', 'running'):
            raise Failed('the emulator is %s; power it off first' % vm.state())
        print('taking snapshot %s of %s' % (vm.snapshot, vm.name), flush=True)
        vm.take_snapshot()
        vm.start()
        phone = Phone(vm.ssh_port(), args.key, work)
        phone.wait(240)
        test = Test(vm, phone, args)
        for _ in range(60):
            if test.lipstick()[0] not in (None, '0'):
                break
            time.sleep(2)
        time.sleep(15)  # the home screen settles after Lipstick starts
        print('installing %d RPMs' % len(rpms), flush=True)
        phone.sh('rm -rf %s; mkdir -p %s' % (REMOTE, REMOTE))
        phone.put(rpms + [os.path.join(HERE, f) for f in FILES]
                  + [os.path.join(args.helpers, 'clip'), os.path.join(args.helpers, 'uitouch')], REMOTE)
        phone.sh('rpm -U --force %s/*.rpm' % REMOTE)
        phone.sh('rm -f %s/*.rpm' % REMOTE)
        phone.dev('setup')
        for _ in range(30):
            if '"version"' in phone.dev('status', check=False):
                break
            time.sleep(1)
        print('agent: %s' % phone.dev('status', check=False).strip()[:200])
        if 'boolean true' not in phone.dev('setting', 'touchIndicator', 'true', check=False):
            raise Failed('the agent refused to turn on its touchIndicator setting')
        # Unlock with a swipe from the left edge, like a finger.
        phone.dev('start')
        phone.dev('drag', 1, 800, 650, 800)
        phone.dev('up')
        phone.dev('stop')
        time.sleep(2)
        phone.dev('app-start')
        test.calibrate()

        cases = {
            'a': ('sessions start and end while the clipboard changes', test.a_sessions),
            'b': ('killed sessions, then clipboard changes', test.b_killed),
            'g': ('200 indicator toggles in one session', test.g_toggles),
            'f': ('taps pass through to the app', test.f_taps),
            'e': ('the keyboard opens and takes taps', test.e_keyboard),
            'c': ('rotation', test.c_rotation),
            'h': ('swipes top to bottom and left to right', test.h_swipes),
            'd': ('lock screen and display off and on', test.d_lock_display),
            'u': ('remove the input module, then the whole agent', test.u_uninstall),
        }
        for name in args.cases:
            test.case(name, *cases[name])
    except Failed as e:
        print('FAIL setup: %s' % e)
        if test:
            test.results.append(('setup', 'FAIL'))
        else:
            test = Test(vm, None, args)
            test.results.append(('setup', 'FAIL'))
    except KeyboardInterrupt:
        print('interrupted')
        if test is None:
            test = Test(vm, None, args)
        test.results.append(('interrupted', 'FAIL'))
    finally:
        print('restoring and deleting snapshot %s, powering off' % vm.snapshot, flush=True)
        try:
            vm.restore()
        finally:
            shutil.rmtree(work, ignore_errors=True)
    failed = [n for n, v in test.results if v == 'FAIL']
    print('summary: %s' % ' '.join('%s %s' % r for r in test.results))
    print('result: %s' % ('FAIL (%s)' % ', '.join(failed) if failed else 'PASS'))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
