#include "stats.h"
#include "statsmath.h"

#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <cstdio>
#include <cstdlib>
#include <unistd.h>

namespace {

const qint64 READ_MAX = 16384;

std::string readProc(const QString &path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) {
        return std::string();
    }
    const QByteArray data = f.read(READ_MAX); // /proc files report size 0, so read() not readAll()
    return std::string(data.constData(), static_cast<size_t>(data.size()));
}

}

StatsStream::StatsStream(QLocalSocket *socket, const QString &exe, int intervalMs, const QString &client)
    : QObject(socket)
    , m_socket(socket)
    , m_exe(exe)
    , m_client(client)
    , m_ended(false)
    , m_pid(0)
    , m_lastWallMs(0)
    , m_lastTicks(0)
    , m_haveTicks(false)
    , m_lastBusy(0)
    , m_lastTotal(0)
    , m_haveSys(false)
{
    connect(m_socket, &QLocalSocket::disconnected, this, &StatsStream::onClientGone);
    connect(&m_timer, &QTimer::timeout, this, &StatsStream::tick);

    QJsonObject status;
    status.insert(QStringLiteral("ok"), true);
    status.insert(QStringLiteral("stream"), QStringLiteral("stats"));
    status.insert(QStringLiteral("interval"), intervalMs);
    writeLine(QJsonDocument(status).toJson(QJsonDocument::Compact));

    m_timer.setInterval(intervalMs);
    tick();
    if (!m_ended) {
        m_timer.start();
    }
}

// The lowest pid whose first argument equals the path; failing that, whose comm equals the base
// name cut to 15 characters.
int StatsStream::findPid() const
{
    const std::string exe = m_exe.toStdString();
    int byComm = 0;
    int best = 0;
    const QStringList entries = QDir(QStringLiteral("/proc")).entryList(QDir::Dirs | QDir::NoDotAndDotDot);
    for (const QString &name : entries) {
        bool ok = false;
        const int pid = name.toInt(&ok);
        if (!ok || pid <= 0) {
            continue;
        }
        const QString base = QStringLiteral("/proc/") + name;
        if (statsmath::cmdlineMatches(readProc(base + QStringLiteral("/cmdline")), exe)) {
            if (best == 0 || pid < best) {
                best = pid;
            }
        } else if (statsmath::commMatches(readProc(base + QStringLiteral("/comm")), exe)) {
            if (byComm == 0 || pid < byComm) {
                byComm = pid;
            }
        }
    }
    return best != 0 ? best : byComm;
}

void StatsStream::tick()
{
    if (m_ended || m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    const long clk = sysconf(_SC_CLK_TCK);

    // System numbers.
    QJsonObject sys;
    unsigned long long busy = 0, total = 0;
    if (statsmath::parseCpuLine(readProc(QStringLiteral("/proc/stat")), busy, total)) {
        if (m_haveSys && total >= m_lastTotal) {
            sys.insert(QStringLiteral("cpu"), statsmath::sysCpuPercent(busy - m_lastBusy, total - m_lastTotal));
        }
        m_lastBusy = busy;
        m_lastTotal = total;
        m_haveSys = true;
    }
    const std::string load = readProc(QStringLiteral("/proc/loadavg"));
    if (!load.empty()) {
        sys.insert(QStringLiteral("load1"), std::atof(load.c_str()));
    }
    const long long avail = statsmath::kbField(readProc(QStringLiteral("/proc/meminfo")), "MemAvailable");
    if (avail >= 0) {
        sys.insert(QStringLiteral("memAvailableKb"), static_cast<double>(avail));
    }

    const int pid = findPid();
    if (pid != m_pid) {
        if (m_pid != 0) {
            QJsonObject ev;
            ev.insert(QStringLiteral("event"), QStringLiteral("exit"));
            ev.insert(QStringLiteral("pid"), m_pid);
            ev.insert(QStringLiteral("ts"), static_cast<double>(now));
            writeLine(QJsonDocument(ev).toJson(QJsonDocument::Compact));
        }
        if (pid != 0) {
            QJsonObject ev;
            ev.insert(QStringLiteral("event"), QStringLiteral("start"));
            ev.insert(QStringLiteral("pid"), pid);
            ev.insert(QStringLiteral("ts"), static_cast<double>(now));
            writeLine(QJsonDocument(ev).toJson(QJsonDocument::Compact));
        }
        m_pid = pid;
        m_haveTicks = false;
    }

    QJsonObject o;
    o.insert(QStringLiteral("ts"), static_cast<double>(now));
    o.insert(QStringLiteral("pid"), pid);
    if (pid != 0) {
        const QString base = QStringLiteral("/proc/") + QString::number(pid);
        const statsmath::ProcStat st = statsmath::parseProcStat(readProc(base + QStringLiteral("/stat")));
        if (st.ok) {
            o.insert(QStringLiteral("state"), QString(QLatin1Char(st.state)));
            o.insert(QStringLiteral("threads"), static_cast<double>(st.threads));
            if (m_haveTicks && st.ticks >= m_lastTicks) {
                o.insert(QStringLiteral("cpu"),
                         statsmath::cpuPercent(st.ticks - m_lastTicks, static_cast<double>(now - m_lastWallMs), clk));
            }
            m_lastTicks = st.ticks;
            m_lastWallMs = now;
            m_haveTicks = true;
            const std::string up = readProc(QStringLiteral("/proc/uptime"));
            if (!up.empty()) {
                o.insert(QStringLiteral("started"),
                         static_cast<double>(statsmath::startedMs(st.startTicks, std::atof(up.c_str()), now, clk)));
            }
        }
        const long long rss = statsmath::kbField(readProc(base + QStringLiteral("/status")), "VmRSS");
        if (rss >= 0) {
            o.insert(QStringLiteral("rssKb"), static_cast<double>(rss));
        }
    }
    o.insert(QStringLiteral("sys"), sys);
    writeLine(QJsonDocument(o).toJson(QJsonDocument::Compact));
}

void StatsStream::writeLine(const QByteArray &json)
{
    if (m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    m_socket->write(json);
    m_socket->write("\n");
    m_socket->flush();
}

void StatsStream::onClientGone()
{
    m_timer.stop();
    markEnded();
}

void StatsStream::endWithError(const QString &reason)
{
    if (m_ended) {
        return;
    }
    m_timer.stop();
    if (m_socket->state() == QLocalSocket::ConnectedState) {
        QJsonObject o;
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), reason);
        writeLine(QJsonDocument(o).toJson(QJsonDocument::Compact));
        m_socket->disconnectFromServer();
    }
    fprintf(stderr, "sailfish-devagent: stats stream ended: %s\n", qPrintable(reason));
    markEnded();
}

void StatsStream::markEnded()
{
    if (m_ended) {
        return;
    }
    m_ended = true;
    emit ended();
}
