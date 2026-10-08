#include "client.h"
#include "firstline.h"
#include "paths.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QSocketNotifier>
#include <cstdio>
#include <cstring>
#include <unistd.h>

namespace {

const int CONNECT_TIMEOUT_MS = 3000;
const int UPSTREAM_LINE_MAX = 256;

void printNotRunning()
{
    printf("{\"ok\":false,\"error\":\"agent not running\"}\n");
    fflush(stdout);
}

bool writeOut(const QByteArray &data)
{
    size_t off = 0;
    while (off < static_cast<size_t>(data.size())) {
        const size_t n = fwrite(data.constData() + off, 1, data.size() - off, stdout);
        if (n == 0) {
            return false;
        }
        off += n;
    }
    return fflush(stdout) == 0;
}

}

int Client::run(const QStringList &args)
{
    if (args.isEmpty()) {
        return 2;
    }
    const QString cmd = args.at(0);
    if (cmd != QLatin1String("ping") && cmd != QLatin1String("screenshot") && cmd != QLatin1String("logs")
        && cmd != QLatin1String("mirror") && cmd != QLatin1String("stats")) {
        fprintf(stderr, "sailfish-devagent: unknown request \"%s\"\n", qPrintable(cmd));
        return 2;
    }
    QJsonObject request;
    request.insert(QStringLiteral("cmd"), cmd);
    for (int i = 1; i < args.size();) {
        const QString opt = args.at(i);
        if (cmd == QLatin1String("mirror") && opt == QLatin1String("--input")) {
            request.insert(QStringLiteral("input"), true);
            ++i;
            continue;
        }
        if (cmd == QLatin1String("mirror") && opt == QLatin1String("--phone-state")) {
            request.insert(QStringLiteral("phoneState"), true);
            ++i;
            continue;
        }
        if (i + 1 >= args.size()) {
            return 2;
        }
        if (cmd == QLatin1String("logs") && opt == QLatin1String("--format")) {
            const QString format = args.at(i + 1);
            if (format != QLatin1String("json") && format != QLatin1String("text")) {
                return 2;
            }
            if (format == QLatin1String("json")) {
                request.insert(QStringLiteral("format"), format);
            }
            i += 2;
            continue;
        }
        if (cmd == QLatin1String("logs") && opt == QLatin1String("--after")) {
            request.insert(QStringLiteral("after"), args.at(i + 1).left(1024));
            i += 2;
            continue;
        }
        if (cmd == QLatin1String("stats") && opt == QLatin1String("--exe")) {
            request.insert(QStringLiteral("exe"), args.at(i + 1).left(1024));
            i += 2;
            continue;
        }
        if (cmd == QLatin1String("stats") && opt == QLatin1String("--interval")) {
            bool ok = false;
            const int value = args.at(i + 1).toInt(&ok);
            if (!ok) {
                return 2;
            }
            request.insert(QStringLiteral("interval"), qBound(250, value, 10000));
            i += 2;
            continue;
        }
        if ((cmd == QLatin1String("mirror") || cmd == QLatin1String("logs") || cmd == QLatin1String("stats"))
            && opt == QLatin1String("--client")) {
            // Informational; the daemon strips and cuts it (agent 1.9.0).
            request.insert(QStringLiteral("client"), args.at(i + 1).left(256));
            i += 2;
            continue;
        }
        const bool isLines = opt == QLatin1String("--lines");
        const bool isMirrorOpt = opt == QLatin1String("--fps") || opt == QLatin1String("--width")
            || opt == QLatin1String("--quality")
            || opt == QLatin1String("--lease");
        if (isLines || (cmd == QLatin1String("mirror") && isMirrorOpt)) {
            bool ok = false;
            const int value = args.at(i + 1).toInt(&ok);
            if (!ok) {
                return 2;
            }
            request.insert(opt.mid(2), value);
        } else {
            return 2;
        }
        i += 2;
    }

    QLocalSocket socket;
    socket.connectToServer(Paths::socketPath());
    if (!socket.waitForConnected(CONNECT_TIMEOUT_MS)) {
        printNotRunning();
        return 3;
    }
    socket.write(QJsonDocument(request).toJson(QJsonDocument::Compact));
    socket.write("\n");
    socket.flush();

    int exitCode = 0;
    const bool streaming = cmd == QLatin1String("logs") || cmd == QLatin1String("mirror") || cmd == QLatin1String("stats");
    FirstLine firstLine;
    bool judged = false;
    // Only the first line is the status. A log stream starts with journal text instead; only a
    // refusal ("logs disabled on the phone", Developer Mode off) is a JSON object with "ok":false.
    const auto judgeFirstLine = [&]() {
        if (judged) {
            return;
        }
        judged = true;
        const QJsonDocument doc = QJsonDocument::fromJson(
            QByteArray(firstLine.line().data(), static_cast<int>(firstLine.line().size())));
        const QJsonValue ok = doc.isObject() ? doc.object().value(QStringLiteral("ok")) : QJsonValue();
        if (cmd == QLatin1String("logs") ? ok == QJsonValue(false) : !ok.toBool(false)) {
            exitCode = 1;
        }
    };

    QObject::connect(&socket, &QLocalSocket::readyRead, &socket, [&]() {
        const QByteArray data = socket.readAll();
        if (!judged && firstLine.feed(data.constData(), static_cast<size_t>(data.size()))) {
            judgeFirstLine();
        }
        if (!writeOut(data)) {
            // stdout is gone (ssh closed): drop the connection so the daemon stops streaming.
            exitCode = 1;
            socket.abort();
            QCoreApplication::quit();
        }
    });
    QObject::connect(&socket, &QLocalSocket::disconnected, &socket, []() { QCoreApplication::quit(); });

    // For a stream, EOF on stdin means the remote side (VS Code's sfdk) went away. In mirror mode
    // complete stdin lines (keepalives) of at most 256 bytes are forwarded to the daemon; a longer
    // line is dropped up to its newline. For logs the bytes are still discarded.
    const bool forwardLines = cmd == QLatin1String("mirror");
    QByteArray pending;
    bool discarding = false;
    QSocketNotifier stdinNotifier(STDIN_FILENO, QSocketNotifier::Read);
    stdinNotifier.setEnabled(streaming);
    QObject::connect(&stdinNotifier, &QSocketNotifier::activated, &socket, [&](int) {
        char buf[1024];
        const ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
        if (n <= 0) {
            stdinNotifier.setEnabled(false);
            socket.abort();
            QCoreApplication::quit();
            return;
        }
        if (!forwardLines) {
            return;
        }
        ssize_t pos = 0;
        while (pos < n) {
            const char *nl = static_cast<const char *>(memchr(buf + pos, '\n', n - pos));
            const ssize_t seg = nl ? nl - (buf + pos) : n - pos;
            if (!discarding) {
                pending.append(buf + pos, static_cast<int>(seg));
                if (pending.size() > UPSTREAM_LINE_MAX) {
                    discarding = true;
                    pending.clear();
                }
            }
            if (!nl) {
                break;
            }
            pos += seg + 1;
            if (!discarding && !pending.isEmpty()) {
                socket.write(pending);
                socket.write("\n");
                socket.flush();
            }
            discarding = false;
            pending.clear();
        }
    });

    if (socket.state() == QLocalSocket::ConnectedState) {
        QCoreApplication::exec();
    }
    // Whatever arrived before the disconnect is already written; nothing buffered remains. A reply
    // that ended without a newline is judged on what arrived.
    judgeFirstLine();
    return exitCode;
}
