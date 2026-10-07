#include "indicator.h"
#include "paths.h"
#include "settings.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QStringList>
#include <QVariantList>
#include <QVariantMap>

namespace {

const int CLOSE_DELAY_MS = 10000;
const qint64 BANNER_QUIET_MS = 5 * 60 * 1000;
const int CALL_TIMEOUT_MS = 1500;
const char *const CONNECTION_NAME = "devagent-indicator";

const char *const VIEW_SUMMARY = "Screen is being viewed from VS Code";
const char *const VIEW_BODY = "Developer agent mirror is active. Turn off Developer Mode to stop it.";
const char *const INPUT_SUMMARY = "Screen is being controlled from VS Code";
const char *const INPUT_BODY = "Remote touch input is active. Turn off Developer Mode to stop it.";
// Minimal level: below lipstick's default priority (50), so the entry sorts low in Events.
const int MINIMAL_PRIORITY = 10;

// One named connection, made on first use and kept (as in capture.cpp): connecting and dropping a
// named connection for every call leaks a few KB each time in Qt, which showed as ~7 KB per mirror
// stream. Reconnects only after the bus went away.
QDBusConnection indicatorBus()
{
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), QLatin1String(CONNECTION_NAME));
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QLatin1String(CONNECTION_NAME));
    }
    return bus;
}

QDBusMessage notificationsCall(const QString &method)
{
    return QDBusMessage::createMethodCall(QStringLiteral("org.freedesktop.Notifications"),
                                          QStringLiteral("/org/freedesktop/Notifications"),
                                          QStringLiteral("org.freedesktop.Notifications"), method);
}

}

QStringList StreamIndicator::summaries()
{
    return QStringList() << QLatin1String(VIEW_SUMMARY) << QLatin1String(INPUT_SUMMARY);
}

StreamIndicator::StreamIndicator(const Settings *settings, QObject *parent)
    : QObject(parent)
    , m_settings(settings)
    , m_active(0)
    , m_inputActive(false)
    , m_showingInput(false)
    , m_notifyPending(false)
    , m_id(0)
    , m_hasStopped(false)
    , m_refreshWanted(false)
{
    m_closeTimer.setSingleShot(true);
    m_closeTimer.setInterval(CLOSE_DELAY_MS);
    connect(&m_closeTimer, &QTimer::timeout, this, &StreamIndicator::closeNotification);
}

void StreamIndicator::streamStarted()
{
    ++m_active;
    m_closeTimer.stop();
    const bool banner = !m_hasStopped || m_sinceStop.hasExpired(BANNER_QUIET_MS);
    notify(banner);
}

void StreamIndicator::streamStopped()
{
    if (m_active > 0) {
        --m_active;
    }
    if (m_active == 0) {
        m_inputActive = false;
        setShowingInput(false);
        m_hasStopped = true;
        m_sinceStop.restart();
        m_closeTimer.start();
    }
}

bool StreamIndicator::setInputActive(bool active)
{
    if (active) {
        m_inputActive = true;
        if (m_showingInput && m_id != 0) {
            return true;
        }
        if (!m_notifyPending && m_active > 0) {
            // This transition is security-significant: show a banner as well as changing the
            // persistent entry. Input remains off until the asynchronous reply succeeds.
            notify(true);
        }
        return m_showingInput && m_id != 0;
    }
    m_inputActive = false;
    if (m_showingInput) {
        setShowingInput(false);
        if (m_active > 0 && !m_notifyPending) {
            notify(false);
        }
    }
    return true;
}

void StreamIndicator::closeNow()
{
    m_closeTimer.stop();
    m_active = 0;
    m_inputActive = false;
    setShowingInput(false);
    closeNotification();
}

void StreamIndicator::refresh()
{
    if (m_active > 0) {
        notify(false); // never a banner on a level change; a pending call re-posts on its reply
    }
}

void StreamIndicator::setShowingInput(bool showing)
{
    if (m_showingInput == showing) {
        return;
    }
    m_showingInput = showing;
    emit controlChanged();
}

