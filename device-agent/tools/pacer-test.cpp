// Host test of the mirror's frame pacing decision (device-agent/mirror/pacer.h). Not shipped.
//
//   g++ -std=c++11 -Wall -Wextra -I device-agent/mirror device-agent/tools/pacer-test.cpp -o /tmp/pacer-test && /tmp/pacer-test
//
// Each scenario feeds a simulated stream: a frame every max(slot, cost) ms, its convert + encode
// cost given by the scenario. The numbers come from the Jolla Phone (about 30 ms per frame at
// 720x1584, `phone 29 ms` / `36 ms`, `encode 30 ms`) and from the emulator (a 6 s load burst gave
// 224 ms frames). Agent 1.8.0's rule is simulated next to it for comparison.

#include "pacer.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <utility>
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

// The capture loop (agent mirror.cpp pumpVideo / notePaceArrival) against a compositor that renders
// on every 60 Hz vsync while the screen changes: a request is filled at the next vsync after it and
// arrives `readbackMs` later (glReadPixels in lipstick's render thread, then its GUI thread sends
// the frame). `lead` gives how long before the slot the next request goes out. Returns the frame
// rate over 20 s.
double captureLoop(int fps, double readbackMs, const std::function<double(const Pacer &)> &lead)
{
    Pacer pacer(fps);
    const double vsync = 1000.0 / 60.0;
    double grid = -1;
    double arrival = 0;
    int frames = 0;
    while (arrival < 20000) {
        const double interval = pacer.intervalMs();
        const double due = grid < 0 ? arrival : std::ceil(grid + interval - lead(pacer));
        const double request = std::max(arrival, due);
        const double render = std::ceil(request / vsync + 1e-9) * vsync;
        arrival = render + readbackMs;
        pacer.addReadback(readbackMs);
        const double slot = grid + interval;
        grid = (grid < 0 || arrival > slot + interval / 2 || arrival < slot - interval) ? arrival : slot;
        ++frames;
    }
    return frames / 20.0;
}

