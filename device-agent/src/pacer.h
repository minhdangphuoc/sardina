#ifndef PACER_H
#define PACER_H

// The frame pacing decision of the VP8 mirror, free of Qt so it can be tested on the build host
// (device-agent/tools/pacer-test.cpp).
//
// The slot is 1, 1.5, 2, 3 or 4 frame intervals (whole 60 Hz display frames at 30 fps). The cost is
// the median convert + encode time of the latest delta frames; the next frame is captured while this
// one is encoded, so a cost up to the slot keeps up. The slot moves one step at a time and only after
// a condition held for HOLD_MS, so a burst of load does not drop the pace at once. Samples are
// forgotten at every change because a longer slot has larger frame changes, which cost more to
// encode; the periodic probe keeps such an inflated cost from trapping the pace.

#include <algorithm>
#include <vector>

class Pacer
{
public:
    static const int STEPS = 5;
    static constexpr double SLOWER_FIT = 1.1;  // a longer slot once the cost passes this share of the slot
    static constexpr double FASTER_FIT = 0.85; // a shorter slot once the cost is under this share of it
    static constexpr double PROBE_FIT = 1.25;  // ... or, every PROBE_MS, once it is under this share
    static const long long HOLD_MS = 2000;     // how long a condition must last
    static const long long PROBE_MS = 10000;   // how long a lengthened pace lasts before it is tried shorter
    static const long long WARMUP_MS = 1000;   // costs right after the encoder opens (cold caches) do not count
    static const int MIN_SAMPLES = 8;          // samples before a decision
    static const int WINDOW = 15;              // the median is over at most this many delta frames

    explicit Pacer(int fps = 30)
        : m_fps(fps > 0 ? fps : 30)
    {
    }

    int step() const { return m_step; }
    // The slot of a step in ms.
    double slotMs(int step) const { return 1000.0 * halfIntervals(step) / (2.0 * m_fps); }
    double intervalMs() const { return slotMs(m_step); }
    // The median cost in ms, -1 before enough samples since the last change.
    double costMs() const { return m_cost; }
    // The median that caused the last change of slot.
    double changeCostMs() const { return m_changeCost; }

    // The encoder was (re)opened at `now`: the next costs are not representative for a while.
    void encoderOpened(long long now)
    {
        m_openedAt = now;
        clear();
    }

    // The screen changed after a pause: back to the full pace at once. The slower step and the costs
    // were from before the pause. Returns true when the slot changed.
    bool wake(long long now)
    {
        return m_step > 0 && change(0, now);
    }

    // The convert + encode time of a delta frame finished at `now` (ms on a steady clock). Returns
    // true when the slot changed.
    bool addCost(double ms, long long now)
    {
        if (m_changedAt < 0) {
            m_changedAt = now;
        }
        if (m_openedAt >= 0 && now - m_openedAt < WARMUP_MS) {
            return false;
        }
        m_costs.push_back(ms);
        if (static_cast<int>(m_costs.size()) > WINDOW) {
            m_costs.erase(m_costs.begin());
        }
        if (static_cast<int>(m_costs.size()) < MIN_SAMPLES) {
            m_cost = -1;
            return false;
        }
        std::vector<double> sorted = m_costs;
        std::sort(sorted.begin(), sorted.end());
        m_cost = sorted[sorted.size() / 2];

        const bool slower = m_step + 1 < STEPS && m_cost > SLOWER_FIT * slotMs(m_step);
        const bool faster = m_step > 0 && m_cost < FASTER_FIT * slotMs(m_step - 1);
        if (slower) {
            m_fastSince = -1;
            if (m_slowSince < 0) {
                m_slowSince = now;
            }
            if (now - m_slowSince >= HOLD_MS) {
                return change(m_step + 1, now);
            }
            return false;
        }
        m_slowSince = -1;
        if (faster) {
            if (m_fastSince < 0) {
                m_fastSince = now;
            }
            if (now - m_fastSince >= HOLD_MS) {
                return change(m_step - 1, now);
            }
            return false;
        }
        m_fastSince = -1;
        if (m_step > 0 && now - m_changedAt >= PROBE_MS && m_cost < PROBE_FIT * slotMs(m_step - 1)) {
            return change(m_step - 1, now);
        }
        return false;
    }

private:
    static int halfIntervals(int step)
    {
        static const int HALF_INTERVALS[STEPS] = { 2, 3, 4, 6, 8 };
        return HALF_INTERVALS[std::max(0, std::min(STEPS - 1, step))];
    }

    bool change(int step, long long now)
    {
        m_step = step;
        m_changedAt = now;
        m_changeCost = m_cost;
        clear();
        return true;
    }

    void clear()
    {
        m_costs.clear();
        m_cost = -1;
        m_slowSince = -1;
        m_fastSince = -1;
    }

    int m_fps;
    int m_step = 0;
    double m_cost = -1;
    double m_changeCost = -1;
    std::vector<double> m_costs;
    long long m_slowSince = -1;
    long long m_fastSince = -1;
    long long m_changedAt = -1;
    long long m_openedAt = -1;
};

#endif
