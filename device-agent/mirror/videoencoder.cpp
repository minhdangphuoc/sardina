#include "videoencoder.h"
#include "yuvrows.h"

#include <QThread>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>
#include <vpx/vp8cx.h>
#include <vpx/vpx_encoder.h>

namespace {

const int MIN_SIDE = 16;
// A fixed speed avoids automatic changes that overshoot the target bitrate during scrolling. Faster
// speeds lose the rate control on screen content (host, 720x1584, 2000 kbit/s CBR): -8 saves about
// 15 % of the encode time but sends twice the target, -12 and -16 five times.
const int CPU_USED = -6;
// Macroblocks this similar to the last frame are skipped (screen content; WebRTC uses 100).
const int STATIC_THRESHOLD = 100;
const int MAX_INTRA_PCT = 900;

int evenDown(int v)
{
    return v & ~1;
}

// Half the cores, at most four: the other half is the compositor's and the mirrored app's.
int encoderThreads()
{
    return qBound(1, QThread::idealThreadCount() / 2, 4);
}

vp8e_token_partitions tokenPartitions(int threads)
{
    return threads >= 4 ? VP8_FOUR_TOKENPARTITION : threads >= 2 ? VP8_TWO_TOKENPARTITION : VP8_ONE_TOKENPARTITION;
}

// Bilinear taps for `out` samples over `in` (centres aligned), 8-bit weights for the second tap.
void buildTaps(int in, int out, QVector<int> *index, QVector<int> *weight)
{
    index->resize(out);
    weight->resize(out);
    for (int i = 0; i < out; ++i) {
        const qint64 pos = ((2 * static_cast<qint64>(i) + 1) * in * 256) / (2 * static_cast<qint64>(out)) - 128;
        int i0 = pos < 0 ? 0 : static_cast<int>(pos >> 8);
        int f = pos < 0 ? 0 : static_cast<int>(pos & 255);
        if (i0 >= in - 1) {
            i0 = in - 2;
            f = 256;
        }
        (*index)[i] = i0;
        (*weight)[i] = f;
    }
}

}

class ConvertWorkers
{
public:
    explicit ConvertWorkers(int count)
    {
        for (int i = 0; i < count; ++i) {
            try {
                m_pool.emplace_back([this, i]() { run(i); });
            } catch (...) {
                break;
            }
        }
    }

    ~ConvertWorkers()
    {
        {
            std::lock_guard<std::mutex> lock(m_mutex);
            m_stopping = true;
            ++m_generation;
        }
        m_ready.notify_all();
        for (std::thread &worker : m_pool) {
            worker.join();
        }
    }

    int size() const { return static_cast<int>(m_pool.size()); }

    void start(int jobs, const std::function<void(int)> &job)
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_job = job;
        m_jobs = jobs;
        m_done = 0;
        ++m_generation;
        m_ready.notify_all();
    }

    void wait()
    {
        std::unique_lock<std::mutex> lock(m_mutex);
        m_finished.wait(lock, [this]() { return m_done == m_jobs; });
        m_job = std::function<void(int)>();
    }

private:
    void run(int index)
    {
        int seen = 0;
        for (;;) {
            std::function<void(int)> job;
            {
                std::unique_lock<std::mutex> lock(m_mutex);
                m_ready.wait(lock, [this, seen]() { return m_stopping || m_generation != seen; });
                if (m_stopping) {
                    return;
                }
                seen = m_generation;
                if (index >= m_jobs) {
                    continue;
                }
                job = m_job;
            }
            job(index + 1);
            {
                std::lock_guard<std::mutex> lock(m_mutex);
                ++m_done;
            }
            m_finished.notify_one();
        }
    }

    std::vector<std::thread> m_pool;
    std::mutex m_mutex;
    std::condition_variable m_ready;
    std::condition_variable m_finished;
    std::function<void(int)> m_job;
    int m_jobs = 0;
    int m_done = 0;
    int m_generation = 0;
    bool m_stopping = false;
};

VideoEncoder::VideoEncoder()
    : m_codec(nullptr)
    , m_cfg(new vpx_codec_enc_cfg_t)
    , m_image(new vpx_image_t)
    , m_bitrate(0)
    , m_current(0)
    , m_hasLast(false)
    , m_threads(1)
    , m_workers(new ConvertWorkers(encoderThreads() - 1))
{
    m_threads += m_workers->size();
    std::memset(m_cfg, 0, sizeof(*m_cfg));
    std::memset(m_image, 0, sizeof(*m_image));
}

