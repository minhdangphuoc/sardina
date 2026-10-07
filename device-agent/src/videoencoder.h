#ifndef VIDEOENCODER_H
#define VIDEOENCODER_H

#include <QByteArray>
#include <QSize>
#include <QString>
#include <QVector>

struct vpx_codec_ctx;
struct vpx_codec_enc_cfg;
struct vpx_image;

// VP8 encoding for the mirror's "vp8" encoding (agent 1.6.0) through libvpx in real-time mode.
// convert() scales an RGBX frame (bytes R, G, B, X, as lipstick's recorder delivers it) to the
// encoder size and converts it to I420 (BT.601, limited range: what browsers assume for VP8);
// encode() compresses the converted frame. Rate control is constant bitrate; key frames are placed
// only by the caller (forceKey), except the first frame after open(), which is always one. The
// encoder never drops a frame by itself, so every encoded frame is a valid successor of the last.
// Conversion runs in horizontal bands on half the cores, at most four (agent 1.8.0); with scaling, each
// source row is filtered horizontally once and kept for the next output row.
class VideoEncoder
{
public:
    VideoEncoder();
    ~VideoEncoder();

    // (Re)opens the encoder for frames of `size` (both sides even, at least 16).
    bool open(const QSize &size, int bitrateKbps, int fps, QString *error);
    void close();
    bool isOpen() const { return m_codec != nullptr; }
    QSize size() const { return m_size; }
    // Changes the target bitrate from the next frame on (no key frame needed).
    bool setBitrate(int kbps);
    int bitrate() const { return m_bitrate; }

    // Scales and converts one frame into the current picture. `rows` points at the first byte of
    // the first stored row; stored rows run bottom-up when yInverted is true.
    void convert(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted);
    // The current picture equals the last encoded one (byte for byte after conversion).
    bool sameAsLast() const;
    // Encodes the current picture. ptsMs and durationMs are in milliseconds of the stream clock.
    bool encode(qint64 ptsMs, qint64 durationMs, bool forceKey, QByteArray *out, bool *key, QString *error);
    // Encodes the last encoded picture once more (agent 1.8.0): on a screen that stopped changing,
    // the encoder spends the spare bits on sharpening what is shown. False before the first encode.
    bool encodeAgain(qint64 ptsMs, qint64 durationMs, QByteArray *out, QString *error);
    // Threads used for conversion (1..4) and given to libvpx.
    int convertThreads() const { return m_threads; }

    // The output size for a screen of `screen` at `width` (0 or >= screen width: native), with
    // even sides as I420 needs.
    static QSize outputSize(const QSize &screen, int width);

private:
    // Converts output rows [y0, y1) (both even) into `planes` (I420), with scratch rows of its own:
    // `rgb` holds two scaled RGB rows (w * 6 bytes), `hRows` two filtered source rows (w * 6 values).
    void convertBand(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted, int y0, int y1,
                     uchar *planes, uchar *rgb, quint16 *hRows) const;
    bool encodePlanes(uchar *planes, qint64 ptsMs, qint64 durationMs, bool forceKey, QByteArray *out, bool *key,
                      QString *error);

    vpx_codec_ctx *m_codec;
    vpx_codec_enc_cfg *m_cfg;
    vpx_image *m_image;
    QSize m_size;
    int m_bitrate;
    QVector<uchar> m_planes[2]; // I420 of the current and the last encoded picture
    int m_current;
    bool m_hasLast;
    // Bilinear scaling tables (built for the last source size).
    QSize m_tableSource;
    QVector<int> m_x0;
    QVector<int> m_fx;
    QVector<int> m_y0;
    QVector<int> m_fy;
    int m_threads;
    // Per band: two scaled RGB rows and two horizontally filtered source rows (16-bit, 3 channels).
    QVector<QVector<uchar>> m_rgbRows;
    QVector<QVector<quint16>> m_hRows;
};

#endif
