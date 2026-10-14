#include "debugmonitor.h"
#include "modulehost.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QRegularExpression>
#include <QSet>
#include <dirent.h>
#include <algorithm>
#include <unistd.h>

namespace {

QByteArray readSmall(const QString &path, qint64 limit)
{
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.read(limit) : QByteArray();
}

QSet<QByteArray> listeners(int port, bool loopbackOnly)
{
    QSet<QByteArray> inodes;
    const QByteArray wanted = QByteArray::number(port, 16).toUpper().rightJustified(4, '0');
    for (const QString &path : { QStringLiteral("/proc/net/tcp"), QStringLiteral("/proc/net/tcp6") }) {
        for (const QByteArray &line : readSmall(path, 256 * 1024).split('\n')) {
            const QList<QByteArray> fields = line.simplified().split(' ');
            if (fields.size() < 10 || fields.at(3) != "0A") continue;
            const QList<QByteArray> endpoint = fields.at(1).split(':');
            if (endpoint.size() != 2 || endpoint.at(1).toUpper() != wanted) continue;
            const QByteArray address = endpoint.at(0).toUpper();
            if (loopbackOnly && address != "0100007F" && address != "00000000000000000000000001000000") continue;
            inodes.insert(fields.at(9));
        }
    }
    return inodes;
}

bool ownsSocket(const QString &pid, const QSet<QByteArray> &inodes)
{
    if (inodes.isEmpty()) return false;
    const QByteArray folder = QFile::encodeName(QStringLiteral("/proc/") + pid + QStringLiteral("/fd"));
    DIR *dir = opendir(folder.constData());
    if (!dir) return false;
    bool owned = false;
    // procfs fd entries are symlinks to pseudo-targets such as socket:[inode].
    // Enumerate them directly: Qt's file-type filtering may discard those non-files.
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
        if (link.startsWith("socket:[") && link.endsWith(']') && inodes.contains(link.mid(8, link.size() - 9))) {
            owned = true;
            break;
        }
    }
    closedir(dir);
    return owned;
}

}

DebugMonitor::DebugMonitor(ModuleHost *host, const QString &exe, const QString &mode, int port)
    : QObject(host), m_host(host), m_exe(exe), m_mode(mode), m_port(port)
{
    m_poll.setInterval(500);
    connect(&m_poll, &QTimer::timeout, this, &DebugMonitor::poll);
}

void DebugMonitor::start()
{
    QLocalSocket *socket = m_host->socket();
    socket->write("{\"ok\":true,\"stream\":\"debugmonitor\",\"event\":\"ready\"}\n");
    socket->flush();
    poll();
    m_poll.start();
}

void DebugMonitor::confirmOwner(const QJsonObject &value)
{
    if (value.value(QStringLiteral("event")) != QLatin1String("socket-owner")) return;
    const int pid = value.value(QStringLiteral("pid")).toInt();
    const QByteArray inode = value.value(QStringLiteral("inode")).toString().toLatin1();
    if (pid <= 0 || inode.isEmpty() || inode.size() > 20) return;
    for (const char digit : inode) if (digit < '0' || digit > '9') return;
    m_confirmedPid = pid;
    m_confirmedInode = inode;
    m_confirmationAge.restart();
    poll();
}

