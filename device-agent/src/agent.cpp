#include "agent.h"
#include "paths.h"
#include "screenshot.h"
#include "logs.h"
#include "indicator.h"
#include "mirror.h"
#include "settings.h"
#include "settingsservice.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QPair>
#include <QDBusConnection>
#include <QDBusArgument>
#include <QDBusMessage>
#include <QVariantList>
#include <QVariantMap>
#include <QStringList>
#include <algorithm>
#include <cstdio>

namespace {

const int RETRY_MS = 2000;
const int REQUEST_MAX_BYTES = 4096;
const int REQUEST_TIMEOUT_MS = 5000;
const int LOGS_DEFAULT_LINES = 100;
const int LOGS_MAX_LINES = 10000;
const int MIRROR_DEFAULT_FPS = 4;
const int MIRROR_DEFAULT_WIDTH = 360;
const int MIRROR_DEFAULT_QUALITY = 60;
const int MIRROR_MAX_WIDTH = 2160;
const int MIRROR_MIN_WIDTH = 90;
const int MIRROR_DEFAULT_WINDOW = 2;
const int MIRROR_DEFAULT_LEASE = 60;
// VP8 video (1.6.0): up to 30 fps, a target bitrate in kbit/s, and a deeper ack window (about
// 130 ms at 30 fps), since frames are small and come often.
const int MIRROR_MAX_FPS = 10;
const int MIRROR_VIDEO_MAX_FPS = 30;
const int MIRROR_VIDEO_DEFAULT_FPS = 30;
const int MIRROR_VIDEO_DEFAULT_BITRATE = 2000;
const int MIRROR_VIDEO_MIN_BITRATE = 100;
const int MIRROR_VIDEO_MAX_BITRATE = 20000;
const int MIRROR_VIDEO_WINDOW = 4;
const int MIRROR_MIN_LEASE = 10;
const int MIRROR_MAX_LEASE = 300;

const int NOTIFY_TIMEOUT_MS = 1500;

QDBusMessage notificationsCall(const QString &method)
{
    return QDBusMessage::createMethodCall(QStringLiteral("org.freedesktop.Notifications"),
                                          QStringLiteral("/org/freedesktop/Notifications"),
                                          QStringLiteral("org.freedesktop.Notifications"), method);
}

// The "client" request field (agent 1.9.0): informational only, shown on the Settings page.
// Anything outside [A-Za-z0-9 ._-] is dropped, then the text is cut to 64 characters.
const int CLIENT_MAX_CHARS = 64;
QString clientName(const QJsonValue &value)
{
    if (!value.isString()) {
        return QString();
    }
    const QString raw = value.toString().left(4096);
    QString out;
    for (const QChar c : raw) {
        const ushort u = c.unicode();
        if ((u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z') || (u >= '0' && u <= '9') || u == ' ' || u == '.'
            || u == '_' || u == '-') {
            out += c;
        }
    }
    return out.left(CLIENT_MAX_CHARS).trimmed();
}

QJsonObject errorReply(const QString &message)
{
    QJsonObject o;
    o.insert(QStringLiteral("ok"), false);
    o.insert(QStringLiteral("error"), message);
    return o;
}

}

Agent::Agent(QObject *parent)
    : QObject(parent)
    , m_notified(false)
    , m_settings(new Settings(this))
    , m_indicator(new StreamIndicator(m_settings, this))
    , m_service(nullptr)
{
    m_settings->load();
    m_service = new SettingsService(m_settings, this, this);
    // Direct connection: a change reaches the running sessions inside the Set* call.
    connect(m_settings, &Settings::changed, this, &Agent::onSettingChanged);
    connect(m_indicator, &StreamIndicator::controlChanged, this, &Agent::onSessionChanged);
    m_retry.setInterval(RETRY_MS);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, &Agent::tryListen);
    connect(&m_server, &QLocalServer::newConnection, this, &Agent::onNewConnection);
    // chmod 0600 on the socket: only the owning user may connect.
    m_server.setSocketOptions(QLocalServer::UserAccessOption);
}