void StreamIndicator::notify(bool wantBanner)
{
    if (m_notifyPending) {
        m_refreshWanted = true; // the reply posts again with the hints of the current level
        return;
    }
    if (m_active == 0) {
        return;
    }
    m_refreshWanted = false;
    const bool banner = wantBanner && (!m_settings || m_settings->bannersAllowed());
    const IndicatorLevel level = m_settings ? m_settings->indicator() : IndicatorLevel::Normal;
    QDBusConnection bus = indicatorBus();
    if (bus.isConnected()) {
        // Without a banner: lipstick fills missing x-nemo-preview hints from summary and body, so
        // they are sent empty, and with low urgency, which lipstick never previews
        // (handleNotify and NotificationPreviewPresenter::notificationShouldBeShown in the lipstick
        // tree).
        QVariantMap hints;
        const bool showingInput = m_inputActive;
        const QString summary = QLatin1String(showingInput ? INPUT_SUMMARY : VIEW_SUMMARY);
        const QString body = QLatin1String(showingInput ? INPUT_BODY : VIEW_BODY);
        if (banner) {
            hints.insert(QStringLiteral("x-nemo-preview-summary"), summary);
            hints.insert(QStringLiteral("x-nemo-preview-body"), body);
        } else {
            hints.insert(QStringLiteral("x-nemo-preview-summary"), QString());
            hints.insert(QStringLiteral("x-nemo-preview-body"), QString());
            hints.insert(QStringLiteral("urgency"), QVariant::fromValue(uchar(0)));
        }
        // At every level the person at the phone cannot swipe the entry away while a session runs
        // (the agent closes it 10 s after the last stream).
        hints.insert(QStringLiteral("x-nemo-user-removable"), false);
        const bool loud = level == IndicatorLevel::Normal && (!m_settings || !m_settings->muteNotifications());
        if (!loud) {
            hints.insert(QStringLiteral("suppress-sound"), true);
        }
        if (level == IndicatorLevel::Minimal) {
            hints.insert(QStringLiteral("x-nemo-priority"), MINIMAL_PRIORITY);
            hints.insert(QStringLiteral("x-nemo-display-on"), false);
        }
        QDBusMessage msg = notificationsCall(QStringLiteral("Notify"));
        QVariantList args;
        args << QStringLiteral("sailfish-devagent") << m_id << QStringLiteral("icon-m-developer-mode")
             << summary << body << QStringList() << hints << int(0);
        msg.setArguments(args);
        m_notifyPending = true;
        QDBusPendingCallWatcher *watcher = new QDBusPendingCallWatcher(bus.asyncCall(msg, CALL_TIMEOUT_MS), this);
        connect(watcher, &QDBusPendingCallWatcher::finished, this,
                [this, watcher, banner, showingInput](QDBusPendingCallWatcher *) {
            const QDBusPendingReply<uint> reply = *watcher;
            watcher->deleteLater();
            m_notifyPending = false;
            const bool ok = !reply.isError() && reply.value() != 0;
            if (ok) {
                m_id = reply.value();
                // A late reply after the stream stopped must not resurrect controlled state.
                setShowingInput(m_active > 0 && showingInput && m_inputActive);
                if (m_showingInput) {
                    emit inputReady();
                } else if (m_active > 0 && m_inputActive != showingInput) {
                    notify(m_inputActive); // state changed while this call was pending
                    return;
                }
            }
            if (m_refreshWanted && m_active > 0) {
                notify(false); // the level changed while this call was pending
            }
        });
    }
}

void StreamIndicator::closeNotification()
{
    if (m_id == 0 || m_active > 0) {
        return;
    }
    QDBusConnection bus = indicatorBus();
    if (bus.isConnected()) {
        QDBusMessage msg = notificationsCall(QStringLiteral("CloseNotification"));
        msg.setArguments(QVariantList() << m_id);
        bus.call(msg, QDBus::Block, CALL_TIMEOUT_MS);
    }
    m_id = 0;
    setShowingInput(false);
}
