#ifndef STATSMATH_H
#define STATSMATH_H

// The arithmetic and validation of the stats stream (agent 1.10.0), kept free of Qt and of /proc
// access so it can be tested on the build host (device-agent/tools/stats-test.cpp).

#include <cstdlib>
#include <cstring>
#include <string>

namespace statsmath {

const int INTERVAL_MIN_MS = 250;
const int INTERVAL_MAX_MS = 10000;
const int INTERVAL_DEFAULT_MS = 1000;
// While the app is not running, /proc is scanned for it at most this often (not every tick).
const long long RESCAN_MS = 5000;

// Whether a full /proc scan is due; `lastScanMs` < 0: never scanned.
inline bool rescanDue(long long nowMs, long long lastScanMs)
{
    return lastScanMs < 0 || nowMs - lastScanMs >= RESCAN_MS || nowMs < lastScanMs;
}

// `interval` clamped to 250..10000 ms.
inline int clampInterval(long long ms)
{
    if (ms < INTERVAL_MIN_MS) {
        return INTERVAL_MIN_MS;
    }
    if (ms > INTERVAL_MAX_MS) {
        return INTERVAL_MAX_MS;
    }
    return static_cast<int>(ms);
}

// ^/[A-Za-z0-9._+/-]{1,255}$ without "..": the executable path of a stats request.
inline bool validExe(const std::string &exe)
{
    if (exe.size() < 2 || exe.size() > 256 || exe[0] != '/') {
        return false;
    }
    for (size_t i = 1; i < exe.size(); ++i) {
        const char c = exe[i];
        const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.'
            || c == '_' || c == '+' || c == '/' || c == '-';
        if (!ok) {
            return false;
        }
    }
    return exe.find("..") == std::string::npos;
}

inline std::string baseName(const std::string &path)
{
    const size_t slash = path.rfind('/');
    return slash == std::string::npos ? path : path.substr(slash + 1);
}

// The first argument of /proc/<pid>/cmdline (NUL separated) equals `exe`.
inline bool cmdlineMatches(const std::string &cmdline, const std::string &exe)
{
    if (cmdline.empty() || exe.empty()) {
        return false;
    }
    const size_t nul = cmdline.find('\0');
    return cmdline.substr(0, nul) == exe;
}

// The fallback: /proc/<pid>/comm (without its newline) equals the base name cut to 15 characters.
inline bool commMatches(const std::string &comm, const std::string &exe)
{
    std::string c = comm;
    while (!c.empty() && (c[c.size() - 1] == '\n' || c[c.size() - 1] == '\r')) {
        c.erase(c.size() - 1);
    }
    const std::string base = baseName(exe).substr(0, 15);
    return !base.empty() && c == base;
}

// Percent of one core: delta ticks (utime + stime) over delta wall time. 0 when no time passed.
inline double cpuPercent(unsigned long long deltaTicks, double deltaWallMs, long clkTck)
{
    if (deltaWallMs <= 0 || clkTck <= 0) {
        return 0;
    }
    return static_cast<double>(deltaTicks) / clkTck / (deltaWallMs / 1000.0) * 100.0;
}

// System CPU percent from two /proc/stat samples: busy share of the elapsed jiffies.
inline double sysCpuPercent(unsigned long long busyDelta, unsigned long long totalDelta)
{
    if (totalDelta == 0) {
        return 0;
    }
    const double v = static_cast<double>(busyDelta) / static_cast<double>(totalDelta) * 100.0;
    return v < 0 ? 0 : (v > 100 ? 100 : v);
}

struct ProcStat {
    bool ok;
    char state;
    unsigned long long ticks; // utime + stime
    long threads;
    unsigned long long startTicks;
    ProcStat() : ok(false), state('?'), ticks(0), threads(0), startTicks(0) {}
};

// /proc/<pid>/stat: "pid (comm) S ppid ..." where comm may hold spaces and parentheses, so the
// fields are counted from the last ')'. Fields after it: 3 state, 14 utime, 15 stime, 20 threads,
// 22 starttime.
inline ProcStat parseProcStat(const std::string &text)
{
    ProcStat r;
    const size_t close = text.rfind(')');
    if (close == std::string::npos) {
        return r;
    }
    const char *p = text.c_str() + close + 1;
    unsigned long long f[64] = { 0 };
    char state = '?';
    int field = 3;
    while (*p) {
        while (*p == ' ' || *p == '\n') {
            ++p;
        }
        if (!*p) {
            break;
        }
        char *end = nullptr;
        if (field == 3) {
            state = *p;
            end = const_cast<char *>(p + 1);
        } else {
            f[field] = std::strtoull(p, &end, 10);
            if (end == p) {
                return r;
            }
        }
        p = end;
        ++field;
        if (field >= 64) {
            break;
        }
    }
    if (field <= 22) {
        return r;
    }
    r.ok = true;
    r.state = state;
    r.ticks = f[14] + f[15];
    r.threads = static_cast<long>(f[20]);
    r.startTicks = f[22];
    return r;
}

// "Key:   123 kB" from /proc/<pid>/status or /proc/meminfo. -1 when absent.
inline long long kbField(const std::string &text, const char *key)
{
    const std::string k = std::string(key) + ":";
    size_t pos = 0;
    while ((pos = text.find(k, pos)) != std::string::npos) {
        if (pos == 0 || text[pos - 1] == '\n') {
            return std::strtoll(text.c_str() + pos + k.size(), nullptr, 10);
        }
        pos += k.size();
    }
    return -1;
}

// First line of /proc/stat ("cpu  user nice system idle iowait irq softirq steal ...") as busy and
// total jiffies; idle and iowait are not busy.
inline bool parseCpuLine(const std::string &text, unsigned long long &busy, unsigned long long &total)
{
    if (text.compare(0, 4, "cpu ") != 0) {
        return false;
    }
    const char *p = text.c_str() + 4;
    unsigned long long v[8] = { 0 };
    int n = 0;
    while (n < 8) {
        char *end = nullptr;
        const unsigned long long x = std::strtoull(p, &end, 10);
        if (end == p) {
            break;
        }
        v[n++] = x;
        p = end;
        if (*p == '\n') {
            break;
        }
    }
    if (n < 4) {
        return false;
    }
    total = 0;
    for (int i = 0; i < n; ++i) {
        total += v[i];
    }
    busy = total - v[3] - (n > 4 ? v[4] : 0);
    return true;
}

// Start time in ms since the epoch: now minus the process age (uptime minus start ticks).
inline long long startedMs(unsigned long long startTicks, double uptimeSec, long long nowMs, long clkTck)
{
    if (clkTck <= 0) {
        return 0;
    }
    const double ageSec = uptimeSec - static_cast<double>(startTicks) / clkTck;
    return nowMs - static_cast<long long>(ageSec * 1000.0);
}

}

#endif
