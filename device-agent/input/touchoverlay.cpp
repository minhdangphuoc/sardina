#include "touchoverlay.h"
#include "paths.h"
#include "waylandutil.h"

#include "surface-extension-client-protocol.h"

#include <QDataStream>
#include <QImage>
#include <QPainter>
#include <QSocketNotifier>
#include <QVariant>
#include <wayland-client.h>

#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

namespace {

const int OPEN_TIMEOUT_MS = 2000;
const int FADE_INTERVAL_MS = 40;
const int FADE_STEPS = 10;
const int MAX_SIDE = 10000;
const qint64 MAX_PIXELS = 16000000;

const wl_registry_listener registryListener = { TouchOverlay::onGlobal, TouchOverlay::onGlobalRemove };
const wl_shell_surface_listener shellListener = { TouchOverlay::onShellPing, TouchOverlay::onShellConfigure,
                                                  TouchOverlay::onShellPopupDone };
const wl_output_listener outputListener = { TouchOverlay::onOutputGeometry, TouchOverlay::onOutputMode };
const wl_buffer_listener bufferListener = { TouchOverlay::onBufferRelease };

}

TouchOverlay::TouchOverlay(QObject *parent)
    : QObject(parent)
    , m_display(nullptr)
    , m_registry(nullptr)
    , m_compositor(nullptr)
    , m_shm(nullptr)
    , m_output(nullptr)
    , m_shell(nullptr)
    , m_extension(nullptr)
    , m_role(nullptr)
    , m_extended(nullptr)
    , m_surface(nullptr)
    , m_transform(0)
    , m_notifier(nullptr)
    , m_data(nullptr)
    , m_dataSize(0)
    , m_alpha(0.0)
    , m_enabled(false)
    , m_pressed(false)
    , m_mapped(false)
    , m_renderPending(false)
    , m_broken(false)
{
    for (Buffer &buffer : m_buffers) {
        buffer.owner = this;
    }
    m_fade.setSingleShot(false);
    m_fade.setInterval(FADE_INTERVAL_MS);
    connect(&m_fade, &QTimer::timeout, this, &TouchOverlay::fade);
}

TouchOverlay::~TouchOverlay()
{
    m_fade.stop();
    delete m_notifier; // before the display closes its fd
    m_notifier = nullptr;
    hideSurface();
    destroyBuffers();
    if (m_extended) {
        qt_extended_surface_destroy(m_extended);
    }
    if (m_role) {
        wl_shell_surface_destroy(m_role);
    }
    if (m_surface) {
        wl_surface_destroy(m_surface);
    }
    if (m_extension) {
        qt_surface_extension_destroy(m_extension);
    }
    if (m_shell) {
        wl_shell_destroy(m_shell);
    }
    if (m_output) {
        wl_output_destroy(m_output);
    }
    if (m_shm) {
        wl_shm_destroy(m_shm);
    }
    if (m_compositor) {
        wl_compositor_destroy(m_compositor);
    }
    if (m_registry) {
        wl_registry_destroy(m_registry);
    }
    if (m_display) {
        wl_display_flush(m_display);
        wl_display_disconnect(m_display);
    }
}

void TouchOverlay::setEnabled(bool enabled)
{
    if (enabled == m_enabled) {
        return;
    }
    if (enabled && !m_display && !initialize()) {
        if (!m_error.isEmpty()) {
            fprintf(stderr, "sailfish-devagent: touch indicator unavailable: %s\n", qPrintable(m_error));
        }
        return;
    }
    m_enabled = enabled && available();
    if (!m_enabled) {
        hideSurface();
    }
}

void TouchOverlay::setScreen(const QSize &screen)
{
    if (screen.width() > 0 && screen.height() > 0 && screen.width() <= MAX_SIDE && screen.height() <= MAX_SIDE) {
        m_screen = screen;
    }
}

void TouchOverlay::setContact(const QPoint &point, bool pressed)
{
    if (!m_enabled || !available()) {
        return;
    }
    m_point = point;
    m_pressed = pressed;
    m_alpha = 1.0;
    if (pressed) {
        m_fade.stop();
    } else {
        m_fade.start();
    }
    render();
}

