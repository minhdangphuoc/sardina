#include "touchoverlay.h"
#include "paths.h"
#include "waylandutil.h"

#include "alien-manager-client-protocol.h"

#include <QImage>
#include <QPainter>
#include <QSocketNotifier>
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
const alien_manager_listener managerListener = { TouchOverlay::onManagerPing };
const alien_client_listener clientListener = { TouchOverlay::onClientOomScore };
const alien_surface_listener surfaceListener = { TouchOverlay::onSurfaceConfigure, TouchOverlay::onSurfaceClose };
const wl_buffer_listener bufferListener = { TouchOverlay::onBufferRelease };

}

TouchOverlay::TouchOverlay(QObject *parent)
    : QObject(parent)
    , m_display(nullptr)
    , m_registry(nullptr)
    , m_compositor(nullptr)
    , m_shm(nullptr)
    , m_manager(nullptr)
    , m_client(nullptr)
    , m_role(nullptr)
    , m_surface(nullptr)
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
    if (m_role) {
        alien_surface_destroy(m_role);
    }
    if (m_surface) {
        wl_surface_destroy(m_surface);
    }
    if (m_client) {
        alien_client_destroy(m_client);
    }
    if (m_manager) {
        alien_manager_destroy(m_manager);
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
    if (!m_compositor || !m_shm || !m_manager) {
        fail(!m_manager ? QStringLiteral("the compositor has no alien_manager v2")
                        : QStringLiteral("the compositor has no wl_compositor or wl_shm"));
        return false;
    }
    m_surface = wl_compositor_create_surface(m_compositor);
    m_client = alien_manager_create_alien_client(m_manager, "sailfish-devagent");
    alien_manager_add_listener(m_manager, &managerListener, this);
    alien_client_add_listener(m_client, &clientListener, this);
    m_role = alien_client_get_alien_surface(m_client, m_surface);
    alien_surface_add_listener(m_role, &surfaceListener, this);
    alien_surface_set_title(m_role, "Remote touch indicator");
    alien_surface_set_category(m_role, "overlay");

    // Empty (not null) means no point is part of the input region. The marker can therefore never
    // consume a physical touch or interfere with the event stream it visualizes.
    wl_region *empty = wl_compositor_create_region(m_compositor);
    wl_surface_set_input_region(m_surface, empty);
    wl_region_destroy(empty);
    wl_surface_commit(m_surface);
    if (!WaylandUtil::roundtrip(m_display, OPEN_TIMEOUT_MS) || m_surfaceSize.isEmpty() || !m_buffers[0].handle) {
        fail(m_error.isEmpty() ? QStringLiteral("the compositor did not configure the touch overlay") : m_error);
        return false;
    }
    m_notifier = new QSocketNotifier(wl_display_get_fd(m_display), QSocketNotifier::Read, this);
    connect(m_notifier, &QSocketNotifier::activated, this, &TouchOverlay::onReadable);
    return true;
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
    } else if (std::strcmp(interface, "alien_manager") == 0 && version >= 2 && !overlay->m_manager) {
        overlay->m_manager = static_cast<alien_manager *>(wl_registry_bind(registry, name, &alien_manager_interface, 2));
    }
}

void TouchOverlay::onGlobalRemove(void *, wl_registry *, uint32_t)
{
}

void TouchOverlay::onManagerPing(void *, alien_manager *manager, uint32_t serial)
{
    alien_manager_pong(manager, serial);
}

void TouchOverlay::onClientOomScore(void *, alien_client *, int32_t)
{
}

void TouchOverlay::onSurfaceConfigure(void *data, alien_surface *surface, uint32_t width, uint32_t height,
                                      wl_array *, uint32_t serial)
{
    TouchOverlay *overlay = static_cast<TouchOverlay *>(data);
    alien_surface_ack_configure(surface, serial);
    const QSize size(static_cast<int>(width), static_cast<int>(height));
    if (size == overlay->m_surfaceSize) {
        return;
    }
    overlay->hideSurface();
    overlay->destroyBuffers();
    overlay->m_surfaceSize = size;
    if (!overlay->createBuffers()) {
        overlay->fail(overlay->m_error);
    } else if (overlay->m_enabled && overlay->m_alpha > 0.0) {
        overlay->render();
    }
}

void TouchOverlay::onSurfaceClose(void *data, alien_surface *)
{
    static_cast<TouchOverlay *>(data)->fail(QStringLiteral("the compositor closed the touch overlay"));
}

void TouchOverlay::onBufferRelease(void *data, wl_buffer *)
{
    Buffer *buffer = static_cast<Buffer *>(data);
    buffer->busy = false;
    if (buffer->owner->m_renderPending) {
        buffer->owner->render();
    }
}