VideoEncoder::~VideoEncoder()
{
    close();
    delete m_cfg;
    delete m_image;
}

QSize VideoEncoder::outputSize(const QSize &screen, int width)
{
    int w = screen.width();
    int h = screen.height();
    if (width > 0 && width < w) {
        h = static_cast<int>((static_cast<qint64>(h) * width + w / 2) / w);
        w = width;
    }
    return QSize(qMax(MIN_SIDE, evenDown(w)), qMax(MIN_SIDE, evenDown(h)));
}

bool VideoEncoder::open(const QSize &size, int bitrateKbps, QString *error)
{
    close();
    if (size.width() < MIN_SIDE || size.height() < MIN_SIDE || (size.width() & 1) || (size.height() & 1)) {
        *error = QStringLiteral("bad video size %1x%2").arg(size.width()).arg(size.height());
        return false;
    }
    vpx_codec_err_t err = vpx_codec_enc_config_default(vpx_codec_vp8_cx(), m_cfg, 0);
    if (err != VPX_CODEC_OK) {
        *error = QStringLiteral("vp8 defaults: ") + QString::fromLatin1(vpx_codec_err_to_string(err));
        return false;
    }
    m_cfg->g_w = static_cast<unsigned>(size.width());
    m_cfg->g_h = static_cast<unsigned>(size.height());
    m_cfg->g_timebase.num = 1;
    m_cfg->g_timebase.den = 1000; // pts in milliseconds
    // libvpx splits a frame by macroblock rows. On the 2-core emulator a second thread doubled the
    // encode time (it competes with lipstick), so it keeps one. The conversion uses the same number
    // of threads while libvpx's are idle.
    m_cfg->g_threads = static_cast<unsigned>(encoderThreads());
    m_cfg->g_lag_in_frames = 0;
    m_cfg->g_error_resilient = 0;
    m_cfg->g_pass = VPX_RC_ONE_PASS;
    m_cfg->rc_end_usage = VPX_CBR;
    m_cfg->rc_target_bitrate = static_cast<unsigned>(bitrateKbps);
    // Never drop inside the encoder: the stream drops raw captures before encoding instead, and every
    // encoded frame is sent.
    m_cfg->rc_dropframe_thresh = 0;
    m_cfg->rc_resize_allowed = 0;
    m_cfg->rc_min_quantizer = 8;
    m_cfg->rc_max_quantizer = 56;
    m_cfg->rc_undershoot_pct = 100;
    m_cfg->rc_overshoot_pct = 15;
    // A short buffer (ms) for a LAN or USB link: the rate follows the target within half a second.
    m_cfg->rc_buf_sz = 500;
    m_cfg->rc_buf_initial_sz = 200;
    m_cfg->rc_buf_optimal_sz = 300;
    m_cfg->kf_mode = VPX_KF_DISABLED; // the stream places key frames itself
    m_codec = new vpx_codec_ctx_t;
    std::memset(m_codec, 0, sizeof(*m_codec));
    err = vpx_codec_enc_init(m_codec, vpx_codec_vp8_cx(), m_cfg, 0);
    if (err != VPX_CODEC_OK) {
        *error = QStringLiteral("vp8 init: ") + QString::fromLatin1(vpx_codec_err_to_string(err));
        delete m_codec;
        m_codec = nullptr;
        return false;
    }
    vpx_codec_control(m_codec, VP8E_SET_CPUUSED, CPU_USED);
    vpx_codec_control(m_codec, VP8E_SET_NOISE_SENSITIVITY, 0);
    vpx_codec_control(m_codec, VP8E_SET_STATIC_THRESHOLD, STATIC_THRESHOLD);
    // One token partition per encoder thread (VP8 allows 1, 2, 4 or 8) so the threads tokenise in parallel.
    vpx_codec_control(m_codec, VP8E_SET_TOKEN_PARTITIONS, static_cast<int>(tokenPartitions(encoderThreads())));
    vpx_codec_control(m_codec, VP8E_SET_MAX_INTRA_BITRATE_PCT, MAX_INTRA_PCT);
    vpx_codec_control(m_codec, VP8E_SET_SCREEN_CONTENT_MODE, 1);

    m_size = size;
    m_bitrate = bitrateKbps;
    const int planeBytes = size.width() * size.height() * 3 / 2;
    m_planes[0].fill(0, planeBytes);
    m_planes[1].fill(0, planeBytes);
    m_current = 0;
    m_hasLast = false;
    m_tableSource = QSize();
    return true;
}

