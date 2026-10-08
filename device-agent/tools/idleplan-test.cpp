// Host test of the still-screen decision (device-agent/src/idleplan.h). Not shipped.

#include "idleplan.h"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char *what)
{
    std::printf("%s idleplan: %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}
}

int main()
{
    check(idleAction(true, 0, 2) == IdleAction::Reencode, "idle mode on sharpens first");
    check(idleAction(true, 1, 2) == IdleAction::Reencode, "idle mode on sharpens twice");
    check(idleAction(true, 2, 2) == IdleAction::Same, "idle mode on then reports same");
    check(idleDelayMs(true, 1, 2, 300, 1000, 33) == 300, "on: next sharpen after 300 ms");
    check(idleDelayMs(true, 2, 2, 300, 1000, 33) == 1000, "on: heartbeat each second");
    for (int refreshes = 0; refreshes < 50; ++refreshes) {
        if (idleAction(false, refreshes, 2) != IdleAction::Reencode || idleDelayMs(false, refreshes, 2, 300, 1000, 66) != 66) {
            check(false, "off never reports same and follows the pace");
            return 1;
        }
    }
    check(restartBlocksSetting(true, "idleMode") && restartBlocksSetting(true, "screenView"), "restart refuses idleMode and screenView");
    check(!restartBlocksSetting(true, "control") && !restartBlocksSetting(true, "logs"), "restart leaves other switches alone");
    check(!restartBlocksSetting(false, "idleMode"), "no restart, no refusal");
    check(true, "off never reports same and follows the pace");
    return failures == 0 ? 0 : 1;
}
