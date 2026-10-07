#include "logs.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QStringList>
#include <cstdio>

LogStream::LogStream(QLocalSocket *socket, int lines, const QString &client)
    : QObject(socket)
    , m_socket(socket)
    , m_client(client)
    , m_ended(false)
    , m_atLineStart(true)
{
    m_process.setProcessChannelMode(QProcess::MergedChannels);
    connect(&m_process, &QProcess::readyReadStandardOutput, this, &LogStream::onOutput);
    connect(&m_process, static_cast<void (QProcess::*)(int, QProcess::ExitStatus)>(&QProcess::finished),
            this, &LogStream::onProcessFinished);
    connect(m_socket, &QLocalSocket::disconnected, this, &LogStream::onClientGone);

    // Fixed argv; `lines` is a bounded integer, nothing from the request reaches a shell.
    QStringList args;
    args << QStringLiteral("--no-pager") << QStringLiteral("-o") << QStringLiteral("short-precise")
         << QStringLiteral("-n") << QString::number(lines) << QStringLiteral("-f");
    m_process.start(QStringLiteral("journalctl"), args, QIODevice::ReadOnly);
}

void LogStream::onOutput()
{
    if (m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    write(m_process.readAllStandardOutput());
    m_socket->flush();
}

void LogStream::write(const QByteArray &data)
{
    if (data.isEmpty()) {
        return;
    }
    m_socket->write(data);
    m_atLineStart = data.endsWith('\n');
}

void LogStream::onClientGone()
{
    if (m_process.state() != QProcess::NotRunning) {
        m_process.kill();
        m_process.waitForFinished(1000);
    }
    markEnded();
}

void LogStream::onProcessFinished()
{
    onOutput();
    if (m_socket->state() == QLocalSocket::ConnectedState) {
        m_socket->disconnectFromServer();
    }
    markEnded();
}

void LogStream::endWithError(const QString &reason)
{
    if (m_ended) {
        return;
    }
    // No more output after the last line: the process's signals are dropped before it is killed.
    m_process.disconnect(this);
    if (m_process.state() != QProcess::NotRunning) {
        m_process.kill();
        m_process.waitForFinished(1000);
    }
    if (m_socket->state() == QLocalSocket::ConnectedState) {
        write(m_process.readAllStandardOutput());
        if (!m_atLineStart) {
            m_socket->write("\n"); // the last line stands on its own
        }
        QJsonObject o;
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), reason);
        m_socket->write(QJsonDocument(o).toJson(QJsonDocument::Compact));
        m_socket->write("\n");
        m_socket->flush();
        m_socket->disconnectFromServer();
    }
    fprintf(stderr, "sailfish-devagent: log stream ended: %s\n", qPrintable(reason));
    markEnded();
}

void LogStream::markEnded()
{
    if (m_ended) {
        return;
    }
    m_ended = true;
    emit ended();
}
