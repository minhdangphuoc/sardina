#ifndef MIRROR_H
#define MIRROR_H

#include <QByteArray>
#include <QObject>
#include <QString>
#include <QTimer>

class Capture;
class QLocalSocket;

// Streams the device screen to one client as JSON lines until it disconnects: a timer at `fps`
// captures a frame through Capture (lipstick), scales and JPEG-encodes it, and writes one line.
// A tick is skipped while a capture is running or the socket still has unsent bytes (back-pressure).
// Owned by the socket, like LogStream.
class MirrorStream : public QObject
{
    Q_OBJECT
public:
    MirrorStream(QLocalSocket *socket, int fps, int width, int quality);
    ~MirrorStream();

private slots:
    void tick();
    void onCaptured(const QString &error);
    void onClientGone();

private:
    void writeLine(const QByteArray &line);
    void softError(const QString &message);
    void cleanup();

    QLocalSocket *m_socket;
    int m_fps;
    int m_width;
    int m_quality;
    QTimer m_timer;
    Capture *m_capture;
    QString m_capturePath;
    qint64 m_captureTs;
    qint64 m_frame;
    qint64 m_seq;
    qint64 m_drops;
    QByteArray m_lastHash;
    bool m_slow;
    bool m_cleaned;
};

#endif
