#ifndef AGENT_H
#define AGENT_H

#include <QObject>
#include <QLocalServer>
#include <QJsonObject>
#include <QPointer>
#include <QTimer>

class QLocalSocket;
class MirrorStream;

// The daemon: a Unix socket in the user's runtime directory, one JSON request
// per connection, a fixed set of commands. Runs as defaultuser.
class Agent : public QObject
{
    Q_OBJECT
public:
    explicit Agent(QObject *parent = nullptr);
    ~Agent();

    // Starts listening, or keeps retrying while /run/user/<uid> does not exist yet.
    void start();
    // Removes the socket and the runtime directory.
    void stop();

private slots:
    void tryListen();
    void onNewConnection();

private:
    void readRequest(QLocalSocket *socket);
    void dispatch(QLocalSocket *socket, const QJsonObject &request);
    void reply(QLocalSocket *socket, const QJsonObject &object);
    void notifyStarted();

    QLocalServer m_server;
    QTimer m_retry;
    bool m_notified;
    QPointer<MirrorStream> m_mirror;
};

#endif
