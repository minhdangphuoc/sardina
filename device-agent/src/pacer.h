#ifndef PACER_H
#define PACER_H

// The frame pacing decision of the VP8 mirror, free of Qt so it can be tested on the build host
// (device-agent/tools/pacer-test.cpp).
//
// The slot is one of the steps 60, 45, 30, 20, 15, 10 and 7.5 fps, starting at the stream's frame
// rate (at most 60, the phone's "Frame rate limit"); a rate above 30 that is not in the table is its
// own first step. At 30 fps the steps are 1, 1.5, 2, 3 and 4 frame intervals as before agent 1.10.7.
// The cost is the larger of the median convert + encode time of the latest delta frames and the
// capture cycle; the next frame is captured while this one is encoded, so a cost up to the slot
// keeps up. The pace settles at the fastest step whose slot holds the cost (within SLOWER_FIT).
// Only one request is in flight and the compositor fills it at a display frame, so a capture takes
// whole display frames: a readback just over one (17 ms on the Jolla Phone) allows 30 fps, not 45. The slot moves one step at a time and only after
// a condition held for HOLD_MS, so a burst of load does not drop the pace at once. Samples are
// forgotten at every change because a longer slot has larger frame changes, which cost more to
// encode; the periodic probe keeps such an inflated cost from trapping the pace.

#include <algorithm>
#include <cmath>
#include <vector>

class Pacer
{
public:
    static const int MAX_STEPS = 8;
    static const int MAX_FPS = 60;
    static constexpr double SLOWER_FIT = 1.1;  // a longer slot once the cost passes this share of the slot
    static constexpr double FASTER_FIT = 0.85; // a shorter slot once the cost is under this share of it
    static constexpr double PROBE_FIT = 1.25;  // ... or, every PROBE_MS, once it is under this share
                                               // (a longer slot inflates the encode cost)
    static const long long HOLD_MS = 2000;     // how long a condition must last
    static const long long PROBE_MS = 10000;   // how long a lengthened pace lasts before it is tried shorter
    static const long long WARMUP_MS = 1000;   // costs right after the encoder opens (cold caches) do not count
    static const int MIN_SAMPLES = 8;          // samples before a decision
    static const int WINDOW = 15;              // the median is over at most this many delta frames
    // Capture lead (agent 1.10.7): a frame request goes out this long before its slot. The compositor
    // fills it at its next render (up to one display frame later) and then reads the screen back;
    // the lead is that display frame plus the median readback, at least half and at most a whole
    // slot. At a whole slot the next frame is requested as soon as the last one arrived.
    static constexpr double DISPLAY_FRAME_MS = 1000.0 / 60.0;
    static const int READBACK_WINDOW = 15;

    explicit Pacer(int fps = 30)
    {
        const int f = fps <= 0 ? 30 : fps > MAX_FPS ? int(MAX_FPS) : fps;
        // Above 30: the rate, then 45 (if below it), then the 30 fps steps.
        if (f > 30) {
            m_fps[m_steps++] = f;
            if (f > 45) {
                m_fps[m_steps++] = 45;
            }
        }
        const double base = std::min(f, 30);
        static const int HALF_INTERVALS[] = { 2, 3, 4, 6, 8 };
        for (int h : HALF_INTERVALS) {
            m_fps[m_steps++] = 2.0 * base / h;
        }
    }

    int step() const { return m_step; }
    int steps() const { return m_steps; }
    // The frame rate and the slot of a step in ms.
    double stepFps(int step) const { return m_fps[std::max(0, std::min(m_steps - 1, step))]; }
    double slotMs(int step) const { return 1000.0 / stepFps(step); }
    double intervalMs() const { return slotMs(m_step); }

    // The compositor's readback of a frame: from its render (the recorder's frame time) to the
    // agent's receipt, ms. Negative or absurd values (another clock) are ignored.
    void addReadback(double ms)
    {
        if (ms < 0 || ms > 5000) {
            return;
        }
        m_readbacks.push_back(ms);
        if (static_cast<int>(m_readbacks.size()) > READBACK_WINDOW) {
            m_readbacks.erase(m_readbacks.begin());
        }
        std::vector<double> sorted = m_readbacks;
        std::sort(sorted.begin(), sorted.end());
        m_readback = sorted[sorted.size() / 2];
    }
    // The median readback, -1 before the first.
    double readbackMs() const { return m_readback; }
    // How long before its slot the next frame is requested.
    double leadMs() const
    {
        const double slot = intervalMs();
        const double lead = DISPLAY_FRAME_MS + std::max(0.0, m_readback);
        return std::max(slot / 2, std::min(slot, lead));
    }
    // Request to arrival with one request in flight: the display frames the readback spans, 0 before
    // the first readback.
    double captureCycleMs() const
    {
        if (m_readback < 0) {
            return 0;
        }
        return DISPLAY_FRAME_MS * std::max(1.0, std::ceil(m_readback / DISPLAY_FRAME_MS - 1e-6));
    }
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
        m_cost = std::max(sorted[sorted.size() / 2], captureCycleMs());

        const bool slower = m_step + 1 < m_steps && m_cost > SLOWER_FIT * slotMs(m_step);
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

    double m_fps[MAX_STEPS] = {};
    int m_steps = 0;
    int m_step = 0;
    std::vector<double> m_readbacks;
    double m_readback = -1;
    double m_cost = -1;
    double m_changeCost = -1;
    std::vector<double> m_costs;
    long long m_slowSince = -1;
    long long m_fastSince = -1;
    long long m_changedAt = -1;
    long long m_openedAt = -1;
};

#endif
