#ifndef RETRYBUDGET_H
#define RETRYBUDGET_H

// At most `max` tries within any `windowMs`, free of Qt so it can be tested on the build host
// (device-agent/tools/retrybudget-test.cpp). The mirror uses it to reopen a broken recorder a few
// times before ending the stream.

#include <deque>

class RetryBudget
{
public:
    RetryBudget(int max, long long windowMs)
        : m_max(max)
        , m_windowMs(windowMs)
    {
    }

    // True, and the try is counted, while the budget lasts at `now` (ms on a steady clock).
    bool take(long long now)
    {
        while (!m_times.empty() && now - m_times.front() >= m_windowMs) {
            m_times.pop_front();
        }
        if (static_cast<int>(m_times.size()) >= m_max) {
            return false;
        }
        m_times.push_back(now);
        return true;
    }

private:
    int m_max;
    long long m_windowMs;
    std::deque<long long> m_times;
};

#endif