Agent::~Agent()
{
    stop();
}

void Agent::start()
{
    tryListen();
}

void Agent::tryListen()
{
    if (m_server.isListening()) {
        return;
    }
    const QString userDir = Paths::userRuntimeDir();
    if (!QDir(userDir).exists()) {
        // The user session (and its bus) is not up yet; the unit is ordered after it, but be safe.
        fprintf(stderr, "sailfish-devagent: %s does not exist yet, retrying\n", qPrintable(userDir));
        m_retry.start();
        return;
    }
    const QString dir = Paths::agentRuntimeDir();
    if (!QDir().mkpath(dir)) {
        fprintf(stderr, "sailfish-devagent: cannot create %s, retrying\n", qPrintable(dir));
        m_retry.start();
        return;
    }
    QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);

    const QString path = Paths::socketPath();
    QLocalServer::removeServer(path); // a stale socket from an unclean stop
    if (!m_server.listen(path)) {
        fprintf(stderr, "sailfish-devagent: cannot listen on %s: %s, retrying\n", qPrintable(path),
                qPrintable(m_server.errorString()));
        m_retry.start();
        return;
    }
    fprintf(stderr, "sailfish-devagent %s: listening on %s\n", AGENT_VERSION, qPrintable(path));
    closeStaleStreamEntries();
    notifyStarted();
    m_service->start();
}

void Agent::stop()
{
    m_retry.stop();
    m_service->stop();
    // Sessions that end during shutdown must not call back into a half-destroyed agent.
    if (m_mirror) {
        m_mirror->disconnect(this);
    }
    for (const QPointer<LogStream> &log : m_logs) {
        if (log) {
            log->disconnect(this);
        }
    }
    m_indicator->disconnect(this);
    m_indicator->closeNow();
    if (m_server.isListening()) {
        m_server.close();
    }
    QLocalServer::removeServer(Paths::socketPath());
    QDir dir(Paths::agentRuntimeDir());
    if (dir.exists()) {
        // Only our own files live here: the socket and screenshots not yet fetched.
        dir.removeRecursively();
    }
}

namespace {

const char *const START_SUMMARY = "Developer agent is running";
const char *const START_BODY =
    "VS Code can take screenshots, show and control the screen, and read system logs while Developer Mode is on.";

// Lipstick's GetNotifications(owner) lists entries by their x-nemo-owner hint; the agent sets
// none, so its entries are listed under "" (checked on 5.1.0.11), next to other apps' entries:
// a(sussasa{sv}i) = app, id, icon, summary, body, actions, hints, expire. Returns the ids of the
// agent's entries (id and body), sorted by id, optionally only those with `summary` (the
// mirror's indicator uses the same app name with another summary).
QList<QPair<uint, QString>> agentNotifications(QDBusConnection &bus, const QString &summary)
{
    QList<QPair<uint, QString>> ids;
    QDBusMessage list = notificationsCall(QStringLiteral("GetNotifications"));
    list.setArguments(QVariantList() << QString());
    const QDBusMessage listed = bus.call(list, QDBus::Block, NOTIFY_TIMEOUT_MS);
    if (listed.type() == QDBusMessage::ReplyMessage && !listed.arguments().isEmpty()
        && listed.arguments().first().canConvert<QDBusArgument>()) {
        const QDBusArgument arg = listed.arguments().first().value<QDBusArgument>();
        arg.beginArray();
        while (!arg.atEnd()) {
            QString app;
            uint id = 0;
            QString icon;
            QString entrySummary;
            QString entryBody;
            QStringList actions;
            QVariantMap hints;
            int expire = 0;
            arg.beginStructure();
            arg >> app >> id >> icon >> entrySummary >> entryBody >> actions >> hints >> expire;
            arg.endStructure();
            if (id != 0 && app == QLatin1String("sailfish-devagent")
                && (summary.isEmpty() || entrySummary == summary)) {
                ids << qMakePair(id, entryBody);
            }
        }
        arg.endArray();
    }
    std::sort(ids.begin(), ids.end());
    return ids;
}

void closeNotifications(QDBusConnection &bus, const QList<QPair<uint, QString>> &entries)
{
    for (const QPair<uint, QString> &entry : entries) {
        QDBusMessage close = notificationsCall(QStringLiteral("CloseNotification"));
        close.setArguments(QVariantList() << entry.first);
        bus.call(close, QDBus::Block, NOTIFY_TIMEOUT_MS);
    }
}

}