void VideoEncoder::close()
{
    if (m_codec) {
        vpx_codec_destroy(m_codec);
        delete m_codec;
        m_codec = nullptr;
    }
    m_planes[0].clear();
    m_planes[1].clear();
    m_planes[0].squeeze();
    m_planes[1].squeeze();
    m_rgbRows.clear();
    m_hRows.clear();
    m_hasLast = false;
    m_size = QSize();
}

bool VideoEncoder::setBitrate(int kbps)
{
    if (!m_codec || kbps == m_bitrate) {
        m_bitrate = kbps;
        return true;
    }
    m_cfg->rc_target_bitrate = static_cast<unsigned>(kbps);
    if (vpx_codec_enc_config_set(m_codec, m_cfg) != VPX_CODEC_OK) {
        m_cfg->rc_target_bitrate = static_cast<unsigned>(m_bitrate);
        return false;
    }
    m_bitrate = kbps;
    return true;
}

void VideoEncoder::convert(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted)
{
    if (!m_codec) {
        return;
    }
    const int w = m_size.width();
    const int h = m_size.height();
    const bool scaled = !(w == evenDown(width) && h == evenDown(height));
    if (scaled && m_tableSource != QSize(width, height)) {
        buildTaps(width, w, &m_x0, &m_fx);
        buildTaps(height, h, &m_y0, &m_fy);
        m_tableSource = QSize(width, height);
    }
    // Bands of at least 64 rows: below that a thread costs more than it saves.
    const int bands = qBound(1, qMin(m_threads, h / 64), 4);
    // Everything the bands share is resized and detached here, so the threads only touch raw memory.
    if (m_rgbRows.size() < bands) {
        m_rgbRows.resize(bands);
        m_hRows.resize(bands);
    }
    uchar *planes = m_planes[m_current].data();
    uchar *rgb[4];
    quint16 *hRows[4];
    for (int b = 0; b < bands; ++b) {
        m_rgbRows[b].resize(w * 6);
        m_hRows[b].resize(w * 6);
        rgb[b] = m_rgbRows[b].data();
        hRows[b] = m_hRows[b].data();
    }
    auto bandStart = [&](int b) { return evenDown(h * b / bands); };
    auto bandEnd = [&](int b) { return b + 1 == bands ? h : evenDown(h * (b + 1) / bands); };
    if (bands > 1) {
        m_workers->start(bands - 1, [&](int b) {
            convertBand(rows, width, height, bytesPerLine, yInverted, bandStart(b), bandEnd(b), planes, rgb[b], hRows[b]);
        });
    }
    convertBand(rows, width, height, bytesPerLine, yInverted, 0, bandEnd(0), planes, rgb[0], hRows[0]);
    if (bands > 1) {
        m_workers->wait();
    }
}

// Same size: Y, U and V straight from the recorder's rows (an odd last column or row is left out).
// Scaled: each output row is a vertical blend of two horizontally filtered source rows; a filtered
// row is kept while the next output row still needs it.
void VideoEncoder::convertBand(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted, int y0,
                               int y1, uchar *planes, uchar *rgb, quint16 *hRows) const
{
    const int w = m_size.width();
    const int h = m_size.height();
    uchar *yPlane = planes;
    uchar *uPlane = yPlane + w * h;
    uchar *vPlane = uPlane + (w / 2) * (h / 2);
    auto sourceRow = [&](int r) -> const uchar * {
        return rows + static_cast<qint64>(yInverted ? height - 1 - r : r) * bytesPerLine;
    };
    if (w == evenDown(width) && h == evenDown(height)) {
        for (int y = y0; y < y1; y += 2) {
            emitRowPairRgbx(sourceRow(y), sourceRow(y + 1), w, yPlane + y * w, yPlane + (y + 1) * w,
                            uPlane + (y / 2) * (w / 2), vPlane + (y / 2) * (w / 2));
        }
        return;
    }
    uchar *rowA = rgb;
    uchar *rowB = rowA + w * 3;
    quint16 *slot[2] = { hRows, hRows + w * 3 };
    int held[2] = { -1, -1 }; // the source row in each slot
    const int *x0 = m_x0.constData();
    const int *fx = m_fx.constData();

    auto filtered = [&](int r) -> const quint16 * {
        if (held[0] == r) {
            return slot[0];
        }
        if (held[1] == r) {
            return slot[1];
        }
        // Replace the row that is not the other tap of this output row (the older one).
        const int s = held[0] < held[1] ? 0 : 1;
        const uchar *src = sourceRow(r);
        quint16 *out = slot[s];
        for (int x = 0; x < w; ++x) {
            const uchar *p = src + x0[x] * 4;
            const int b = fx[x];
            const int a = 256 - b;
            out[x * 3] = static_cast<quint16>(p[0] * a + p[4] * b);
            out[x * 3 + 1] = static_cast<quint16>(p[1] * a + p[5] * b);
            out[x * 3 + 2] = static_cast<quint16>(p[2] * a + p[6] * b);
        }
        held[s] = r;
        return out;
    };
    auto sampleRow = [&](int y, uchar *out) {
        const int fy = m_fy[y];
        const int r = m_y0[y];
        const quint16 *top = filtered(r);
        // Rows only move down, so loading r + 1 replaces an older row, never r.
        const quint16 *bottom = filtered(r + 1);
        const int n = w * 3;
        for (int i = 0; i < n; ++i) {
            out[i] = static_cast<uchar>((top[i] * (256 - fy) + bottom[i] * fy + 32768) >> 16);
        }
    };
    for (int y = y0; y < y1; y += 2) {
        sampleRow(y, rowA);
        sampleRow(y + 1, rowB);
        emitRowPair(rowA, rowB, 3, w, yPlane + y * w, yPlane + (y + 1) * w, uPlane + (y / 2) * (w / 2),
                    vPlane + (y / 2) * (w / 2));
    }
}

