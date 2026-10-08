#ifndef IDLEPLAN_H
#define IDLEPLAN_H

// What a still screen costs (agent 1.10.6). Qt-free so device-agent/tools/idleplan-test.cpp can
// check it. With the phone's idle mode on, the last picture is encoded again a few times to
// sharpen it and then only "same" heartbeats go out. With it off the agent never reports idle:
// it keeps encoding the last picture again, one frame per pace slot.

#include <cstring>

enum class IdleAction { Reencode, Same };

inline IdleAction idleAction(bool idleMode, int refreshes, int maxRefreshes)
{
    return (!idleMode || refreshes < maxRefreshes) ? IdleAction::Reencode : IdleAction::Same;
}

// Milliseconds until the next step, after a step that was just taken.
inline int idleDelayMs(bool idleMode, int refreshes, int maxRefreshes, int afterMs, int heartbeatMs, int paceMs)
{
    if (!idleMode) {
        return paceMs;
    }
    return refreshes < maxRefreshes ? afterMs : heartbeatMs;
}

// While the mirror restarts after an idle mode change, the two switches that would end or change
// it again are refused (SetBool on the settings service).
inline bool restartBlocksSetting(bool restarting, const char *key)
{
    return restarting && key && (std::strcmp(key, "idleMode") == 0 || std::strcmp(key, "screenView") == 0);
}

#endif
