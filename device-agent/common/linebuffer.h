#ifndef LINEBUFFER_H
#define LINEBUFFER_H

// Splits a byte stream into newline-terminated lines of at most a fixed size. Qt-free so
// device-agent/tools/childlink-test.cpp can check the framing on the build host.

#include <cstddef>
#include <cstring>
#include <string>
#include <vector>

class LineBuffer
{
public:
    explicit LineBuffer(size_t maxBytes)
        : m_max(maxBytes)
    {
    }

    // Appends received bytes and moves every completed line (without its newline) to `lines`. A
    // line longer than the cap is dropped whole, up to its newline, and counted.
    void feed(const char *data, size_t size, std::vector<std::string> &lines)
    {
        while (size > 0) {
            const char *newline = static_cast<const char *>(std::memchr(data, '\n', size));
            const size_t take = newline ? static_cast<size_t>(newline - data) : size;
            if (!m_skipping) {
                if (m_line.size() + take > m_max) {
                    m_skipping = true;
                    m_line.clear();
                } else {
                    m_line.append(data, take);
                }
            }
            if (!newline) {
                return;
            }
            if (m_skipping) {
                ++m_dropped;
                m_skipping = false;
            } else {
                lines.push_back(m_line);
                m_line.clear();
            }
            data = newline + 1;
            size -= take + 1;
        }
    }

    size_t dropped() const { return m_dropped; }
    // Bytes of an unfinished line (nothing while an oversized one is skipped).
    const std::string &pending() const { return m_line; }

private:
    size_t m_max;
    std::string m_line;
    bool m_skipping = false;
    size_t m_dropped = 0;
};

#endif
