#ifndef REQUESTREADER_H
#define REQUESTREADER_H

#include <QJsonObject>
#include <QLocalServer>
#include <QObject>
#include <QString>
#include <QTimer>

class QSocketNotifier;

// Hands each accepted connection over as a raw descriptor instead of a QLocalSocket, so the
// daemon can pass it to a module process with nothing left in a Qt buffer.
class HandoffServer : public QLocalServer
{
    Q_OBJECT
public:
    explicit HandoffServer(QObject *parent = nullptr)
        : QLocalServer(parent)
    {
    }

signals:
    void connection(int fd);

protected:
    void incomingConnection(quintptr socketDescriptor) override { emit connection(static_cast<int>(socketDescriptor)); }
};

// Reads the one request line of a connection byte by byte, so whatever the client sent after it
// stays in the kernel for the module process. At most 4096 bytes and 5 s; owns the descriptor
// until takeFd().
class RequestReader : public QObject
{
    Q_OBJECT
public:
    explicit RequestReader(int fd, QObject *parent = nullptr);
    ~RequestReader();

    int fd() const { return m_fd; }
    // Gives up ownership of the descriptor (handed to a module process or closed by the caller).
    int takeFd();

    // Writes one JSON line to `fd` and closes it (a reply, an error or a refusal).
    static void replyAndClose(int fd, const QJsonObject &reply);

signals:
    void request(RequestReader *reader, const QJsonObject &request);
    // `error` is the reply to send, or empty when the client went away first.
    void failed(RequestReader *reader, const QString &error);

private slots:
    void onReadable();
    void onTimeout();

private:
    void stop();

    int m_fd;
    QSocketNotifier *m_notifier;
    QTimer m_timeout;
    QByteArray m_line;
};

#endif
