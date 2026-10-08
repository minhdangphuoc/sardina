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

// While the mirror restarts after an idle mode or frame rate limit change, the settings that would
// end or change it again are refused (SetBool and SetString on the settings service).
inline bool restartBlocksSetting(bool restarting, const char *key)
{
    return restarting && key
        && (std::strcmp(key, "idleMode") == 0 || std::strcmp(key, "screenView") == 0 || std::strcmp(key, "maxFps") == 0);
}

// Settings whose change restarts a running mirror (it reads them when it starts), and the reason the
// stream ends with; nullptr for the others. The extension matches the "restarting: " prefix.
inline const char *restartReason(const char *key)
{
    if (!key) {
        return nullptr;
    }
    if (std::strcmp(key, "idleMode") == 0) {
        return "restarting: idle mode changed on the phone";
    }
    if (std::strcmp(key, "maxFps") == 0) {
        return "restarting: frame rate limit changed on the phone";
    }
    return nullptr;
}

// The VP8 stream's frame rate: the request's (default 30), at most the phone's limit (30 or 60).
inline int videoFps(int requested, int phoneLimit)
{
    const int limit = (phoneLimit == 60) ? 60 : 30;
    return requested < 1 ? 1 : requested > limit ? limit : requested;
}

#endif
