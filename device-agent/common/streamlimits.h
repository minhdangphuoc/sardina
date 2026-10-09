#ifndef STREAMLIMITS_H
#define STREAMLIMITS_H

// Limits that keep a stalled client from holding the phone's memory (agent 1.11.0). Qt-free so
// device-agent/tools/streamlimits-test.cpp can check them.

// Unsent bytes a log or stats stream may queue for its client. Past the soft limit with nothing
// written for STREAM_STALL_MS the client has stopped reading (a sleeping laptop, a dropped link)
// and the stream ends; a burst (10000 journal lines at start) passes while it drains. The hard
// limit ends it regardless.
const long long STREAM_BACKLOG_SOFT_BYTES = 1024 * 1024;
const long long STREAM_BACKLOG_HARD_BYTES = 16 * 1024 * 1024;
const long long STREAM_STALL_MS = 10000;

inline bool clientStalled(long long unsentBytes, long long msSinceLastWrite)
{
    return unsentBytes > STREAM_BACKLOG_HARD_BYTES
        || (unsentBytes > STREAM_BACKLOG_SOFT_BYTES && msSinceLastWrite >= STREAM_STALL_MS);
}

// The keepalive lease of a log or stats stream, in seconds: opt-in with "lease":N (a missing,
// non-numeric or non-positive value means none, as before), else clamped to 10..300.
const int STREAM_LEASE_MIN_S = 10;
const int STREAM_LEASE_MAX_S = 300;

inline int streamLeaseSeconds(bool isNumber, double requested)
{
    if (!isNumber || !(requested >= 1)) {
        return 0;
    }
    if (requested < STREAM_LEASE_MIN_S) {
        return STREAM_LEASE_MIN_S;
    }
    return requested > STREAM_LEASE_MAX_S ? STREAM_LEASE_MAX_S : static_cast<int>(requested);
}

#endif