bool TouchOverlay::initialize()
{
    if (m_broken) {
        return false;
    }
    m_display = WaylandUtil::connectDisplay(&m_error);
    if (!m_display) {
        return false;
    }
    m_registry = wl_display_get_registry(m_display);
    wl_registry_add_listener(m_registry, &registryListener, this);
    if (!WaylandUtil::roundtrip(m_display, OPEN_TIMEOUT_MS)) {
        fail(QStringLiteral("no answer from the compositor: ") + WaylandUtil::displayError(m_display));
        return false;
    }
    if (!m_compositor || !m_shm || !m_output || !m_shell || !m_extension) {
        fail(QStringLiteral("the compositor has no wl_shell or qt_surface_extension for the touch overlay"));
        return false;
    }
    // The output's mode event follows its binding; the surface is sized from it.
    if (!WaylandUtil::roundtrip(m_display, OPEN_TIMEOUT_MS) || m_surfaceSize.isEmpty() || !m_buffers[0].handle) {
        fail(m_error.isEmpty() ? QStringLiteral("the compositor reported no output size for the touch overlay") : m_error);
        return false;
    }
    m_surface = wl_compositor_create_surface(m_compositor);
    m_role = wl_shell_get_shell_surface(m_shell, m_surface);
    wl_shell_surface_add_listener(m_role, &shellListener, this);
    wl_shell_surface_set_title(m_role, "Remote touch indicator");
    wl_shell_surface_set_toplevel(m_role);
    m_extended = qt_surface_extension_get_extended_surface(m_extension, m_surface);
    sendOverlayCategory();

    // Empty (not null) means no point is part of the input region. The marker can therefore never
    // consume a physical touch or interfere with the event stream it visualizes.
    wl_region *empty = wl_compositor_create_region(m_compositor);
    wl_surface_set_input_region(m_surface, empty);
    wl_region_destroy(empty);
    if (!WaylandUtil::roundtrip(m_display, OPEN_TIMEOUT_MS)) {
        fail(QStringLiteral("no answer from the compositor: ") + WaylandUtil::displayError(m_display));
        return false;
    }
    m_notifier = new QSocketNotifier(wl_display_get_fd(m_display), QSocketNotifier::Read, this);
    connect(m_notifier, &QSocketNotifier::activated, this, &TouchOverlay::onReadable);
    return true;
}

// Qt's own wire format for window properties (QWaylandExtendedSurface::updateGenericProperty);
// Lipstick reads the category from it before the first commit decides how the window is treated.
void TouchOverlay::sendOverlayCategory()
{
    QByteArray value;
    QDataStream stream(&value, QIODevice::WriteOnly);
    stream.setVersion(QDataStream::Qt_5_6);
    stream << QVariant(QStringLiteral("overlay"));
    wl_array array;
    wl_array_init(&array);
    void *copy = wl_array_add(&array, static_cast<size_t>(value.size()));
    std::memcpy(copy, value.constData(), static_cast<size_t>(value.size()));
    qt_extended_surface_update_generic_property(m_extended, "CATEGORY", &array);
    wl_array_release(&array);
}

