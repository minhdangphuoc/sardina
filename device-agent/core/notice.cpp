#include "notice.h"
#include "indicator.h"
#include "modules.h"
#include "paths.h"
#include "settings.h"

#include <QDBusArgument>
#include <QDBusConnection>
#include <QDBusMessage>
#include <QFile>
#include <QPair>
#include <QStringList>
#include <QVariantList>
#include <QVariantMap>
#include <algorithm>
#include <cstdio>

namespace {

const int NOTIFY_TIMEOUT_MS = 1500;

QDBusMessage notificationsCall(const QString &method)
{
    return QDBusMessage::createMethodCall(QStringLiteral("org.freedesktop.Notifications"),
                                          QStringLiteral("/org/freedesktop/Notifications"),
                                          QStringLiteral("org.freedesktop.Notifications"), method);
}

}

StartNotice::StartNotice(const Settings *settings)
    : m_settings(settings)
    , m_notified(false)
{
}

namespace {

const char *const START_SUMMARY = "Developer agent is running";

// Says only what the installed modules can do, so the owner is never told of a power that is not there.
QString startBody()
{
    const QStringList installed = Modules::installedNames();
    QStringList can;
    if (installed.contains(QStringLiteral("screenshot"))) {
        can << QStringLiteral("take screenshots");
    }
    if (installed.contains(QStringLiteral("mirror"))) {
        can << (installed.contains(QStringLiteral("input")) ? QStringLiteral("show and control the screen")
                                                            : QStringLiteral("show the screen"));
    }
    if (installed.contains(QStringLiteral("logs"))) {
        can << QStringLiteral("read system logs");
    }
    if (installed.contains(QStringLiteral("stats"))) {
        can << QStringLiteral("read app CPU and memory");
    }
    if (can.isEmpty()) {
        return QStringLiteral("No feature is installed yet.");
    }
    const QString last = can.takeLast();
    const QString list = can.isEmpty() ? last : can.join(QStringLiteral(", ")) + QStringLiteral(", and ") + last;
    return QStringLiteral("VS Code can ") + list + QStringLiteral(" while Developer Mode is on.");
}

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

namespace {

void markNoticeShown()
{
    if (QFile::exists(Paths::noticeShownPath())) {
        return;
    }
    QFile marker(Paths::noticeShownPath());
    if (marker.open(QIODevice::WriteOnly)) {
        marker.close();
    }
}

}

// Best effort: a visible notification on the phone while the agent runs ("Visible" in the
// security model). There is only ever one such entry. Its banner shows once per installation (the
// first notice writes Paths::noticeShownPath()); the daemon closes the entry when it stops (1.10.1),
// so later starts post it again silently. An entry left by a daemon that did not stop cleanly is
// kept when it says the same, else replaced silently, and extras left by agents before 1.3.0 are
// closed. Uninstalling removes any that remain (removeAll(), run from %preun).
void StartNotice::post(bool silent)
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
    const QString body = startBody();

    QList<QPair<uint, QString>> previous = agentNotifications(bus, summary);
    const QPair<uint, QString> kept = previous.isEmpty() ? qMakePair(0u, QString()) : previous.takeLast();
    closeNotifications(bus, previous);
    const uint replaces = kept.first;

    if (replaces != 0 && kept.second == body) {
        // The entry from an earlier start is still there and says the same: leave it alone, so a
        // restart shows nothing new.
        m_notified = true;
        markNoticeShown(); // an entry from before 1.10.1 counts as shown
        fprintf(stderr, "sailfish-devagent: start notification kept (%u, closed %d older)\n", replaces,
                previous.size());
        QDBusConnection::disconnectFromBus(connectionName);
        return;
    }

    // A new entry gets a banner. Updating an old one (other text, e.g. after an upgrade) must not:
    // lipstick fills missing x-nemo-preview hints from summary and body, so they are sent empty,
    // and with low urgency, which lipstick never previews (handleNotify and
    // NotificationPreviewPresenter::notificationShouldBeShown in the lipstick tree).
    // The banner is shown once per installation; later starts (the daemon closes the notice when it
    // stops) post the entry silently.
    const bool bannerShownBefore = QFile::exists(Paths::noticeShownPath());
    const bool banner = replaces == 0 && !silent && !bannerShownBefore;
    QVariantMap hints;
    if (banner) {
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
    if (m_notified) {
        markNoticeShown();
    }
    fprintf(stderr, "sailfish-devagent: start notification %s (%s, closed %d older)\n",
            m_notified ? "posted" : "not posted",
            replaces ? qPrintable(QStringLiteral("updated %1 silently").arg(replaces))
                     : banner ? "new, with banner" : "new, silently",
            previous.size());
    QDBusConnection::disconnectFromBus(connectionName);
}

// "Mute agent notifications" on the phone: the start notice goes away at once.
void StartNotice::close()
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
void StartNotice::closeStaleStreamEntries()
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

int StartNotice::removeAll()
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

