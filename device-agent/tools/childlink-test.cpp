// Host test of the daemon <-> module line framing (device-agent/common/linebuffer.h). Not shipped.

#include "linebuffer.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool ok, const char *what)
{
    std::printf("%s childlink: %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) {
        ++failures;
    }
}

std::vector<std::string> feedAll(LineBuffer &buffer, const std::string &data)
{
    std::vector<std::string> lines;
    buffer.feed(data.data(), data.size(), lines);
    return lines;
}
}

int main()
{
    {
        LineBuffer b(256);
        const std::vector<std::string> lines = feedAll(b, "{\"a\":1}\n{\"b\":2}\n");
        check(lines.size() == 2 && lines[0] == "{\"a\":1}" && lines[1] == "{\"b\":2}", "two lines in one read");
    }
    {
        LineBuffer b(256);
        std::vector<std::string> lines = feedAll(b, "{\"end\":");
        check(lines.empty() && b.pending() == "{\"end\":", "a truncated line waits");
        lines = feedAll(b, "\"replaced\"}\n{\"x\"");
        check(lines.size() == 1 && lines[0] == "{\"end\":\"replaced\"}", "the rest completes it");
        check(b.pending() == "{\"x\"", "the next partial line is kept");
    }
    {
        LineBuffer b(256);
        std::vector<std::string> lines;
        const std::string data = "a\nb\nc\n";
        for (char c : data) {
            b.feed(&c, 1, lines);
        }
        check(lines.size() == 3 && lines[2] == "c", "byte by byte");
    }
    {
        LineBuffer b(256);
        std::vector<std::string> lines = feedAll(b, std::string(256, 'x') + "\nok\n");
        check(lines.size() == 2 && lines[0].size() == 256 && b.dropped() == 0, "exactly 256 bytes pass");
    }
    {
        LineBuffer b(256);
        std::vector<std::string> lines = feedAll(b, std::string(200, 'x'));
        lines = feedAll(b, std::string(100, 'y'));
        check(lines.empty() && b.pending().empty(), "an oversized line is not buffered");
        lines = feedAll(b, std::string(5000, 'z') + "\n{\"ok\":1}\n");
        check(lines.size() == 1 && lines[0] == "{\"ok\":1}" && b.dropped() == 1, "it is dropped whole, the next line passes");
    }
    {
        LineBuffer b(256);
        std::vector<std::string> lines = feedAll(b, "\n\n");
        check(lines.size() == 2 && lines[0].empty(), "empty lines are lines");
    }
    return failures == 0 ? 0 : 1;
}
