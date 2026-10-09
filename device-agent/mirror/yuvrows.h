#ifndef YUVROWS_H
#define YUVROWS_H

// RGB rows to I420 for the VP8 mirror (BT.601, limited range), free of Qt so the host test
// device-agent/tools/yuvrows-test.cpp can check that both paths give the same bytes.

typedef unsigned char uchar;

inline uchar clampByte(int v)
{
    return static_cast<uchar>(v < 0 ? 0 : (v > 255 ? 255 : v));
}

inline uchar lumaOf(int r, int g, int b)
{
    return static_cast<uchar>(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
}

// Y for two rows, and U and V from each 2x2 block (sums of four pixels; BT.601, limited range).
// `step` is the distance between pixels in bytes (4 for the recorder's RGBX rows, 3 for scaled rows).
inline void emitRowPair(const uchar *a, const uchar *b, int step, int width, uchar *y0, uchar *y1, uchar *u, uchar *v)
{
    for (int x = 0; x < width; x += 2) {
        const uchar *p = a + x * step;
        const uchar *q = b + x * step;
        const int r0 = p[0], g0 = p[1], b0 = p[2];
        const int r1 = p[step], g1 = p[step + 1], b1 = p[step + 2];
        const int r2 = q[0], g2 = q[1], b2 = q[2];
        const int r3 = q[step], g3 = q[step + 1], b3 = q[step + 2];
        y0[x] = lumaOf(r0, g0, b0);
        y0[x + 1] = lumaOf(r1, g1, b1);
        y1[x] = lumaOf(r2, g2, b2);
        y1[x + 1] = lumaOf(r3, g3, b3);
        const int rs = r0 + r1 + r2 + r3;
        const int gs = g0 + g1 + g2 + g3;
        const int bs = b0 + b1 + b2 + b3;
        // (128 << 10) + 512: the chroma offset and rounding, which also keeps the sum positive.
        u[x >> 1] = clampByte((-38 * rs - 74 * gs + 112 * bs + 131584) >> 10);
        v[x >> 1] = clampByte((112 * rs - 94 * gs - 18 * bs + 131584) >> 10);
    }
}

// The same for the recorder's RGBX rows at full size, written so the compiler can vectorise it:
// luma per pixel, then chroma per 2x2 block, with fixed 4-byte pixels. Same output as emitRowPair.
__attribute__((optimize("O3"))) inline void emitRowPairRgbx(const uchar *__restrict a, const uchar *__restrict b, int width,
                                                     uchar *__restrict y0, uchar *__restrict y1,
                                                     uchar *__restrict u, uchar *__restrict v)
{
    for (int x = 0; x < width; ++x) {
        y0[x] = lumaOf(a[4 * x], a[4 * x + 1], a[4 * x + 2]);
        y1[x] = lumaOf(b[4 * x], b[4 * x + 1], b[4 * x + 2]);
    }
    for (int c = 0; c < width / 2; ++c) {
        const int rs = a[8 * c] + a[8 * c + 4] + b[8 * c] + b[8 * c + 4];
        const int gs = a[8 * c + 1] + a[8 * c + 5] + b[8 * c + 1] + b[8 * c + 5];
        const int bs = a[8 * c + 2] + a[8 * c + 6] + b[8 * c + 2] + b[8 * c + 6];
        u[c] = clampByte((-38 * rs - 74 * gs + 112 * bs + 131584) >> 10);
        v[c] = clampByte((112 * rs - 94 * gs - 18 * bs + 131584) >> 10);
    }
}

#endif
