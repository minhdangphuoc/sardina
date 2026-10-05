#include "logs.h"

#include <QLocalSocket>
#include <QStringList>

LogStream::LogStream(QLocalSocket *socket, int lines)
    : QObject(socket)
    , m_socket(socket)
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
    m_socket->write(m_process.readAllStandardOutput());
    m_socket->flush();
}

void LogStream::onClientGone()
{
    if (m_process.state() != QProcess::NotRunning) {
        m_process.kill();
        m_process.waitForFinished(1000);
    }
}

void LogStream::onProcessFinished()
{
    onOutput();
    if (m_socket->state() == QLocalSocket::ConnectedState) {
        m_socket->disconnectFromServer();
    }
}
