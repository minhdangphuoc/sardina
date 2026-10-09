#ifndef FIRSTLINE_H
#define FIRSTLINE_H

// Collects the first line of a reply across socket reads, so the client judges the status (or a
// refusal) on a whole line and not on whatever the first read happened to hold. Free of Qt so it
// can be tested on the build host (device-agent/tools/firstline-test.cpp).

#include <cstddef>
#include <cstring>
#include <string>

class FirstLine
{
public:
    // A status or refusal line is far shorter; past this the line is judged as it is.
    static const size_t MAX_BYTES = 65536;

    // Takes the next received bytes. Returns true once the line is complete: a newline arrived or
    // MAX_BYTES were collected without one. Bytes after that are ignored.
    bool feed(const char *data, size_t size)
    {
        if (m_complete) {
            return true;
        }
        const char *newline = static_cast<const char *>(std::memchr(data, '\n', size));
        size_t take = newline ? static_cast<size_t>(newline - data) : size;
        if (take > MAX_BYTES - m_line.size()) {
            take = MAX_BYTES - m_line.size();
        }
        m_line.append(data, take);
        m_complete = newline != nullptr || m_line.size() >= MAX_BYTES;
        return m_complete;
    }

    bool complete() const { return m_complete; }
    // The line without its newline (so far, while not complete).
    const std::string &line() const { return m_line; }

private:
    std::string m_line;
    bool m_complete = false;
};

#endif
