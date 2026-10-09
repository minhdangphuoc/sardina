// Host test of the stats stream's arithmetic and validation (device-agent/stats/statsmath.h). Not shipped.
//
//   g++ -std=c++11 -Wall -Wextra -I device-agent/stats device-agent/tools/stats-test.cpp -o /tmp/stats-test && /tmp/stats-test

#include "statsmath.h"

#include <cmath>
#include <cstdio>
#include <string>

namespace {

int failures = 0;

void check(bool ok, const char *what)
{
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}

bool near(double a, double b) { return std::fabs(a - b) < 0.01; }

}

int main()
{
    using namespace statsmath;

    // Interval clamp.
    check(clampInterval(0) == 250 && clampInterval(-5) == 250 && clampInterval(249) == 250, "interval below 250 -> 250");
    check(clampInterval(250) == 250 && clampInterval(1000) == 1000 && clampInterval(10000) == 10000, "interval in range kept");
    check(clampInterval(10001) == 10000 && clampInterval(1LL << 40) == 10000, "interval above 10000 -> 10000");

    // /proc rescans while the app is not running.
    check(rescanDue(1000, -1), "rescan: the first scan is due at once");
    check(!rescanDue(1000 + RESCAN_MS - 1, 1000), "rescan: not again within 5 s");
    check(rescanDue(1000 + RESCAN_MS, 1000), "rescan: due after 5 s");
    check(rescanDue(500, 1000), "rescan: due when the clock went back");

    // exe validation.
    check(validExe("/usr/bin/harbour-demo"), "exe: plain path");
    check(validExe("/usr/bin/a+b_c-d.e"), "exe: allowed punctuation");
    check(validExe("/a"), "exe: shortest");
    check(!validExe(""), "exe: empty");
    check(!validExe("/"), "exe: bare slash");
    check(!validExe("usr/bin/x"), "exe: relative");
    check(!validExe("/usr/../bin/x"), "exe: dot-dot");
    check(!validExe("/usr/bin/x y"), "exe: space");
    check(!validExe("/usr/bin/x;rm"), "exe: semicolon");
    check(!validExe("/usr/bin/$x"), "exe: dollar");
    check(!validExe(std::string("/usr/bin/x\n")), "exe: newline");
    check(!validExe(std::string("/usr/bin/x\0y", 12)), "exe: NUL");
    check(validExe("/" + std::string(255, 'a')), "exe: 256 characters total");
    check(!validExe("/" + std::string(256, 'a')), "exe: 257 characters total");

    // Matching.
    check(cmdlineMatches(std::string("/usr/bin/harbour-demo\0--x\0", 26), "/usr/bin/harbour-demo"), "cmdline: first arg");
    check(cmdlineMatches("/usr/bin/harbour-demo", "/usr/bin/harbour-demo"), "cmdline: no NUL");
    check(!cmdlineMatches(std::string("/usr/bin/invoker\0/usr/bin/harbour-demo\0", 40), "/usr/bin/harbour-demo"), "cmdline: second arg ignored");
    check(!cmdlineMatches("", "/usr/bin/x"), "cmdline: empty");
    check(!cmdlineMatches("/usr/bin/harbour-demo2", "/usr/bin/harbour-demo"), "cmdline: prefix is no match");
    check(commMatches("harbour-demo\n", "/usr/bin/harbour-demo"), "comm: exact");
    check(commMatches("harbour-very-lo\n", "/usr/bin/harbour-very-long-name"), "comm: cut to 15 characters");
    check(!commMatches("other\n", "/usr/bin/harbour-demo"), "comm: different");

    // CPU arithmetic: 100 ticks at 100 Hz in 1 s is one full core; 25 ticks in 1 s is 25 %.
    check(near(cpuPercent(100, 1000, 100), 100.0), "cpu: one core");
    check(near(cpuPercent(25, 1000, 100), 25.0), "cpu: quarter");
    check(near(cpuPercent(50, 500, 100), 100.0), "cpu: shorter wall");
    check(near(cpuPercent(200, 1000, 100), 200.0), "cpu: two cores");
    check(near(cpuPercent(10, 0, 100), 0.0) && near(cpuPercent(10, -3, 100), 0.0), "cpu: no elapsed time");
    check(near(cpuPercent(10, 1000, 0), 0.0), "cpu: bad clock tick");
    check(near(sysCpuPercent(30, 100), 30.0) && near(sysCpuPercent(0, 0), 0.0) && near(sysCpuPercent(200, 100), 100.0),
          "sys cpu: share, zero, clamp");

    // /proc/<pid>/stat with a hostile comm.
    {
        const std::string text = "4321 (my (app) x) S 1 4321 4321 0 -1 4194560 1000 0 0 0 700 300 0 0 20 0 9 0 123456 "
                                 "100000000 12000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n";
        const ProcStat s = parseProcStat(text);
        check(s.ok && s.state == 'S' && s.ticks == 1000 && s.threads == 9 && s.startTicks == 123456, "stat: comm with spaces and parentheses");
        check(!parseProcStat("garbage").ok && !parseProcStat("1 (x) S 1 2").ok, "stat: malformed refused");
    }

    // Key fields.
    {
        const std::string status = "Name:\tapp\nVmPeak:\t  90000 kB\nVmRSS:\t   48216 kB\nThreads:\t9\n";
        check(kbField(status, "VmRSS") == 48216, "status: VmRSS");
        check(kbField(status, "Missing") == -1, "status: absent key");
        const std::string mem = "MemTotal: 2000000 kB\nMemAvailable:  812000 kB\n";
        check(kbField(mem, "MemAvailable") == 812000, "meminfo: MemAvailable");
        check(kbField("XVmRSS: 5 kB\n", "VmRSS") == -1, "status: key must start a line");
    }

    // /proc/stat.
    {
        unsigned long long busy = 0, total = 0;
        const bool ok = parseCpuLine("cpu  100 10 50 800 40 0 0 0 0 0\ncpu0 1 2 3\n", busy, total);
        check(ok && total == 1000 && busy == 160, "cpu line: busy excludes idle and iowait");
        check(!parseCpuLine("cpu0 1 2 3 4\n", busy, total) && !parseCpuLine("cpu  1 2\n", busy, total), "cpu line: malformed refused");
    }

    // Start time: 1000 ticks at 100 Hz = 10 s after boot, uptime 70 s -> 60 s ago.
    check(startedMs(1000, 70.0, 1700000000000LL, 100) == 1700000000000LL - 60000, "started: now minus age");

    std::printf("%s\n", failures == 0 ? "all passed" : "FAILED");
    return failures == 0 ? 0 : 1;
}
