// Host test of the relative pointer tracking (device-agent/common/pointertrack.h). Not shipped.

#include "pointertrack.h"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char *what)
{
    std::printf("%s pointertrack: %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}
}

int main()
{
    PointerTrack t;
    PointerMove m = t.moveTo(100, 200, 540, 960);
    check(m.home && m.homeX < -540 && m.homeY < -540, "first move homes beyond the screen size");
    check(m.dx == 100 && m.dy == 200, "after homing the delta is the target itself");
    m = t.moveTo(90, 250, 540, 960);
    check(!m.home && m.dx == -10 && m.dy == 50, "later moves are deltas");
    m = t.moveTo(90, 250, 540, 960);
    check(!m.home && m.dx == 0 && m.dy == 0, "same point is a zero delta");
    m = t.moveTo(9999, -5, 540, 960);
    check(m.dx == 539 - 90 && m.dy == -250, "targets are clamped to the screen");
    t.forget();
    m = t.moveTo(1, 1, 540, 960);
    check(m.home && m.dx == 1 && m.dy == 1, "forget() homes again");
    return failures ? 1 : 0;
}