// Best effort: a visible notification on the phone while the agent runs ("Visible" in the
// security model). There is only ever one such entry, and its banner shows only when it is new:
// a start replaces the entry left by an earlier start silently (lipstick keeps notifications
// across restarts of the daemon, of lipstick and of the phone), and closes extras left by agents
// before 1.3.0, which added a new entry with a banner on every start. Uninstalling removes it
// (removeNotifications(), run from the package's %preun).
void Agent::notifyStarted(bool silent)
{
    if (m_notified) {
        return;
    }
    if (!m_settings->startNoticeAllowed()) {
        fprintf(stderr, "sailfish-devagent: start notification muted\n");
        return;
    }
    const QString connectionName = QStringLiteral("devagent-notify");
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), connectionName);
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(connectionName);
        return;
    }
    const QString summary = QLatin1String(START_SUMMARY);
    const QString body = QLatin1String(START_BODY);

    QList<QPair<uint, QString>> previous = agentNotifications(bus, summary);
    const QPair<uint, QString> kept = previous.isEmpty() ? qMakePair(0u, QString()) : previous.takeLast();
    closeNotifications(bus, previous);
    const uint replaces = kept.first;

    if (replaces != 0 && kept.second == body) {
        // The entry from an earlier start is still there and says the same: leave it alone, so a
        // restart shows nothing new.
        m_notified = true;
        fprintf(stderr, "sailfish-devagent: start notification kept (%u, closed %d older)\n", replaces,
                previous.size());
        QDBusConnection::disconnectFromBus(connectionName);
        return;
    }

    // A new entry gets a banner. Updating an old one (other text, e.g. after an upgrade) must not:
    // lipstick fills missing x-nemo-preview hints from summary and body, so they are sent empty,
    // and with low urgency, which lipstick never previews (handleNotify and
    // NotificationPreviewPresenter::notificationShouldBeShown in the lipstick tree).
    QVariantMap hints;
    if (replaces == 0 && !silent) {
        hints.insert(QStringLiteral("x-nemo-preview-summary"), summary);
        hints.insert(QStringLiteral("x-nemo-preview-body"), body);
    } else {
        hints.insert(QStringLiteral("x-nemo-preview-summary"), QString());
        hints.insert(QStringLiteral("x-nemo-preview-body"), QString());
        hints.insert(QStringLiteral("urgency"), QVariant::fromValue(uchar(0)));
    }
    QDBusMessage notify = notificationsCall(QStringLiteral("Notify"));
    notify.setArguments(QVariantList() << QStringLiteral("sailfish-devagent") << replaces
                                       << QStringLiteral("icon-m-developer-mode") << summary << body << QStringList()
                                       << hints << int(-1));
    const QDBusMessage result = bus.call(notify, QDBus::Block, NOTIFY_TIMEOUT_MS);
    m_notified = result.type() == QDBusMessage::ReplyMessage;
    fprintf(stderr, "sailfish-devagent: start notification %s (%s, closed %d older)\n",
            m_notified ? "posted" : "not posted",
            replaces ? qPrintable(QStringLiteral("updated %1 silently").arg(replaces))
                     : silent ? "new, silently" : "new, with banner",
            previous.size());
    QDBusConnection::disconnectFromBus(connectionName);
}

// "Mute agent notifications" on the phone: the start notice goes away at once.
void Agent::closeStartNotice()
{
    m_notified = false;
    const QString connectionName = QStringLiteral("devagent-notify");
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), connectionName);
    if (bus.isConnected()) {
        const QList<QPair<uint, QString>> ids = agentNotifications(bus, QLatin1String(START_SUMMARY));
        closeNotifications(bus, ids);
        fprintf(stderr, "sailfish-devagent: start notification closed (muted, %d)\n", ids.size());
    }
    QDBusConnection::disconnectFromBus(connectionName);
}

