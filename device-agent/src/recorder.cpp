#include "recorder.h"
#include "paths.h"
#include "waylandutil.h"

#include "lipstick-recorder-client-protocol.h"

#include <QSocketNotifier>
#include <wayland-client.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

namespace {

const int OPEN_TIMEOUT_MS = 2000;
const int MAX_SIDE = 10000;

// Lipstick fills the buffer with glReadPixels(GL_RGBA, GL_UNSIGNED_BYTE), i.e. bytes R, G, B, A
// (QImage::Format_RGBA8888), whatever `setup` says: lipstick 0.37 sends WL_SHM_FORMAT_RGBA8888
// (0x34324152, "RA24"), see src/compositor/lipstickrecorder.cpp in the lipstick tree. It only
// checks the buffer's size, so the buffer is created as ARGB8888, which every wl_shm supports
// (creating it with RA24 is a protocol error on the emulator). Formats with another byte order
// are refused, so a future lipstick that changes this falls back to saveScreenshot instead of
// showing wrong colours.
const int FOURCC_RGBA8888 = 0x34324152; // RA24
const int FOURCC_ABGR8888 = 0x34324241; // AB24: bytes R, G, B, A
const int FOURCC_XBGR8888 = 0x34324258; // XB24: bytes R, G, B, X

bool mapFormat(int setupFormat, QImage::Format *imageFormat)
{
    switch (setupFormat) {
    case FOURCC_RGBA8888:
    case FOURCC_ABGR8888:
    case FOURCC_XBGR8888:
        // Alpha is ignored: the screen is opaque and the JPEG has none.
        *imageFormat = QImage::Format_RGBX8888;
        return true;
    default:
        return false;
    }
}


}

const wl_registry_listener registryListener = { Recorder::onGlobal, Recorder::onGlobalRemove };
const lipstick_recorder_listener recorderListener = { Recorder::onSetup, Recorder::onFrame, Recorder::onFailed,
                                                      Recorder::onCancelled };

Recorder::Recorder(QObject *parent)
    : QObject(parent)
    , m_display(nullptr)
    , m_registry(nullptr)
    , m_shm(nullptr)
    , m_output(nullptr)
    , m_manager(nullptr)
    , m_recorder(nullptr)
    , m_buffer(nullptr)
    , m_notifier(nullptr)
    , m_data(nullptr)
    , m_dataSize(0)
    , m_width(0)
    , m_height(0)
    , m_stride(0)
    , m_format(-1)
    , m_pending(false)
    , m_broken(false)
{
}

Recorder *Recorder::open(QString *error, QObject *parent)
{
    Recorder *r = new Recorder(parent);
    r->m_display = WaylandUtil::connectDisplay(error);
    if (!r->m_display) {
        delete r;
        return nullptr;
    }
    r->m_registry = wl_display_get_registry(r->m_display);
    wl_registry_add_listener(r->m_registry, &registryListener, r);
    if (!WaylandUtil::roundtrip(r->m_display, OPEN_TIMEOUT_MS)) {
        *error = QStringLiteral("no answer from the compositor: ") + WaylandUtil::displayError(r->m_display);
        delete r;
        return nullptr;
    }
    if (!r->m_manager || !r->m_shm || !r->m_output) {
        *error = !r->m_manager ? QStringLiteral("the compositor has no lipstick_recorder_manager")
                               : QStringLiteral("the compositor has no wl_shm or wl_output");
        delete r;
        return nullptr;
    }
    r->m_recorder = lipstick_recorder_manager_create_recorder(r->m_manager, r->m_output);
    lipstick_recorder_add_listener(r->m_recorder, &recorderListener, r);
    // Also where a refused bind shows: the compositor answers it with a protocol error.
    if (!WaylandUtil::roundtrip(r->m_display, OPEN_TIMEOUT_MS) || r->m_width <= 0) {
        *error = r->m_width <= 0 && wl_display_get_error(r->m_display) == 0
            ? QStringLiteral("the recorder sent no setup")
            : QStringLiteral("the compositor refused the recorder: ") + WaylandUtil::displayError(r->m_display);
        delete r;
        return nullptr;
    }
    if (!r->createBuffer(error)) {
        delete r;
        return nullptr;
    }
    r->m_notifier = new QSocketNotifier(wl_display_get_fd(r->m_display), QSocketNotifier::Read, r);
    connect(r->m_notifier, &QSocketNotifier::activated, r, &Recorder::onReadable);
    return r;
}

