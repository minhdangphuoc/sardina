// Host test of the still-screen decision (device-agent/src/idleplan.h). Not shipped.

#include "idleplan.h"

#include <cstdio>
#include <cstring>

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
    check(restartBlocksSetting(true, "maxFps") && !restartBlocksSetting(false, "maxFps"), "restart refuses maxFps");
    check(std::strcmp(restartReason("idleMode"), "restarting: idle mode changed on the phone") == 0,
          "idle mode restart reason");
    check(std::strcmp(restartReason("maxFps"), "restarting: frame rate limit changed on the phone") == 0,
          "frame rate limit restart reason");
    check(!restartReason("control") && !restartReason("screenView") && !restartReason(nullptr),
          "other settings do not restart the mirror");
    check(videoFps(30, 30) == 30 && videoFps(60, 30) == 30 && videoFps(60, 60) == 60 && videoFps(90, 60) == 60,
          "the request is capped by the phone's limit");
    check(videoFps(20, 60) == 20 && videoFps(0, 60) == 1 && videoFps(-5, 30) == 1, "lower requests are kept, at least 1");
    check(videoFps(60, 45) == 30 && videoFps(60, 0) == 30, "an invalid limit is 30");
    check(true, "off never reports same and follows the pace");
    return failures == 0 ? 0 : 1;
}
