#ifndef RECORDER_H
#define RECORDER_H

#include <QImage>
#include <QObject>
#include <QString>
#include <stdint.h>

struct wl_buffer;
struct wl_display;
struct wl_output;
struct wl_registry;
struct wl_shm;
struct lipstick_recorder;
struct lipstick_recorder_manager;
class QSocketNotifier;

// Native screen capture for the mirror through lipstick's private Wayland interface
// `lipstick_recorder` (protocol/lipstick-recorder.xml): one Wayland connection, one recorder and
// one shm buffer per mirror stream. The compositor copies each frame into the buffer; there is no
// file, no D-Bus call and no "Screenshot captured." notice. Binding needs the primary group
// `privileged` (the unit's Group=). Events are read on a QSocketNotifier for the display fd, so
// nothing blocks after open().
class Recorder : public QObject
{
    Q_OBJECT
public:
    // Connects to the compositor and binds the recorder, waiting at most a few seconds. Returns
    // nullptr with *error set when there is no Wayland socket, no recorder global (older lipstick),
    // the bind is refused or the frame format is unknown.
    static Recorder *open(QString *error, QObject *parent = nullptr);
    ~Recorder();

    // Asks for the next frame and, with `repaint`, for a repaint so a static screen delivers one at
    // once. Without it the frame arrives when the compositor next renders (the screen changed): the
    // VP8 stream's event-driven capture. False while a frame is pending or after a fatal error.
    bool requestFrame(bool repaint = true);
    // Asks for a repaint again (a frame is pending for long, e.g. the screen was off).
    void repaint();
    bool pending() const { return m_pending; }
    bool broken() const { return m_broken; }
    QSize size() const { return QSize(m_width, m_height); }

    // Wayland listener callbacks (C function pointers); not for other callers.
    static void onGlobal(void *data, wl_registry *registry, uint32_t name, const char *interface, uint32_t version);
    static void onGlobalRemove(void *data, wl_registry *registry, uint32_t name);
    static void onSetup(void *data, lipstick_recorder *recorder, int width, int height, int stride, int format);
    static void onFrame(void *data, lipstick_recorder *recorder, wl_buffer *buffer, uint32_t time, int transform);
    static void onFailed(void *data, lipstick_recorder *recorder, int result, wl_buffer *buffer);
    static void onCancelled(void *data, lipstick_recorder *recorder, wl_buffer *buffer);

signals:
    // `view` wraps the shared buffer without a copy and is valid only during the call. Rows are
    // stored bottom-up when yInverted is true.
    void frameReady(const QImage &view, bool yInverted);
    // fatal: the connection or the recorder is unusable; reopen or fall back.
    void failed(const QString &error, bool fatal);

private slots:
    void onReadable();

private:
    explicit Recorder(QObject *parent);
    bool createBuffer(QString *error);
    void destroyBuffer();
    void fatal(const QString &error);

    wl_display *m_display;
    wl_registry *m_registry;
    wl_shm *m_shm;
    wl_output *m_output;
    lipstick_recorder_manager *m_manager;
    lipstick_recorder *m_recorder;
    wl_buffer *m_buffer;
    QSocketNotifier *m_notifier;
    uchar *m_data;
    size_t m_dataSize;
    int m_width;
    int m_height;
    int m_stride;
    int m_format; // as sent in `setup` (a wl_shm format or a DRM fourcc)
    bool m_pending;
    bool m_broken;
};

#endif