Recorder::~Recorder()
{
    delete m_notifier; // before the display closes its fd
    m_notifier = nullptr;
    if (m_recorder) {
        lipstick_recorder_destroy(m_recorder);
    }
    destroyBuffer();
    if (m_manager) {
        wl_proxy_destroy(reinterpret_cast<wl_proxy *>(m_manager));
    }
    if (m_output) {
        wl_output_destroy(m_output);
    }
    if (m_shm) {
        wl_shm_destroy(m_shm);
    }
    if (m_registry) {
        wl_registry_destroy(m_registry);
    }
    if (m_display) {
        wl_display_flush(m_display);
        wl_display_disconnect(m_display);
    }
}

bool Recorder::createBuffer(QString *error)
{
    QImage::Format imageFormat;
    if (!mapFormat(m_format, &imageFormat)) {
        *error = QStringLiteral("unsupported recorder frame format 0x%1").arg(static_cast<uint>(m_format), 0, 16);
        return false;
    }
    if (m_width <= 0 || m_height <= 0 || m_width > MAX_SIDE || m_height > MAX_SIDE || m_stride < m_width * 4) {
        *error = QStringLiteral("unexpected recorder frame size %1x%2 stride %3").arg(m_width).arg(m_height).arg(m_stride);
        return false;
    }
    const size_t size = static_cast<size_t>(m_stride) * static_cast<size_t>(m_height);
    // An unlinked file in the agent's private runtime directory (tmpfs) backs the shared buffer.
    QByteArray tmpl = (Paths::agentRuntimeDir() + QStringLiteral("/recorder-XXXXXX")).toLocal8Bit();
    const int fd = mkostemp(tmpl.data(), O_CLOEXEC);
    if (fd < 0) {
        *error = QStringLiteral("cannot create the frame buffer: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    unlink(tmpl.constData());
    if (ftruncate(fd, static_cast<off_t>(size)) != 0) {
        *error = QStringLiteral("cannot size the frame buffer: ") + QString::fromLocal8Bit(strerror(errno));
        close(fd);
        return false;
    }
    void *data = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (data == MAP_FAILED) {
        *error = QStringLiteral("cannot map the frame buffer: ") + QString::fromLocal8Bit(strerror(errno));
        close(fd);
        return false;
    }
    wl_shm_pool *pool = wl_shm_create_pool(m_shm, fd, static_cast<int32_t>(size));
    m_buffer = wl_shm_pool_create_buffer(pool, 0, m_width, m_height, m_stride, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd); // the compositor holds its own copy of the fd
    m_data = static_cast<uchar *>(data);
    m_dataSize = size;
    wl_display_flush(m_display);
    return true;
}

void Recorder::destroyBuffer()
{
    if (m_buffer) {
        wl_buffer_destroy(m_buffer);
        m_buffer = nullptr;
    }
    if (m_data) {
        munmap(m_data, m_dataSize);
        m_data = nullptr;
        m_dataSize = 0;
    }
}

bool Recorder::requestFrame(bool repaint)
{
    if (m_broken || m_pending || !m_buffer) {
        return false;
    }
    m_pending = true;
    lipstick_recorder_record_frame(m_recorder, m_buffer);
    if (repaint) {
        lipstick_recorder_repaint(m_recorder);
    }
    if (wl_display_flush(m_display) < 0 && errno != EAGAIN) {
        fatal(QStringLiteral("the compositor connection failed: ") + WaylandUtil::displayError(m_display));
        return false;
    }
    return true;
}

void Recorder::repaint()
{
    if (m_broken || !m_pending) {
        return;
    }
    lipstick_recorder_repaint(m_recorder);
    wl_display_flush(m_display);
}

void Recorder::onReadable()
{
    if (m_broken) {
        return;
    }
    if (wl_display_prepare_read(m_display) == 0) {
        if (wl_display_read_events(m_display) < 0) {
            fatal(QStringLiteral("the compositor connection closed: ") + WaylandUtil::displayError(m_display));
            return;
        }
    }
    if (wl_display_dispatch_pending(m_display) < 0) {
        fatal(QStringLiteral("the compositor connection failed: ") + WaylandUtil::displayError(m_display));
        return;
    }
    wl_display_flush(m_display);
}

void Recorder::fatal(const QString &error)
{
    if (m_broken) {
        return;
    }
    m_broken = true;
    m_pending = false;
    if (m_notifier) {
        m_notifier->setEnabled(false);
    }
    emit failed(error, true);
}

void Recorder::onGlobal(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    Recorder *r = static_cast<Recorder *>(data);
    Q_UNUSED(version);
    if (std::strcmp(interface, "lipstick_recorder_manager") == 0 && !r->m_manager) {
        r->m_manager = static_cast<lipstick_recorder_manager *>(
            wl_registry_bind(registry, name, &lipstick_recorder_manager_interface, 1));
    } else if (std::strcmp(interface, "wl_shm") == 0 && !r->m_shm) {
        r->m_shm = static_cast<wl_shm *>(wl_registry_bind(registry, name, &wl_shm_interface, 1));
    } else if (std::strcmp(interface, "wl_output") == 0 && !r->m_output) {
        r->m_output = static_cast<wl_output *>(wl_registry_bind(registry, name, &wl_output_interface, 1));
    }
}

void Recorder::onGlobalRemove(void *, wl_registry *, uint32_t)
{
}

void Recorder::onSetup(void *data, lipstick_recorder *, int width, int height, int stride, int format)
{
    Recorder *r = static_cast<Recorder *>(data);
    const bool changed = width != r->m_width || height != r->m_height || stride != r->m_stride || format != r->m_format;
    r->m_width = width;
    r->m_height = height;
    r->m_stride = stride;
    r->m_format = format;
    if (!r->m_buffer || !changed) {
        return; // first setup: open() creates the buffer
    }
    // A later setup cancels pending frames (e.g. the output changed): new buffer, new request.
    r->destroyBuffer();
    r->m_pending = false;
    QString error;
    if (!r->createBuffer(&error)) {
        r->fatal(error);
        return;
    }
    emit r->failed(QStringLiteral("the screen size changed"), false);
}

void Recorder::onFrame(void *data, lipstick_recorder *, wl_buffer *buffer, uint32_t, int transform)
{
    Recorder *r = static_cast<Recorder *>(data);
    if (buffer != r->m_buffer || !r->m_pending) {
        return;
    }
    r->m_pending = false;
    QImage::Format imageFormat = QImage::Format_RGBX8888;
    mapFormat(r->m_format, &imageFormat);
    const QImage view(r->m_data, r->m_width, r->m_height, r->m_stride, imageFormat);
    emit r->frameReady(view, transform == LIPSTICK_RECORDER_TRANSFORM_Y_INVERTED);
}

void Recorder::onFailed(void *data, lipstick_recorder *, int result, wl_buffer *)
{
    Recorder *r = static_cast<Recorder *>(data);
    r->fatal(QStringLiteral("the recorder failed (result %1)").arg(result));
}

void Recorder::onCancelled(void *data, lipstick_recorder *, wl_buffer *)
{
    Recorder *r = static_cast<Recorder *>(data);
    r->m_pending = false;
    emit r->failed(QStringLiteral("the recorder cancelled the frame"), false);
}