// The stream entry cannot be swiped away (agent 1.9.0), so one left by a daemon that did not stop
// cleanly (a crash, a kill) is closed when the next one starts; no stream runs at that point.
void Agent::closeStaleStreamEntries()
{
    const QString connectionName = QStringLiteral("devagent-notify");
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), connectionName);
    if (bus.isConnected()) {
        int closed = 0;
        for (const QString &summary : StreamIndicator::summaries()) {
            const QList<QPair<uint, QString>> ids = agentNotifications(bus, summary);
            closeNotifications(bus, ids);
            closed += ids.size();
        }
        if (closed > 0) {
            fprintf(stderr, "sailfish-devagent: closed %d stale stream notification(s)\n", closed);
        }
    }
    QDBusConnection::disconnectFromBus(connectionName);
}

void Agent::onSettingChanged(const QString &key)
{
    if (m_mirror) {
        m_mirror->applySetting(key); // screenView off ends it; control/touchIndicator go to its hooks
    }
    if (key == QLatin1String("logs") && !m_settings->logs()) {
        for (const QPointer<LogStream> &log : m_logs) {
            if (log) {
                log->endWithError(QStringLiteral("logs disabled on the phone"));
            }
        }
    } else if (key == QLatin1String("indicator")) {
        m_indicator->refresh();
    } else if (key == QLatin1String("muteNotifications")) {
        if (m_settings->muteNotifications()) {
            closeStartNotice();
        } else {
            notifyStarted(true);
        }
        m_indicator->refresh();
    }
    m_service->notifyChanged(key);
}

void Agent::onSessionChanged()
{
    for (int i = m_logs.size() - 1; i >= 0; --i) {
        if (!m_logs.at(i) || !m_logs.at(i)->active()) {
            m_logs.removeAt(i);
        }
    }
    m_service->notifyChanged(QStringLiteral("session"));
}

QVariantMap Agent::statusMap() const
{
    QVariantMap m = m_settings->toMap();
    m.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
    m.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
    const bool mirrorActive = m_mirror && m_mirror->active();
    m.insert(QStringLiteral("mirrorActive"), mirrorActive);
    m.insert(QStringLiteral("mirrorSince"), mirrorActive ? m_mirror->startedAt() : qint64(0));
    m.insert(QStringLiteral("mirrorControl"), mirrorActive && m_mirror->inputActive());
    m.insert(QStringLiteral("mirrorEncoding"), mirrorActive ? m_mirror->encodingName() : QString());
    m.insert(QStringLiteral("mirrorCapture"), mirrorActive ? m_mirror->captureName() : QString());
    int logStreams = 0;
    QString logClient;
    for (const QPointer<LogStream> &log : m_logs) {
        if (log && log->active()) {
            ++logStreams;
            if (!log->client().isEmpty()) {
                logClient = log->client();
            }
        }
    }
    m.insert(QStringLiteral("logStreams"), logStreams);
    m.insert(QStringLiteral("client"), mirrorActive && !m_mirrorClient.isEmpty() ? m_mirrorClient : logClient);
    return m;
}

int Agent::stopSessions()
{
    int stopped = 0;
    const QString reason = QStringLiteral("stopped from the phone");
    if (m_mirror && m_mirror->active()) {
        m_mirror->finish(reason);
        ++stopped;
    }
    const QList<QPointer<LogStream>> logs = m_logs;
    for (const QPointer<LogStream> &log : logs) {
        if (log && log->active()) {
            log->endWithError(reason);
            ++stopped;
        }
    }
    return stopped;
}

int Agent::removeNotifications()
{
    const QString connectionName = QStringLiteral("devagent-remove");
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), connectionName);
    if (!bus.isConnected()) {
        fprintf(stderr, "sailfish-devagent: session bus not available\n");
        QDBusConnection::disconnectFromBus(connectionName);
        return 1;
    }
    const QList<QPair<uint, QString>> ids = agentNotifications(bus, QString());
    closeNotifications(bus, ids);
    fprintf(stderr, "sailfish-devagent: closed %d notification(s)\n", ids.size());
    QDBusConnection::disconnectFromBus(connectionName);
    return 0;
}

