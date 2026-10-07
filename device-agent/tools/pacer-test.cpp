// Host test of the mirror's frame pacing decision (device-agent/src/pacer.h). Not shipped.
//
//   g++ -std=c++11 -Wall -Wextra -I device-agent/src device-agent/tools/pacer-test.cpp -o /tmp/pacer-test && /tmp/pacer-test
//
// Each scenario feeds a simulated stream: a frame every max(slot, cost) ms, its convert + encode
// cost given by the scenario. The numbers come from the Jolla Phone (about 30 ms per frame at
// 720x1584, `phone 29 ms` / `36 ms`, `encode 30 ms`) and from the emulator (a 6 s load burst gave
// 224 ms frames). Agent 1.8.0's rule is simulated next to it for comparison.

#include "pacer.h"

#include <cmath>
#include <cstdio>
#include <functional>
#include <vector>

namespace {

int failures = 0;

void check(bool ok, const char *scenario, const char *what)
{
    std::printf("%s %s: %s\n", ok ? "ok  " : "FAIL", scenario, what);
    if (!ok) {
        ++failures;
    }
}

// Agent 1.8.0's rule (mirror.cpp notePaceCost), for comparison.
class Pacer180
{
public:
    int step() const { return m_step; }
    double intervalMs() const { return slot(m_step); }
    void encoderOpened(long long now) { m_openedAt = now; m_costs.clear(); }
    bool addCost(double ms, long long now)
    {
        if (m_openedAt >= 0 && now - m_openedAt < 1000) {
            return false;
        }
        m_costs.push_back(ms);
        if (m_costs.size() > 15) {
            m_costs.erase(m_costs.begin());
        }
        std::vector<double> sorted = m_costs;
        std::sort(sorted.begin(), sorted.end());
        const double cost = sorted[sorted.size() / 2];
        int fits = 0;
        while (fits + 1 < 5 && cost > 0.85 * slot(fits)) {
            ++fits;
        }
        int shorter = m_step;
        while (shorter > 0 && cost < 0.6 * slot(shorter - 1)) {
            --shorter;
        }
        const int before = m_step;
        if (fits > m_step) {
            m_fastSince = -1;
            if (m_slowSince < 0) {
                m_slowSince = now;
            } else if (now - m_slowSince >= 1000) {
                m_step = fits;
                m_slowSince = -1;
            }
        } else if (shorter < m_step) {
            m_slowSince = -1;
            if (m_fastSince < 0) {
                m_fastSince = now;
            } else if (now - m_fastSince >= 1000) {
                m_step = shorter;
                m_fastSince = -1;
            }
        } else {
            m_slowSince = -1;
            m_fastSince = -1;
        }
        return m_step != before;
    }

private:
    static double slot(int step)
    {
        static const int half[] = { 2, 3, 4, 6, 8 };
        return 1000.0 * half[step] / 60.0;
    }
    int m_step = 0;
    std::vector<double> m_costs;
    long long m_slowSince = -1;
    long long m_fastSince = -1;
    long long m_openedAt = -1;
};

struct Result {
    std::vector<int> steps;   // the step after each frame
    std::vector<long long> at; // when each frame finished
    int maxJump = 0;          // the largest change of step at once
    int changes = 0;
    int stepAt(long long t) const
    {
        int s = 0;
        for (size_t i = 0; i < at.size() && at[i] <= t; ++i) {
            s = steps[i];
        }
        return s;
    }
    // Share of the time from `from` to `to` spent at or below `step`.
    double shareAtMost(int step, long long from, long long to) const
    {
        long long inside = 0;
        for (size_t i = 1; i < at.size(); ++i) {
            const long long a = std::max(from, at[i - 1]);
            const long long b = std::min(to, at[i]);
            if (b > a && steps[i - 1] <= step) {
                inside += b - a;
            }
        }
        return static_cast<double>(inside) / static_cast<double>(to - from);
    }
    double fps(long long from, long long to) const
    {
        int n = 0;
        for (long long t : at) {
            if (t >= from && t < to) {
                ++n;
            }
        }
        return n * 1000.0 / static_cast<double>(to - from);
    }
};

// cost(t, slot) gives the convert + encode time of a frame that starts at t at that slot.
template <typename P>
Result simulate(long long durationMs, const std::function<double(long long, double)> &cost)
{
    P pacer;
    Result r;
    pacer.encoderOpened(0);
    double t = 0;
    int last = pacer.step();
    while (t < durationMs) {
        const double c = cost(static_cast<long long>(t), pacer.intervalMs());
        t += std::max(pacer.intervalMs(), c);
        pacer.addCost(c, static_cast<long long>(t));
        const int s = pacer.step();
        if (s != last) {
            r.maxJump = std::max(r.maxJump, std::abs(s - last));
            ++r.changes;
            last = s;
        }
        r.steps.push_back(s);
        r.at.push_back(static_cast<long long>(t));
    }
    return r;
}

const char *FPS[] = { "30", "20", "15", "10", "7.5" };

void report(const char *name, const Result &now, const Result &old, long long from, long long to)
{
    std::printf("     %s: 1.8.1 %.1f fps (ends at %s fps, %d changes, largest jump %d); 1.8.0 %.1f fps (ends at %s fps, largest jump %d)\n",
                name, now.fps(from, to), FPS[now.steps.back()], now.changes, now.maxJump, old.fps(from, to),
                FPS[old.steps.back()], old.maxJump);
}

}

