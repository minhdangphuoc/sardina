// Host test of the stalled-client limits of log and stats streams (device-agent/common/streamlimits.h). Not shipped.

#include "streamlimits.h"

#include <cstdio>

namespace {
int failures = 0;
void check(bool ok, const char *what)
{
    std::printf("%s streamlimits: %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}
}

int main()
{
    check(!clientStalled(0, 60000), "nothing queued is never stalled");
    check(!clientStalled(STREAM_BACKLOG_SOFT_BYTES + 1, STREAM_STALL_MS - 1), "a burst that still drains passes");
    check(!clientStalled(STREAM_BACKLOG_SOFT_BYTES, 60000), "up to the soft limit any wait passes");
    check(clientStalled(STREAM_BACKLOG_SOFT_BYTES + 1, STREAM_STALL_MS), "over the soft limit without progress ends");
    check(clientStalled(STREAM_BACKLOG_HARD_BYTES + 1, 0), "over the hard limit ends at once");

    check(streamLeaseSeconds(false, 30) == 0, "lease: not a number means none");
    check(streamLeaseSeconds(true, 0) == 0 && streamLeaseSeconds(true, -5) == 0, "lease: zero or less means none");
    check(streamLeaseSeconds(true, 1) == STREAM_LEASE_MIN_S, "lease: raised to the minimum");
    check(streamLeaseSeconds(true, 30) == 30, "lease: in range kept");
    check(streamLeaseSeconds(true, 1e12) == STREAM_LEASE_MAX_S, "lease: cut to the maximum");
    return failures == 0 ? 0 : 1;
}
