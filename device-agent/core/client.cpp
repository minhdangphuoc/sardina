#include "client.h"
#include "firstline.h"
#include "paths.h"

#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QSocketNotifier>
#include <QTimer>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <unistd.h>

namespace {

const int CONNECT_TIMEOUT_MS = 3000;
const int UPSTREAM_LINE_MAX = 256;
// Log and stats streams ask for a keepalive lease and renew it while this client runs and its
// stdout drains; a client stuck on a stalled SSH link stops renewing and the stream ends. Agents
// before 1.11.0 ignore both.
const int STREAM_LEASE_S = 30;
const int KEEPALIVE_MS = 10000;
// A write to stdout blocked this long means the SSH link is gone: SIGALRM ends the client.
const unsigned STDOUT_STALL_S = 60;

void printNotRunning()
{
    printf("{\"ok\":false,\"error\":\"agent not running\"}\n");
    fflush(stdout);
}

bool writeOut(const QByteArray &data)
{
    alarm(STDOUT_STALL_S);
    struct AlarmOff {
        ~AlarmOff() { alarm(0); }
    } alarmOff;
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

// This CLI runs under the authenticated SSH login's primary group, unlike the daemon's
// privileged primary group. procfs permits it to read the app's fd links and attest the
// exact listener inode without changing the daemon's screenshot credentials.
QByteArray ownedInode(int pid, const QList<QByteArray> &inodes)
{
    if (pid <= 0 || inodes.isEmpty()) return QByteArray();
    const QByteArray folder = QByteArrayLiteral("/proc/") + QByteArray::number(pid) + QByteArrayLiteral("/fd");
    DIR *dir = opendir(folder.constData());
    if (!dir) return QByteArray();
    QByteArray match;
    for (struct dirent *entry = readdir(dir); entry; entry = readdir(dir)) {
        const char *fd = entry->d_name;
        if (!*fd) continue;
        bool numeric = true;
        for (const char *digit = fd; *digit; ++digit) {
            if (*digit < '0' || *digit > '9') { numeric = false; break; }
        }
        if (!numeric) continue;
        const QByteArray name = folder + '/' + fd;
        char target[256];
        const ssize_t length = readlink(name.constData(), target, sizeof target);
        if (length <= 0) continue;
        const QByteArray link(target, static_cast<int>(length));
        if (!link.startsWith("socket:[") || !link.endsWith(']')) continue;
        const QByteArray inode = link.mid(8, link.size() - 9);
        if (inodes.contains(inode)) { match = inode; break; }
    }
    closedir(dir);
    return match;
}

}

int Client::run(const QStringList &args)
{
    if (args.isEmpty()) {
        return 2;
    }
    const QString cmd = args.at(0);
    if (cmd != QLatin1String("ping") && cmd != QLatin1String("screenshot") && cmd != QLatin1String("logs")
        && cmd != QLatin1String("mirror") && cmd != QLatin1String("stats") && cmd != QLatin1String("packages")
        && cmd != QLatin1String("debugmonitor")) {
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
        if ((cmd == QLatin1String("stats") || cmd == QLatin1String("debugmonitor")) && opt == QLatin1String("--exe")) {
            request.insert(QStringLiteral("exe"), args.at(i + 1).left(1024));
            i += 2;
            continue;
        }
        if (cmd == QLatin1String("debugmonitor") && opt == QLatin1String("--mode")) {
            request.insert(QStringLiteral("mode"), args.at(i + 1));
            i += 2;
            continue;
        }
        if (cmd == QLatin1String("debugmonitor") && opt == QLatin1String("--port")) {
            bool valid = false;
            const int port = args.at(i + 1).toInt(&valid);
            if (!valid || port < 1024 || port > 65535) return 2;
            request.insert(QStringLiteral("port"), port);
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
        if (cmd == QLatin1String("packages") && opt == QLatin1String("--package")) {
            QJsonArray packages = request.value(QStringLiteral("packages")).toArray();
            packages.append(args.at(i + 1).left(128));
            request.insert(QStringLiteral("packages"), packages);
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

    const bool leased = cmd == QLatin1String("logs") || cmd == QLatin1String("stats") || cmd == QLatin1String("packages")
        || cmd == QLatin1String("debugmonitor");
    if (leased) {
        request.insert(QStringLiteral("lease"), STREAM_LEASE_S);
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
    const bool streaming = cmd == QLatin1String("logs") || cmd == QLatin1String("mirror") || cmd == QLatin1String("stats")
        || cmd == QLatin1String("packages") || cmd == QLatin1String("debugmonitor");
    FirstLine firstLine;
    bool judged = false;
    QByteArray pendingEvents;
    int debugCandidatePid = 0;
    QList<QByteArray> debugInodes;
    QTimer verifyTimer;
    if (cmd == QLatin1String("debugmonitor")) {
        QObject::connect(&verifyTimer, &QTimer::timeout, &socket, [&]() {
            const QByteArray inode = ownedInode(debugCandidatePid, debugInodes);
            if (inode.isEmpty()) return;
            const QJsonObject proof{ { QStringLiteral("event"), QStringLiteral("socket-owner") },
                { QStringLiteral("pid"), debugCandidatePid }, { QStringLiteral("inode"), QString::fromLatin1(inode) } };
            socket.write(QJsonDocument(proof).toJson(QJsonDocument::Compact) + '\n');
            socket.flush();
        });
        verifyTimer.start(500);
    }
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
        if (cmd == QLatin1String("debugmonitor")) {
            pendingEvents += data;
            if (pendingEvents.size() > 8192) pendingEvents.clear();
            int newline = pendingEvents.indexOf('\n');
            while (newline >= 0) {
                const QJsonDocument event = QJsonDocument::fromJson(pendingEvents.left(newline));
                pendingEvents.remove(0, newline + 1);
                if (event.isObject() && event.object().value(QStringLiteral("event")) == QLatin1String("status")) {
                    const QJsonObject status = event.object();
                    const bool qml = request.value(QStringLiteral("mode")) == QLatin1String("qml");
                    debugCandidatePid = status.value(qml ? QStringLiteral("pid") : QStringLiteral("serverPid")).toInt();
                    debugInodes.clear();
                    const QJsonArray values = status.value(QStringLiteral("listenerInodes")).toArray();
                    for (const QJsonValue &value : values) {
                        const QByteArray inode = value.toString().toLatin1();
                        if (inode.isEmpty() || inode.size() > 20 || debugInodes.size() >= 32) continue;
                        bool numeric = true;
                        for (const char digit : inode) if (digit < '0' || digit > '9') numeric = false;
                        if (numeric) debugInodes.append(inode);
                    }
                }
                newline = pendingEvents.indexOf('\n');
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

    QTimer keepalive;
    qint64 keepalives = 0;
    QObject::connect(&keepalive, &QTimer::timeout, &socket, [&]() {
        socket.write("{\"keepalive\":" + QByteArray::number(++keepalives) + "}\n");
        socket.flush();
    });
    if (leased) {
        keepalive.start(KEEPALIVE_MS);
    }

    if (socket.state() == QLocalSocket::ConnectedState) {
        QCoreApplication::exec();
    }
    // Whatever arrived before the disconnect is already written; nothing buffered remains. A reply
    // that ended without a newline is judged on what arrived.
    judgeFirstLine();
    return exitCode;
}
