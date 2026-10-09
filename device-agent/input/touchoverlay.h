#ifndef TOUCHOVERLAY_H
#define TOUCHOVERLAY_H

#include <QObject>
#include <QPoint>
#include <QSize>
#include <QString>
#include <QTimer>

#include <cstddef>
#include <stdint.h>

struct qt_extended_surface;
struct qt_surface_extension;
struct wl_buffer;
struct wl_compositor;
struct wl_display;
struct wl_output;
struct wl_registry;
struct wl_shell;
struct wl_shell_surface;
struct wl_shm;
struct wl_surface;
class QSocketNotifier;

// Debug-only remote-touch marker. It is a wl_shell toplevel that tags itself with Qt's CATEGORY
// property "overlay", which Lipstick reads from qt_extended_surface, backed by two transparent
// wl_shm buffers. Its input region is empty, so neither remote nor
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
    bool showingOnPhone() const { return m_enabled && available(); }
    QString error() const { return m_error; }

    // Wayland listener callbacks (C function pointers); not for other callers.
    static void onGlobal(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version);
    static void onGlobalRemove(void *data, wl_registry *registry, uint32_t name);
    static void onShellPing(void *data, wl_shell_surface *surface, uint32_t serial);
    static void onShellConfigure(void *data, wl_shell_surface *surface, uint32_t edges, int32_t width, int32_t height);
    static void onShellPopupDone(void *data, wl_shell_surface *surface);
    static void onOutputGeometry(void *data, wl_output *output, int32_t x, int32_t y, int32_t physicalWidth,
                                 int32_t physicalHeight, int32_t subpixel, const char *make, const char *model,
                                 int32_t transform);
    static void onOutputMode(void *data, wl_output *output, uint32_t flags, int32_t width, int32_t height,
                             int32_t refresh);
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
    void sendOverlayCategory();
    bool resizeSurface(const QSize &size);
    void updateOutputSize();
    void destroyBuffers();
    void render();
    void hideSurface();
    void fail(const QString &error);
    QPoint surfacePoint() const;

    wl_display *m_display;
    wl_registry *m_registry;
    wl_compositor *m_compositor;
    wl_shm *m_shm;
    wl_output *m_output;
    wl_shell *m_shell;
    qt_surface_extension *m_extension;
    wl_shell_surface *m_role;
    qt_extended_surface *m_extended;
    wl_surface *m_surface;
    QSize m_modeSize;
    int32_t m_transform;
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