void Agent::onNewConnection()
{
    while (QLocalSocket *socket = m_server.nextPendingConnection()) {
        connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
        readRequest(socket);
    }
}

// One JSON object on one line, then the reply. Anything oversized, slow or malformed is refused.
void Agent::readRequest(QLocalSocket *socket)
{
    QTimer *timeout = new QTimer(socket);
    timeout->setSingleShot(true);
    timeout->setInterval(REQUEST_TIMEOUT_MS);
    connect(timeout, &QTimer::timeout, socket, [this, socket]() {
        reply(socket, errorReply(QStringLiteral("request timeout")));
    });
    timeout->start();

    connect(socket, &QLocalSocket::readyRead, socket, [this, socket, timeout]() {
        if (!socket->canReadLine()) {
            if (socket->bytesAvailable() > REQUEST_MAX_BYTES) {
                reply(socket, errorReply(QStringLiteral("request too large")));
            }
            return;
        }
        timeout->stop();
        disconnect(socket, &QLocalSocket::readyRead, nullptr, nullptr);
        const QByteArray line = socket->readLine(REQUEST_MAX_BYTES);
        QJsonParseError parseError;
        const QJsonDocument doc = QJsonDocument::fromJson(line, &parseError);
        if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
            reply(socket, errorReply(QStringLiteral("malformed request")));
            return;
        }
        dispatch(socket, doc.object());
    });
    if (socket->canReadLine()) {
        emit socket->readyRead();
    }
}