bool VideoEncoder::sameAsLast() const
{
    return m_hasLast && m_planes[0].size() == m_planes[1].size()
        && std::memcmp(m_planes[0].constData(), m_planes[1].constData(), static_cast<size_t>(m_planes[0].size())) == 0;
}

bool VideoEncoder::encode(qint64 ptsMs, qint64 durationMs, bool forceKey, QByteArray *out, bool *key, QString *error)
{
    if (!encodePlanes(m_planes[m_current].data(), ptsMs, durationMs, forceKey, out, key, error)) {
        return false;
    }
    // The encoded picture is the reference for sameAsLast(); the next one is converted into the other buffer.
    m_hasLast = true;
    m_current = 1 - m_current;
    return true;
}

bool VideoEncoder::encodeAgain(qint64 ptsMs, qint64 durationMs, QByteArray *out, QString *error)
{
    if (!m_hasLast) {
        out->clear();
        *error = QStringLiteral("nothing encoded yet");
        return false;
    }
    bool key = false;
    return encodePlanes(m_planes[1 - m_current].data(), ptsMs, durationMs, false, out, &key, error);
}

bool VideoEncoder::encodePlanes(uchar *planes, qint64 ptsMs, qint64 durationMs, bool forceKey, QByteArray *out,
                                bool *key, QString *error)
{
    out->clear();
    *key = false;
    if (!m_codec) {
        *error = QStringLiteral("the encoder is not open");
        return false;
    }
    vpx_img_wrap(m_image, VPX_IMG_FMT_I420, static_cast<unsigned>(m_size.width()),
                 static_cast<unsigned>(m_size.height()), 1, planes);
    const vpx_enc_frame_flags_t flags = forceKey ? VPX_EFLAG_FORCE_KF : 0;
    const vpx_codec_err_t err = vpx_codec_encode(m_codec, m_image, ptsMs, static_cast<unsigned long>(qBound<qint64>(1, durationMs, 1000)),
                                                 flags, VPX_DL_REALTIME);
    if (err != VPX_CODEC_OK) {
        const char *detail = vpx_codec_error_detail(m_codec);
        *error = QStringLiteral("vp8 encode: ") + QString::fromLatin1(vpx_codec_err_to_string(err))
            + (detail ? QStringLiteral(" (") + QString::fromLatin1(detail) + QStringLiteral(")") : QString());
        return false;
    }
    vpx_codec_iter_t iter = nullptr;
    const vpx_codec_cx_pkt_t *pkt;
    while ((pkt = vpx_codec_get_cx_data(m_codec, &iter)) != nullptr) {
        if (pkt->kind == VPX_CODEC_CX_FRAME_PKT) {
            out->append(static_cast<const char *>(pkt->data.frame.buf), static_cast<int>(pkt->data.frame.sz));
            if (pkt->data.frame.flags & VPX_FRAME_IS_KEY) {
                *key = true;
            }
        }
    }
    return true;
}