double oldLead(const Pacer &p) { return p.intervalMs() * 0.5; } // agent 1.8.0 to 1.10.6
double newLead(const Pacer &p) { return p.leadMs(); }            // agent 1.10.7

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
    // 9. A change after a still screen (phone fast again, pace left at 7.5 fps by earlier load): wake()
    //    is back at 30 fps at once; without it the pace climbs one step per HOLD_MS.
    {
        auto slowStart = []() {
            Pacer p;
            p.encoderOpened(0);
            long long t = 0;
            while (p.step() < 4) {
                t += static_cast<long long>(std::max(p.intervalMs(), 150.0));
                p.addCost(150.0, t);
            }
            return std::make_pair(p, t + 5000); // 5 s without frames
        };
        std::pair<Pacer, long long> a = slowStart();
        const long long wakeAt = a.second;
        check(a.first.wake(wakeAt) && a.first.step() == 0, "wake", "30 fps slot at the first changed frame");
        check(!a.first.wake(wakeAt), "wake", "no change when already at 30 fps");
        std::pair<Pacer, long long> b = slowStart();
        long long t = b.second;
        while (b.first.step() > 0) {
            t += static_cast<long long>(std::max(b.first.intervalMs(), 30.0));
            b.first.addCost(30.0, t);
        }
        std::printf("     wake: back at 30 fps after 0 ms with wake(), %lld ms without\n", t - wakeAt);
        check(t - wakeAt >= 4 * Pacer::HOLD_MS, "wake", "without wake() the climb takes one hold per step");
    }
    // 10. The step table (agent 1.10.7): 30 fps as before, 60 adds 45 and 30 above the 30 fps steps,
    //     anything above 60 is 60.
    {
        Pacer p30(30);
        Pacer p60(60);
        Pacer p45(45);
        Pacer p90(90);
        check(p30.steps() == 5 && p30.stepFps(0) == 30 && p30.stepFps(1) == 20 && p30.stepFps(4) == 7.5, "steps",
              "30: 30, 20, 15, 10, 7.5");
        check(p60.steps() == 7 && p60.stepFps(0) == 60 && p60.stepFps(1) == 45 && p60.stepFps(2) == 30
                  && p60.stepFps(3) == 20 && p60.stepFps(6) == 7.5,
              "steps", "60: 60, 45, 30, 20, 15, 10, 7.5");
        check(p45.steps() == 6 && p45.stepFps(0) == 45 && p45.stepFps(1) == 30, "steps", "45: 45, 30, ...");
        check(p90.stepFps(0) == 60, "steps", "above 60 is 60");
        check(std::fabs(p60.intervalMs() - 1000.0 / 60) < 1e-9, "steps", "60 fps slot is 16.7 ms");
    }
    // 11. 60 fps: 12 ms per frame keeps 60; 25 ms settles at 30 or 45, never slower than 30.
    {
        Pacer fast(60);
        Pacer slow(60);
        fast.encoderOpened(0);
        slow.encoderOpened(0);
        double tf = 0;
        double ts = 0;
        int slowest = 0;
        while (tf < 60000) {
            tf += std::max(fast.intervalMs(), 12.0);
            fast.addCost(12.0, static_cast<long long>(tf));
        }
        while (ts < 60000) {
            ts += std::max(slow.intervalMs(), 25.0);
            slow.addCost(25.0, static_cast<long long>(ts));
            if (ts > 5000) {
                slowest = std::max(slowest, slow.step());
            }
        }
        check(fast.step() == 0, "60 fps", "12 ms per frame keeps 60 fps");
        check(slowest <= 2 && slow.step() >= 1, "60 fps", "25 ms per frame: 45 or 30 fps, never slower");
    }
    // 11b. 60 fps limit, the fastest step whose slot holds the per-frame cost, never a slower one.
    //      The Jolla Phone at 1.10.7: convert + encode 19 to 23 ms (median 21) and a 17 ms readback,
    //      just over a display frame, so a capture takes two (33 ms): 30 fps, where 45 only looked
    //      possible from the encode time. With a 10 ms readback the same encode settles at 45, and
    //      12 ms at 60.
    {
        struct Settle {
            int step;
            int changesAfter;  // changes of step after the first 10 s
            int slowestAfter;  // the slowest step after the first 10 s
        };
        auto settle = [](double readbackMs, double costBase) {
            Pacer p(60);
            p.encoderOpened(0);
            double t = 0;
            int frames = 0;
            Settle r = { 0, 0, 0 };
            int last = p.step();
            while (t < 120000) {
                const double c = costBase - 2 + (frames * 7) % 5;
                p.addReadback(readbackMs);
                t += std::max(std::max(p.intervalMs(), c), p.captureCycleMs());
                p.addCost(c, static_cast<long long>(t));
                if (t > 10000) {
                    r.changesAfter += p.step() != last;
                    r.slowestAfter = std::max(r.slowestAfter, p.step());
                }
                last = p.step();
                ++frames;
            }
            r.step = p.step();
            return r;
        };
        const Settle phone = settle(17, 21);
        const Settle quick = settle(10, 21);
        const Settle fast = settle(10, 12);
        std::printf("     60 fps limit: phone (21 ms, readback 17) ends at %.0f fps, readback 10 at %.0f, 12 ms at %.0f\n",
                    Pacer(60).stepFps(phone.step), Pacer(60).stepFps(quick.step), Pacer(60).stepFps(fast.step));
        check(phone.step == 2 && phone.slowestAfter == 2 && phone.changesAfter == 0, "60 fps, phone",
              "settles at 30 fps and stays");
        check(quick.step == 1 && quick.slowestAfter == 1 && quick.changesAfter == 0, "60 fps, readback 10",
              "settles at 45 fps and stays");
        check(fast.step == 0 && fast.changesAfter == 0, "60 fps, 12 ms", "keeps 60 fps");
        Pacer q(60);
        check(q.captureCycleMs() == 0, "capture cycle", "0 before a readback");
        q.addReadback(16);
        check(std::fabs(q.captureCycleMs() - 1000.0 / 60) < 1e-9, "capture cycle", "16 ms readback: one display frame");
    }
    // 12. The capture lead: half a slot without readback samples (as before), the display frame plus
    //     the median readback, at most a whole slot (the request then goes out at the arrival).
    {
        Pacer p(30);
        check(std::fabs(p.leadMs() - 1000.0 / 60) < 1e-9, "lead", "no samples: half a slot at 30 fps");
        p.addReadback(5);
        check(std::fabs(p.leadMs() - (1000.0 / 60 + 5)) < 1e-9, "lead", "5 ms readback: 21.7 ms");
        for (int i = 0; i < 15; ++i) {
            p.addReadback(40);
        }
        check(std::fabs(p.leadMs() - p.intervalMs()) < 1e-9, "lead", "40 ms readback: the whole slot");
        p.addReadback(-3);
        p.addReadback(1e9);
        check(p.readbackMs() == 40, "lead", "negative and absurd readbacks are ignored");
        Pacer q(60);
        check(std::fabs(q.leadMs() - q.intervalMs()) < 1e-9, "lead", "60 fps: the whole slot");
    }
    // 13. The capture loop. With the half-slot lead a frame that takes longer than half a slot to
    //     come back resets the grid, so every frame waits half a slot more than it needs: 35 to 65 ms
    //     of readback gives 12 to 15 fps (the Jolla Phone's 13.5 fps reading), the new lead 15 to
    //     20 fps. Only one request is in flight, so above one slot of readback the compositor sets
    //     the rate. A fast readback reaches the full rate at 30 and at 60 fps.
    {
        const double r45old = captureLoop(30, 45, oldLead);
        const double r45new = captureLoop(30, 45, newLead);
        const double r10new = captureLoop(30, 10, newLead);
        const double r5new60 = captureLoop(60, 5, newLead);
        const double r5old60 = captureLoop(60, 5, oldLead);
        const double r25new60 = captureLoop(60, 25, newLead);
        std::printf("     capture loop: readback 45 ms at 30 fps: %.1f fps before, %.1f now; 10 ms: %.1f; "
                    "60 fps, 5 ms: %.1f before, %.1f now; 25 ms: %.1f\n",
                    r45old, r45new, r10new, r5old60, r5new60, r25new60);
        check(r45old < 16 && captureLoop(30, 55, oldLead) < 13, "capture loop",
              "half-slot lead, 45 to 55 ms readback: 12 to 15 fps (as measured)");
        check(r45new > r45old + 2, "capture loop", "the new lead is faster with a slow readback");
        check(r10new > 29.5, "capture loop", "10 ms readback: 30 fps");
        check(r5new60 > 59, "capture loop", "60 fps with a 5 ms readback");
        check(r25new60 >= 29.5, "capture loop", "60 fps limit, 25 ms readback: at least 30 fps");
    }
    std::printf("%s\n", failures == 0 ? "all passed" : "FAILED");
    return failures == 0 ? 0 : 1;
}
