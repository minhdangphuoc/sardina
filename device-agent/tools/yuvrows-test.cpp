// Host test of the mirror's RGB to I420 rows (device-agent/src/yuvrows.h). Not shipped.
//
// The vectorisable full-size path must give the same bytes as the general one, and its speed is
// printed next to it (relative evidence only: the phone is an aarch64 build).

#include "yuvrows.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main()
{
    const int w = 720;
    const int h = 1584;
    std::vector<uchar> src(static_cast<size_t>(w) * h * 4);
    srand(7);
    for (uchar &c : src) {
        c = static_cast<uchar>(rand());
    }
    // Extremes for the clamps.
    for (int x = 0; x < 64; ++x) {
        src[x] = 0;
        src[w * 4 + x] = 255;
    }
    const size_t planes = static_cast<size_t>(w) * h * 3 / 2;
    std::vector<uchar> a(planes), b(planes);
    double general = 1e9;
    double rgbx = 1e9;
    for (int it = 0; it < 20; ++it) {
        for (int pass = 0; pass < 2; ++pass) {
            uchar *y = pass ? b.data() : a.data();
            uchar *u = y + w * h;
            uchar *v = u + (w / 2) * (h / 2);
            const auto t0 = std::chrono::steady_clock::now();
            for (int r = 0; r < h; r += 2) {
                const uchar *p = &src[static_cast<size_t>(r) * w * 4];
                const uchar *q = p + w * 4;
                if (pass) {
                    emitRowPairRgbx(p, q, w, y + r * w, y + (r + 1) * w, u + (r / 2) * (w / 2), v + (r / 2) * (w / 2));
                } else {
                    emitRowPair(p, q, 4, w, y + r * w, y + (r + 1) * w, u + (r / 2) * (w / 2), v + (r / 2) * (w / 2));
                }
            }
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            (pass ? rgbx : general) = std::min(pass ? rgbx : general, ms);
        }
    }
    const bool same = a == b;
    std::printf("%s yuvrows: the RGBX path gives the same bytes as the general one\n", same ? "ok  " : "FAIL");
    std::printf("     yuvrows: 720x1584 on this host: general %.2f ms, RGBX %.2f ms (one thread)\n", general, rgbx);
    return same ? 0 : 1;
}
