#include "client.h"
#include "paths.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QSocketNotifier>
#include <cstdio>
#include <unistd.h>

namespace {

const int CONNECT_TIMEOUT_MS = 3000;

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
        && cmd != QLatin1String("mirror")) {
        fprintf(stderr, "sailfish-devagent: unknown request \"%s\"\n", qPrintable(cmd));
        return 2;
    }
    QJsonObject request;
    request.insert(QStringLiteral("cmd"), cmd);
    for (int i = 1; i + 1 < args.size(); i += 2) {
        const QString opt = args.at(i);
        const bool isLines = opt == QLatin1String("--lines");
        const bool isMirrorOpt = opt == QLatin1String("--fps") || opt == QLatin1String("--width")
            || opt == QLatin1String("--quality");
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
    bool firstChunk = true;
    const bool streaming = cmd == QLatin1String("logs") || cmd == QLatin1String("mirror");
    const bool checkFirstLine = cmd != QLatin1String("logs");

    QObject::connect(&socket, &QLocalSocket::readyRead, &socket, [&]() {
        const QByteArray data = socket.readAll();
        if (firstChunk && checkFirstLine) {
            firstChunk = false;
            // A stream's first chunk may hold more than one line; only the first is the status.
            const int eol = data.indexOf('\n');
            const QJsonDocument doc = QJsonDocument::fromJson(eol >= 0 ? data.left(eol) : data);
            if (!doc.isObject() || !doc.object().value(QStringLiteral("ok")).toBool(false)) {
                exitCode = 1;
            }
        }
        if (!writeOut(data)) {
            // stdout is gone (ssh closed): drop the connection so the daemon stops streaming.
            exitCode = 1;
            socket.abort();
            QCoreApplication::quit();
        }
    });
    QObject::connect(&socket, &QLocalSocket::disconnected, &socket, []() { QCoreApplication::quit(); });

    // For a stream, EOF on stdin means the remote side (VS Code's sfdk) went away.
    QSocketNotifier stdinNotifier(STDIN_FILENO, QSocketNotifier::Read);
    stdinNotifier.setEnabled(streaming);
    QObject::connect(&stdinNotifier, &QSocketNotifier::activated, &socket, [&](int) {
        char buf[256];
        const ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
        if (n <= 0) {
            stdinNotifier.setEnabled(false);
            socket.abort();
            QCoreApplication::quit();
        }
    });

    if (socket.state() == QLocalSocket::ConnectedState) {
        QCoreApplication::exec();
    }
    // Whatever arrived before the disconnect is already written; nothing buffered remains.
    return exitCode;
}