int main()
{
    // 1. The phone at 720 wide, about 30 ms per frame with some spread: stays at 30 fps.
    {
        auto cost = [](long long t, double) { return 27.0 + (t / 33) % 7; }; // 27..33 ms
        const Result r = simulate<Pacer>(60000, cost);
        const Result o = simulate<Pacer180>(60000, cost);
        report("30 ms steady", r, o, 2000, 60000);
        check(r.shareAtMost(0, 2000, 60000) == 1.0, "30 ms steady", "30 fps slot all the time");
        check(o.stepAt(60000) >= 1, "30 ms steady", "1.8.0 stepped down to 20 fps (the regression)");
    }
    // 2. 36 ms per frame (the phone's later reading): still the 30 fps slot (the frames come at ~28 fps).
    {
        auto cost = [](long long, double) { return 36.0; };
        const Result r = simulate<Pacer>(60000, cost);
        const Result o = simulate<Pacer180>(60000, cost);
        report("36 ms steady", r, o, 2000, 60000);
        check(r.stepAt(60000) == 0, "36 ms steady", "keeps the 30 fps slot");
    }
    // 3. The 1.8.0 incident: a burst of load right after the install (224 ms per frame for 6 s, as
    //    on the emulator), then 30 ms at 30 fps rising to 45 ms at 7.5 fps (0.15 ms per ms of slot:
    //    a longer slot has larger changes to encode).
    {
        auto cost = [](long long t, double slot) { return t < 6000 ? 224.0 : 25.0 + 0.15 * slot; };
        const Result r = simulate<Pacer>(60000, cost);
        const Result o = simulate<Pacer180>(60000, cost);
        report("burst then 30 ms", r, o, 20000, 60000);
        check(r.maxJump == 1, "burst then 30 ms", "one step at a time");
        check(r.stepAt(25000) == 0, "burst then 30 ms", "back at 30 fps 19 s after the burst");
        check(r.shareAtMost(0, 25000, 60000) == 1.0, "burst then 30 ms", "stays at 30 fps afterwards");
        check(o.maxJump >= 3, "burst then 30 ms", "1.8.0 jumped several steps at once");
        check(o.stepAt(60000) >= 2, "burst then 30 ms", "1.8.0 stayed at 15 fps or below (the regression)");
    }
    // 4. A phone that cannot keep up: 45 ms per frame. 20 fps most of the time; the 30 fps probe
    //    every 10 s fails and comes back.
    {
        auto cost = [](long long, double) { return 45.0; };
        const Result r = simulate<Pacer>(120000, cost);
        const Result o = simulate<Pacer180>(120000, cost);
        report("45 ms steady", r, o, 5000, 120000);
        check(r.stepAt(5000) == 1, "45 ms steady", "20 fps slot after 5 s");
        check(r.shareAtMost(1, 5000, 120000) == 1.0, "45 ms steady", "never slower than 20 fps");
        check(r.shareAtMost(0, 5000, 120000) < 0.4, "45 ms steady", "probes of 30 fps are short");
    }
    // 5. Heavy load that lasts (150 ms per frame): steps down to 7.5 fps one step at a time.
    {
        auto cost = [](long long, double) { return 150.0; };
        const Result r = simulate<Pacer>(60000, cost);
        check(r.maxJump == 1, "150 ms steady", "one step at a time");
        check(r.stepAt(60000) == 4, "150 ms steady", "ends at 7.5 fps");
    }
    // 6. Single spikes (a key frame, a busy moment: one frame in ten at 120 ms) do not move it.
    {
        auto cost = [](long long t, double) { return (t / 33) % 10 == 0 ? 120.0 : 25.0; };
        const Result r = simulate<Pacer>(60000, cost);
        check(r.changes == 0, "spikes", "no change");
    }
    // 7. Warm-up: 200 ms frames in the first second after the encoder opens do not count.
    {
        auto cost = [](long long t, double) { return t < 1000 ? 200.0 : 20.0; };
        const Result r = simulate<Pacer>(30000, cost);
        check(r.changes == 0, "warm-up", "no change");
    }
    // 8. A cost inflated by the longer slot: 38.5 ms at 20 fps but 34 ms at 30 fps (after a 4 s burst
    //    that sent it to 20 fps). The rule to shorten (under 85 % of 33 ms) never holds; the probe
    //    brings 30 fps back.
    {
        auto cost = [](long long t, double slot) { return t < 4000 ? 60.0 : 26.0 + 0.25 * slot; };
        const Result r = simulate<Pacer>(60000, cost);
        const Result o = simulate<Pacer180>(60000, cost);
        report("inflated cost", r, o, 30000, 60000);
        check(r.stepAt(30000) == 0, "inflated cost", "back at 30 fps through the probe");
        check(r.shareAtMost(0, 30000, 60000) == 1.0, "inflated cost", "stays there");
    }
    std::printf("%s\n", failures == 0 ? "all passed" : "FAILED");
    return failures == 0 ? 0 : 1;
}