void Agent::dispatch(QLocalSocket *socket, const QJsonObject &request)
{
    const QString cmd = request.value(QStringLiteral("cmd")).toString();

    if (cmd == QLatin1String("ping")) {
        // Answers even with Developer Mode off, so VS Code can say why the rest is refused.
        QJsonObject o;
        o.insert(QStringLiteral("ok"), true);
        o.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
        o.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
        o.insert(QStringLiteral("socket"), Paths::socketPath());
        o.insert(QStringLiteral("mirrorEncodings"), QJsonArray{ QStringLiteral("text"), QStringLiteral("binary"), QStringLiteral("vp8") });
        o.insert(QStringLiteral("mirrorInput"), QJsonArray{ QStringLiteral("tap"), QStringLiteral("swipe"), QStringLiteral("down"),
                                                                  QStringLiteral("move"), QStringLiteral("up") });
        o.insert(QStringLiteral("settingsPage"), true);
        o.insert(QStringLiteral("settings"), QJsonObject::fromVariantMap(m_settings->toMap()));
        reply(socket, o);
        return;
    }

    static const QStringList gated = { QStringLiteral("screenshot"), QStringLiteral("logs"), QStringLiteral("mirror") };
    if (!gated.contains(cmd)) {
        reply(socket, errorReply(QStringLiteral("unknown command")));
        return;
    }

    // Developer Mode gate: turning it off disables the agent without uninstalling it.
    if (!Paths::developerModeOn()) {
        reply(socket, errorReply(QStringLiteral("developer mode is off")));
        return;
    }

    // The phone's settings (agent 1.9.0), after the Developer Mode gate so its text wins.
    // "Allow screen view" covers single screenshots too.
    if (cmd != QLatin1String("logs") && !m_settings->screenView()) {
        reply(socket, errorReply(QStringLiteral("screen view disabled on the phone")));
        return;
    }
    if (cmd == QLatin1String("logs") && !m_settings->logs()) {
        reply(socket, errorReply(QStringLiteral("logs disabled on the phone")));
        return;
    }
    const QString client = clientName(request.value(QStringLiteral("client")));

    if (cmd == QLatin1String("screenshot")) {
        Screenshot *shot = new Screenshot(socket);
        connect(shot, &Screenshot::finished, socket, [this, socket](const QJsonObject &result) {
            reply(socket, result);
        });
        shot->take();
        return;
    }

    if (cmd == QLatin1String("mirror")) {
        // Anything but "binary" or "vp8" is text, like the other clamped arguments.
        const QString encodingName = request.value(QStringLiteral("encoding")).toString();
        const MirrorEncoding encoding = encodingName == QLatin1String("binary") ? MirrorEncoding::Binary
            : encodingName == QLatin1String("vp8")                              ? MirrorEncoding::Vp8
                                                                                : MirrorEncoding::Text;
        const bool video = encoding == MirrorEncoding::Vp8;
        int fps = request.value(QStringLiteral("fps")).toInt(video ? MIRROR_VIDEO_DEFAULT_FPS : MIRROR_DEFAULT_FPS);
        fps = qBound(1, fps, video ? MIRROR_VIDEO_MAX_FPS : MIRROR_MAX_FPS);
        int width = request.value(QStringLiteral("width")).toInt(MIRROR_DEFAULT_WIDTH);
        if (width <= 0) {
            width = 0; // native size
        } else {
            width = qBound(MIRROR_MIN_WIDTH, width, MIRROR_MAX_WIDTH);
        }
        const int quality = qBound(1, request.value(QStringLiteral("quality")).toInt(MIRROR_DEFAULT_QUALITY), 100);
        // The lease is always on for binary streams; text streams have it only when asked.
        int lease = 0;
        if (request.contains(QStringLiteral("lease"))) {
            lease = qBound(MIRROR_MIN_LEASE, request.value(QStringLiteral("lease")).toInt(MIRROR_DEFAULT_LEASE), MIRROR_MAX_LEASE);
        }
        if (encoding != MirrorEncoding::Text && request.value(QStringLiteral("lease")).toInt(0) <= 0) {
            lease = MIRROR_DEFAULT_LEASE;
        }
        // One mirror per daemon: the older stream is told (in its own encoding) and closed first.
        if (m_mirror) {
            m_mirror->finish(QStringLiteral("replaced"));
            delete m_mirror.data();
        }
        // Adaptive quality (1.4.0) is opt-in, so older clients get the 1.3.0 stream byte for byte.
        const bool adapt = request.value(QStringLiteral("adapt")).toBool(false);
        const int bitrate = video ? qBound(MIRROR_VIDEO_MIN_BITRATE,
                                           request.value(QStringLiteral("bitrate")).toInt(MIRROR_VIDEO_DEFAULT_BITRATE),
                                           MIRROR_VIDEO_MAX_BITRATE)
                                  : 0;
        const bool input = request.value(QStringLiteral("input")).toBool(false);
        // The "settings" message (agent 1.9.0) is opt-in, so older clients get the 1.8.1 stream.
        const bool phoneState = request.value(QStringLiteral("phoneState")).toBool(false);
        m_mirrorClient = client;
        m_mirror = new MirrorStream(socket, fps, width, quality, encoding,
                                    video ? MIRROR_VIDEO_WINDOW : MIRROR_DEFAULT_WINDOW, lease, m_indicator, adapt,
                                    bitrate, input, m_settings, phoneState);
        connect(m_mirror.data(), &MirrorStream::stateChanged, this, &Agent::onSessionChanged);
        onSessionChanged();
        return;
    }

    int lines = request.value(QStringLiteral("lines")).toInt(LOGS_DEFAULT_LINES);
    if (lines < 1) {
        lines = 1;
    }
    if (lines > LOGS_MAX_LINES) {
        lines = LOGS_MAX_LINES;
    }
    // Streams raw journal lines until the client goes away; owned by the socket.
    LogStream *log = new LogStream(socket, lines, client);
    m_logs << QPointer<LogStream>(log);
    connect(log, &LogStream::ended, this, &Agent::onSessionChanged);
    onSessionChanged();
}

void Agent::reply(QLocalSocket *socket, const QJsonObject &object)
{
    if (socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    socket->write(QJsonDocument(object).toJson(QJsonDocument::Compact));
    socket->write("\n");
    socket->flush();
    socket->disconnectFromServer();
}