void DebugMonitor::poll()
{
    const QSet<QByteArray> inodes = listeners(m_port, m_mode == QLatin1String("qml"));
    int appPid = 0;
    int serverPid = 0;
    bool qmlArgument = false;
    bool listening = false;
    const QByteArray exe = m_exe.toUtf8();
    const QByteArray base = QFileInfo(m_exe).fileName().toUtf8();
    const QRegularExpression qmlPort(QStringLiteral("(?:^|,)port:%1(?:,|$)").arg(m_port));
    for (const QString &pid : QDir(QStringLiteral("/proc")).entryList(QDir::Dirs | QDir::NoDotAndDotDot)) {
        bool numeric = false;
        const int number = pid.toInt(&numeric);
        if (!numeric || number <= 0) continue;
        const QList<QByteArray> args = readSmall(QStringLiteral("/proc/") + pid + QStringLiteral("/cmdline"), 4096).split('\0');
        if (args.isEmpty()) continue;
        if (args.at(0) == exe || args.at(0) == base) {
            bool enabled = false;
            for (const QByteArray &arg : args) {
                if (arg.startsWith("-qmljsdebugger=") && qmlPort.match(QString::fromUtf8(arg.mid(15))).hasMatch()) enabled = true;
            }
            if (appPid == 0 || enabled) appPid = number;
            qmlArgument = qmlArgument || enabled;
            if (m_mode == QLatin1String("qml") && enabled) serverPid = number;
        }
        if (m_mode == QLatin1String("cpp") && QFileInfo(QString::fromUtf8(args.at(0))).fileName() == QLatin1String("gdbserver")) {
            const QByteArray suffix = ':' + QByteArray::number(m_port);
            bool matchesPort = false;
            for (const QByteArray &arg : args) if (arg.endsWith(suffix)) matchesPort = true;
            if (matchesPort) {
                serverPid = number;
            }
        }
    }
    const int candidatePid = m_mode == QLatin1String("qml") ? (qmlArgument ? appPid : 0) : serverPid;
    const bool clientConfirmed = candidatePid > 0 && m_confirmedPid == candidatePid
        && m_confirmationAge.isValid() && m_confirmationAge.elapsed() <= 1500
        && inodes.contains(m_confirmedInode);
    if (candidatePid > 0) {
        listening = clientConfirmed || ownsSocket(QString::number(candidatePid), inodes);
        if (m_mode == QLatin1String("qml") && !listening) serverPid = 0;
    }
    QString state = QStringLiteral("waiting");
    if (listening) state = QStringLiteral("server-listening");
    else if (appPid > 0) state = m_mode == QLatin1String("qml") && !qmlArgument
        ? QStringLiteral("missing-qml-argument")
        : m_mode == QLatin1String("qml") && !inodes.isEmpty()
            ? QStringLiteral("port-listening-unowned") : QStringLiteral("app-running");
    else if (serverPid > 0) state = inodes.isEmpty() ? QStringLiteral("server-starting") : QStringLiteral("port-listening-unowned");
    else if (m_seenApp) state = QStringLiteral("app-exited");
    else if (m_seenServer) state = QStringLiteral("server-exited");
    m_seenApp = m_seenApp || appPid > 0;
    m_seenServer = m_seenServer || serverPid > 0;
    // Only state changes are sent. Keepalive renewal is handled independently by the lease.
    QList<QByteArray> sortedInodes = inodes.values();
    std::sort(sortedInodes.begin(), sortedInodes.end());
    QJsonArray listenerInodes;
    for (const QByteArray &inode : sortedInodes) listenerInodes.append(QString::fromLatin1(inode));
    const QString key = state + QString::number(appPid) + QLatin1Char(':') + QString::number(serverPid)
        + QLatin1Char(':') + QString::fromLatin1(sortedInodes.join(','));
    if (key == m_lastState) return;
    m_lastState = key;
    const QJsonObject event{ { QStringLiteral("event"), QStringLiteral("status") }, { QStringLiteral("mode"), m_mode },
        { QStringLiteral("state"), state }, { QStringLiteral("pid"), appPid }, { QStringLiteral("serverPid"), serverPid },
        { QStringLiteral("qmlArgument"), qmlArgument }, { QStringLiteral("listening"), listening }, { QStringLiteral("port"), m_port },
        { QStringLiteral("listenerInodes"), listenerInodes } };
    m_host->socket()->write(QJsonDocument(event).toJson(QJsonDocument::Compact) + '\n');
    m_host->socket()->flush();
}
