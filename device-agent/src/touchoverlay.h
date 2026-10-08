#ifndef TOUCHOVERLAY_H
#define TOUCHOVERLAY_H

#include <QObject>
#include <QPoint>
#include <QSize>
#include <QString>
#include <QTimer>

#include <cstddef>
#include <stdint.h>

struct alien_client;
struct alien_manager;
struct alien_surface;
struct wl_array;
struct wl_buffer;
struct wl_compositor;
struct wl_display;
struct wl_registry;
struct wl_shm;
struct wl_surface;
class QSocketNotifier;

// Debug-only remote-touch marker. It is a raw Wayland surface in Lipstick's "overlay" category,
// backed by two transparent wl_shm buffers. Its input region is empty, so neither remote nor
// physical touches can land on it. The owning MirrorStream is responsible for the security gate:
// setEnabled(true) only while phone setting touchIndicator, control and the focus lease are all
// active; false unmaps the surface immediately.
class TouchOverlay : public QObject
{
    Q_OBJECT
public:
    explicit TouchOverlay(QObject *parent = nullptr);
    ~TouchOverlay();

    void setEnabled(bool enabled);
    void setScreen(const QSize &screen);
    bool available() const { return m_display && !m_broken; }
    QString error() const { return m_error; }

    // Wayland listener callbacks (C function pointers); not for other callers.
    static void onGlobal(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version);
    static void onGlobalRemove(void *data, wl_registry *registry, uint32_t name);
    static void onManagerPing(void *data, alien_manager *manager, uint32_t serial);
    static void onClientOomScore(void *data, alien_client *client, int32_t score);
    static void onSurfaceConfigure(void *data, alien_surface *surface, uint32_t width, uint32_t height,
                                   wl_array *states, uint32_t serial);
    static void onSurfaceClose(void *data, alien_surface *surface);
    static void onBufferRelease(void *data, wl_buffer *buffer);

public slots:
    // Receives MirrorInput::contactChanged after coordinate validation and a successful position
    // write. Release begins a short fade; disabling the overlay bypasses the fade and unmaps it.
    void setContact(const QPoint &point, bool pressed);

private slots:
    void onReadable();
    void fade();

private:
    struct Buffer {
        TouchOverlay *owner = nullptr;
        wl_buffer *handle = nullptr;
        uchar *data = nullptr;
        bool busy = false;
    };

    bool initialize();
    bool createBuffers();
    void destroyBuffers();
    void render();
    void hideSurface();
    void fail(const QString &error);
    QPoint surfacePoint() const;

    wl_display *m_display;
    wl_registry *m_registry;
    wl_compositor *m_compositor;
    wl_shm *m_shm;
    alien_manager *m_manager;
    alien_client *m_client;
    alien_surface *m_role;
    wl_surface *m_surface;
    QSocketNotifier *m_notifier;
    Buffer m_buffers[2];
    uchar *m_data;
    size_t m_dataSize;
    QSize m_surfaceSize;
    QSize m_screen;
    QPoint m_point;
    QString m_error;
    QTimer m_fade;
    qreal m_alpha;
    bool m_enabled;
    bool m_pressed;
    bool m_mapped;
    bool m_renderPending;
    bool m_broken;
};

#endif
