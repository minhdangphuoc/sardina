#ifndef MODULEHOST_H
#define MODULEHOST_H

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

class LineLink;
class QLocalSocket;

// The module side of the daemon's handoff (`<module> --serve`): fd 3 is the client's socket, fd 0
// carries control lines from the daemon and fd 1 event lines to it. The process ends when the
// daemon says so, when fd 0 closes (the daemon is gone), on SIGTERM and when its parent dies.
class ModuleHost : public QObject
{
    Q_OBJECT
public:
    // `needsSocket`: false for a module whose only peer is another module (input).
    explicit ModuleHost(const char *module, bool needsSocket = true, QObject *parent = nullptr);

    // Handles `--version` and checks `--serve` and the descriptors. Returns -1 to go on serving,
    // else the exit code.
    int init(const QStringList &args);

    // The client connection (fd 3); null without one.
    QLocalSocket *socket() const { return m_socket; }
    void sendEvent(const QJsonObject &event);
    // Tells the daemon why the stream ended, lets the socket's pending bytes go out and quits.
    void finish(const QString &reason);

signals:
    // The first control line: {"request":{...},"client":"...","settings":{...}, ...}.
    void started(const QJsonObject &control);
    void endRequested(const QString &reason);
    // Every later control line other than "end".
    void control(const QJsonObject &line);

private slots:
    void onControl(const QJsonObject &line);
    void onDaemonGone();

private:
    QString m_module;
    bool m_needsSocket;
    bool m_started;
    bool m_finished;
    LineLink *m_link;
    QLocalSocket *m_socket;
};

#endif
