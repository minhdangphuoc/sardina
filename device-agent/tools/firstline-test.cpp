// Host test of the client's first-line collector (device-agent/src/firstline.h). Not shipped.
//
//   make -C device-agent/tools test

#include "firstline.h"

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

bool feed(FirstLine &f, const std::string &s) { return f.feed(s.data(), s.size()); }

}

int main()
{
    {
        FirstLine f;
        check(!feed(f, "{\"ok\":tr"), "a partial first chunk is not judged");
        check(!f.complete() && f.line() == "{\"ok\":tr", "the partial line is kept");
        check(feed(f, "ue}\n{\"next\":1}\n"), "the line completes with its newline");
        check(f.line() == "{\"ok\":true}", "the line spans both chunks, without the newline or later lines");
        check(feed(f, "more\n") && f.line() == "{\"ok\":true}", "bytes after the line are ignored");
    }
    {
        FirstLine f;
        check(feed(f, "\n") && f.line().empty(), "an empty first line is complete");
    }
    {
        FirstLine f;
        check(!feed(f, "") && !f.complete(), "no bytes, no line");
    }
    {
        FirstLine f;
        const std::string big(FirstLine::MAX_BYTES - 1, 'x');
        check(!feed(f, big), "just under the cap without a newline waits");
        check(feed(f, "yz") && f.line().size() == FirstLine::MAX_BYTES, "the cap completes the line");
    }
    {
        FirstLine f;
        const std::string raw("\0\x01\n", 3);
        check(feed(f, raw) && f.line() == std::string("\0\x01", 2), "binary bytes before the newline are kept");
    }
    std::printf("%s\n", failures == 0 ? "all passed" : "FAILED");
    return failures == 0 ? 0 : 1;
}
