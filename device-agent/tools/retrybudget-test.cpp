// Host test of the recorder retry budget (device-agent/mirror/retrybudget.h). Not shipped.

#include "retrybudget.h"

#include <cstdio>

namespace {

int failures = 0;

void check(bool ok, const char *what)
{
    std::printf("%s retry budget: %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}

}

int main()
{
    RetryBudget b(3, 5000);
    check(b.take(0) && b.take(1000) && b.take(2000), "three tries within the window");
    check(!b.take(4999), "the fourth within the window is refused");
    check(b.take(5000), "a try frees up once the oldest leaves the window");
    check(!b.take(5500), "and is used up again");
    RetryBudget slow(3, 5000);
    bool all = true;
    for (int i = 0; i < 20; ++i) {
        all = slow.take(i * 6000LL) && all;
    }
    check(all, "rare failures never exhaust it");
    std::printf("%s\n", failures == 0 ? "all passed" : "FAILED");
    return failures == 0 ? 0 : 1;
}