bool TouchOverlay::createBuffers()
{
    const int width = m_surfaceSize.width();
    const int height = m_surfaceSize.height();
    const qint64 pixels = static_cast<qint64>(width) * height;
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || pixels > MAX_PIXELS) {
        m_error = QStringLiteral("unexpected overlay size %1x%2").arg(width).arg(height);
        return false;
    }
    const int stride = width * 4;
    const size_t one = static_cast<size_t>(stride) * static_cast<size_t>(height);
    const size_t total = one * 2;
    if (total > static_cast<size_t>(INT_MAX)) {
        m_error = QStringLiteral("touch overlay buffers are too large");
        return false;
    }
    QByteArray tmpl = (Paths::agentRuntimeDir() + QStringLiteral("/touch-overlay-XXXXXX")).toLocal8Bit();
    const int fd = mkostemp(tmpl.data(), O_CLOEXEC);
    if (fd < 0) {
        m_error = QStringLiteral("cannot create touch overlay buffers: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    unlink(tmpl.constData());
    if (ftruncate(fd, static_cast<off_t>(total)) != 0) {
        m_error = QStringLiteral("cannot size touch overlay buffers: ") + QString::fromLocal8Bit(strerror(errno));
        close(fd);
        return false;
    }
    void *data = mmap(nullptr, total, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (data == MAP_FAILED) {
        m_error = QStringLiteral("cannot map touch overlay buffers: ") + QString::fromLocal8Bit(strerror(errno));
        close(fd);
        return false;
    }
    wl_shm_pool *pool = wl_shm_create_pool(m_shm, fd, static_cast<int32_t>(total));
    m_data = static_cast<uchar *>(data);
    m_dataSize = total;
    for (int i = 0; i < 2; ++i) {
        Buffer &buffer = m_buffers[i];
        buffer.data = m_data + one * static_cast<size_t>(i);
        buffer.handle = wl_shm_pool_create_buffer(pool, static_cast<int32_t>(one * static_cast<size_t>(i)),
                                                  width, height, stride, WL_SHM_FORMAT_ARGB8888);
        wl_buffer_add_listener(buffer.handle, &bufferListener, &buffer);
        buffer.busy = false;
    }
    wl_shm_pool_destroy(pool);
    close(fd);
    return true;
}

void TouchOverlay::destroyBuffers()
{
    for (Buffer &buffer : m_buffers) {
        if (buffer.handle) {
            wl_buffer_destroy(buffer.handle);
        }
        buffer.handle = nullptr;
        buffer.data = nullptr;
        buffer.busy = false;
    }
    if (m_data) {
        munmap(m_data, m_dataSize);
    }
    m_data = nullptr;
    m_dataSize = 0;
}

QPoint TouchOverlay::surfacePoint() const
{
    if (m_screen.width() < 2 || m_screen.height() < 2) {
        return m_point;
    }
    const int x = static_cast<int>((static_cast<qint64>(m_point.x()) * (m_surfaceSize.width() - 1)
                                    + (m_screen.width() - 1) / 2) / (m_screen.width() - 1));
    const int y = static_cast<int>((static_cast<qint64>(m_point.y()) * (m_surfaceSize.height() - 1)
                                    + (m_screen.height() - 1) / 2) / (m_screen.height() - 1));
    return QPoint(x, y);
}

void TouchOverlay::render()
{
    if (!m_enabled || !m_surface || m_surfaceSize.isEmpty() || m_alpha <= 0.0) {
        return;
    }
    Buffer *target = nullptr;
    for (Buffer &buffer : m_buffers) {
        if (buffer.handle && !buffer.busy) {
            target = &buffer;
            break;
        }
    }
    if (!target) {
        m_renderPending = true;
        return;
    }
    m_renderPending = false;
    QImage image(target->data, m_surfaceSize.width(), m_surfaceSize.height(), m_surfaceSize.width() * 4,
                 QImage::Format_ARGB32_Premultiplied);
    image.fill(Qt::transparent);
    QPainter painter(&image);
    painter.setRenderHint(QPainter::Antialiasing, true);
    const int radius = qMax(12, qMin(m_surfaceSize.width(), m_surfaceSize.height()) / 36);
    const int outline = qMax(2, radius / 7);
    const QPoint center = surfacePoint();
    const int fillAlpha = qRound((m_pressed ? 145.0 : 80.0) * m_alpha);
    const int lineAlpha = qRound(230.0 * m_alpha);
    painter.setBrush(QColor(255, 70, 45, fillAlpha));
    painter.setPen(QPen(QColor(255, 255, 255, lineAlpha), outline));
    painter.drawEllipse(center, radius, radius);
    painter.end();

    target->busy = true;
    wl_surface_attach(m_surface, target->handle, 0, 0);
    wl_surface_damage(m_surface, 0, 0, m_surfaceSize.width(), m_surfaceSize.height());
    wl_surface_commit(m_surface);
    m_mapped = true;
    if (wl_display_flush(m_display) < 0 && errno != EAGAIN) {
        fail(QStringLiteral("the touch overlay compositor connection failed: ") + WaylandUtil::displayError(m_display));
    }
}

void TouchOverlay::hideSurface()
{
    m_fade.stop();
    m_alpha = 0.0;
    m_pressed = false;
    m_renderPending = false;
    if (m_surface && m_mapped) {
        wl_surface_attach(m_surface, nullptr, 0, 0);
        wl_surface_commit(m_surface);
        if (m_display) {
            wl_display_flush(m_display);
        }
    }
    m_mapped = false;
}

void TouchOverlay::fade()
{
    m_alpha -= 1.0 / FADE_STEPS;
    if (m_alpha <= 0.0) {
        hideSurface();
        return;
    }
    render();
}

void TouchOverlay::onReadable()
{
    if (m_broken) {
        return;
    }
    if (wl_display_prepare_read(m_display) == 0) {
        if (wl_display_read_events(m_display) < 0) {
            fail(QStringLiteral("the touch overlay compositor connection closed: ") + WaylandUtil::displayError(m_display));
            return;
        }
    }
    if (wl_display_dispatch_pending(m_display) < 0) {
        fail(QStringLiteral("the touch overlay compositor connection failed: ") + WaylandUtil::displayError(m_display));
        return;
    }
    wl_display_flush(m_display);
}

void TouchOverlay::fail(const QString &error)
{
    if (m_broken) {
        return;
    }
    m_error = error;
    m_broken = true;
    m_enabled = false;
    if (m_notifier) {
        m_notifier->setEnabled(false);
    }
    hideSurface();
}

void TouchOverlay::onGlobal(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version)
{
    TouchOverlay *overlay = static_cast<TouchOverlay *>(data);
    if (std::strcmp(interface, "wl_compositor") == 0 && !overlay->m_compositor) {
        overlay->m_compositor = static_cast<wl_compositor *>(
            wl_registry_bind(registry, name, &wl_compositor_interface, qMin(version, uint32_t(3))));
    } else if (std::strcmp(interface, "wl_shm") == 0 && !overlay->m_shm) {
        overlay->m_shm = static_cast<wl_shm *>(wl_registry_bind(registry, name, &wl_shm_interface, 1));
    } else if (std::strcmp(interface, "wl_output") == 0 && !overlay->m_output) {
        overlay->m_output = static_cast<wl_output *>(wl_registry_bind(registry, name, &wl_output_interface, 1));
        wl_output_add_listener(overlay->m_output, &outputListener, overlay);
    } else if (std::strcmp(interface, "wl_shell") == 0 && !overlay->m_shell) {
        overlay->m_shell = static_cast<wl_shell *>(wl_registry_bind(registry, name, &wl_shell_interface, 1));
    } else if (std::strcmp(interface, "qt_surface_extension") == 0 && !overlay->m_extension) {
        overlay->m_extension = static_cast<qt_surface_extension *>(
            wl_registry_bind(registry, name, &qt_surface_extension_interface, 1));
    }
}

void TouchOverlay::onGlobalRemove(void *, wl_registry *, uint32_t)
{
}

void TouchOverlay::onShellPing(void *, wl_shell_surface *surface, uint32_t serial)
{
    wl_shell_surface_pong(surface, serial);
}

void TouchOverlay::onShellConfigure(void *, wl_shell_surface *, uint32_t, int32_t, int32_t)
{
}

void TouchOverlay::onShellPopupDone(void *, wl_shell_surface *)
{
}

void TouchOverlay::onOutputGeometry(void *data, wl_output *, int32_t, int32_t, int32_t, int32_t, int32_t,
                                    const char *, const char *, int32_t transform)
{
    TouchOverlay *overlay = static_cast<TouchOverlay *>(data);
    overlay->m_transform = transform;
    overlay->updateOutputSize();
}

void TouchOverlay::onOutputMode(void *data, wl_output *, uint32_t flags, int32_t width, int32_t height, int32_t)
{
    if (!(flags & WL_OUTPUT_MODE_CURRENT)) {
        return;
    }
    TouchOverlay *overlay = static_cast<TouchOverlay *>(data);
    overlay->m_modeSize = QSize(width, height);
    overlay->updateOutputSize();
}

// wl_shell toplevels get no configure, so the surface takes the output's size as the compositor
// shows it: a quarter-turn transform swaps the mode's sides.
void TouchOverlay::updateOutputSize()
{
    if (m_modeSize.isEmpty()) {
        return;
    }
    const bool quarterTurn = m_transform == WL_OUTPUT_TRANSFORM_90 || m_transform == WL_OUTPUT_TRANSFORM_270
        || m_transform == WL_OUTPUT_TRANSFORM_FLIPPED_90 || m_transform == WL_OUTPUT_TRANSFORM_FLIPPED_270;
    const QSize size = quarterTurn ? m_modeSize.transposed() : m_modeSize;
    if (!resizeSurface(size)) {
        fail(m_error);
    }
}

bool TouchOverlay::resizeSurface(const QSize &size)
{
    if (size == m_surfaceSize) {
        return true;
    }
    const qreal alpha = m_alpha;
    const bool pressed = m_pressed;
    const bool fading = m_fade.isActive();
    hideSurface();
    destroyBuffers();
    m_surfaceSize = size;
    if (!createBuffers()) {
        return false;
    }
    m_alpha = alpha;
    m_pressed = pressed;
    if (fading) {
        m_fade.start();
    }
    if (m_enabled && alpha > 0.0) {
        render();
    }
    return true;
}

void TouchOverlay::onBufferRelease(void *data, wl_buffer *)
{
    Buffer *buffer = static_cast<Buffer *>(data);
    buffer->busy = false;
    if (buffer->owner->m_renderPending) {
        buffer->owner->render();
    }
}
