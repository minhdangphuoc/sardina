#include "logs.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QStringList>
#include <cstdio>

namespace {

// -1 = not probed yet, 0 = not supported, 1 = supported.
int outputFieldsState = -1;

const char *const OUTPUT_FIELDS =
    "MESSAGE,PRIORITY,SYSLOG_IDENTIFIER,SYSLOG_PID,_PID,_COMM,_EXE,_UID,_SYSTEMD_UNIT,_TRANSPORT,CODE_FILE,"
    "CODE_LINE,CODE_FUNC,QT_CATEGORY,COREDUMP_PID,COREDUMP_COMM,COREDUMP_SIGNAL";

}

bool LogStream::validCursor(const QString &cursor)
{
    if (cursor.isEmpty() || cursor.size() > 512) {
        return false;
    }
    for (const QChar c : cursor) {
        const ushort u = c.unicode();
        const bool ok = (u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z') || (u >= '0' && u <= '9') || u == ';'
            || u == '=' || u == ':' || u == '.' || u == '_' || u == '-';
        if (!ok) {
            return false;
        }
    }
    return true;
}

void LogStream::probeOutputFields()
{
    QProcess probe;
    probe.setProcessChannelMode(QProcess::MergedChannels);
    probe.start(QStringLiteral("journalctl"),
                QStringList() << QStringLiteral("--no-pager") << QStringLiteral("--output-fields=MESSAGE")
                              << QStringLiteral("-n") << QStringLiteral("0"),
                QIODevice::ReadOnly);
    bool ok = false;
    if (probe.waitForFinished(3000)) {
        ok = probe.exitStatus() == QProcess::NormalExit && probe.exitCode() == 0;
    } else {
        probe.kill();
        probe.waitForFinished(1000);
    }
    outputFieldsState = ok ? 1 : 0;
    fprintf(stderr, "sailfish-devagent: journalctl --output-fields %s\n", ok ? "supported" : "not supported");
}

bool LogStream::outputFieldsSupported()
{
    return outputFieldsState == 1;
}

LogStream::LogStream(QLocalSocket *socket, int lines, const QString &client, bool json, const QString &after)
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

    // Fixed argv; `lines` is a bounded integer and the cursor passed validCursor(): nothing from the
    // request reaches a shell.
    QStringList args;
    if (!json) {
        args << QStringLiteral("--no-pager") << QStringLiteral("-o") << QStringLiteral("short-precise")
             << QStringLiteral("-n") << QString::number(lines) << QStringLiteral("-f");
    } else {
        args << QStringLiteral("--no-pager") << QStringLiteral("-o") << QStringLiteral("json")
             << QStringLiteral("-f");
        if (!after.isEmpty() && validCursor(after)) {
            args << QStringLiteral("--after-cursor") << after;
        } else {
            args << QStringLiteral("-n") << QString::number(lines);
        }
        if (outputFieldsSupported()) {
            args << QStringLiteral("--output-fields=") + QLatin1String(OUTPUT_FIELDS);
        }
    }
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
