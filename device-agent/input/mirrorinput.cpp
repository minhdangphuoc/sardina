#include "mirrorinput.h"

#include <QDir>
#include <QFile>
#include <QFileInfoList>
#include <QVector>

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <linux/input.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <unistd.h>

namespace {

const int SWIPE_INTERVAL_MS = 16; // about 60 position reports per second

template <size_t N> bool bit(const unsigned long (&bits)[N], int n)
{
    const int perWord = static_cast<int>(sizeof(unsigned long) * CHAR_BIT);
    return n >= 0 && n / perWord < static_cast<int>(N) && (bits[n / perWord] & (1UL << (n % perWord)));
}

input_event inputEvent(unsigned short type, unsigned short code, int value)
{
    input_event e;
    std::memset(&e, 0, sizeof(e));
    gettimeofday(&e.time, nullptr);
    e.type = type;
    e.code = code;
    e.value = value;
    return e;
}

bool integerWrite(int fd, const QVector<input_event> &events)
{
    const char *data = reinterpret_cast<const char *>(events.constData());
    size_t left = static_cast<size_t>(events.size()) * sizeof(input_event);
    while (left > 0) {
        const ssize_t n = ::write(fd, data, left);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return false;
        }
        data += n;
        left -= static_cast<size_t>(n);
    }
    return true;
}

struct Candidate {
    int fd = -1;
    int score = 0;
    QString path;
    QString name;
    bool multi = false;
    bool slot = false;
    bool absX = false;
    bool absY = false;
    bool btnTouch = false;
    int xCode = ABS_X;
    int yCode = ABS_Y;
    input_absinfo x = {};
    input_absinfo y = {};
    input_absinfo legacyX = {};
    input_absinfo legacyY = {};
    input_absinfo slotRange = {};
};

struct KeySpec {
    const char *name;
    int code;
};

const KeySpec KEYPAD_KEYS[] = {
    { "0", KEY_0 }, { "1", KEY_1 }, { "2", KEY_2 }, { "3", KEY_3 }, { "4", KEY_4 }, { "5", KEY_5 },
    { "6", KEY_6 }, { "7", KEY_7 }, { "8", KEY_8 }, { "9", KEY_9 }, { "*", KEY_NUMERIC_STAR },
    { "#", KEY_NUMERIC_POUND }, { "OK", KEY_ENTER }, { "UP", KEY_UP }, { "DOWN", KEY_DOWN },
    { "LEFT", KEY_LEFT }, { "RIGHT", KEY_RIGHT }, { "MENU", KEY_MENU }, { "BACK", KEY_BACK },
    { "CALL", KEY_PHONE }, { "F21", KEY_F21 }, { "F22", KEY_F22 }, { "F23", KEY_F23 },
};

int keypadCode(const QString &name)
{
    for (const KeySpec &key : KEYPAD_KEYS) {
        if (name == QLatin1String(key.name)) {
            return key.code;
        }
    }
    return -1;
}

struct KeypadCandidate {
    int fd = -1;
    int score = 0;
    QString path;
    QString name;
    QStringList keys;
    QSet<int> codes;
};

KeypadCandidate findKeypad()
{
    KeypadCandidate best;
    const QFileInfoList entries = QDir(QStringLiteral("/dev/input"))
                                      .entryInfoList(QStringList() << QStringLiteral("event*"), QDir::System | QDir::Files,
                                                     QDir::Name);
    for (const QFileInfo &entry : entries) {
        const QByteArray path = entry.absoluteFilePath().toLocal8Bit();
        const int fd = open(path.constData(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) {
            continue;
        }
        unsigned long evBits[(EV_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                             / (sizeof(unsigned long) * CHAR_BIT)] = {};
        unsigned long keyBits[(KEY_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                              / (sizeof(unsigned long) * CHAR_BIT)] = {};
        if (ioctl(fd, EVIOCGBIT(0, sizeof(evBits)), evBits) < 0 || !bit(evBits, EV_KEY)
            || ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keyBits)), keyBits) < 0
            || !bit(keyBits, KEY_NUMERIC_STAR) || !bit(keyBits, KEY_PHONE)) {
            close(fd);
            continue;
        }
        KeypadCandidate candidate;
        candidate.fd = fd;
        candidate.path = entry.absoluteFilePath();
        char rawName[256] = {};
        ioctl(fd, EVIOCGNAME(sizeof(rawName) - 1), rawName);
        candidate.name = QString::fromLocal8Bit(rawName);
        for (const KeySpec &key : KEYPAD_KEYS) {
            if (bit(keyBits, key.code)) {
                candidate.keys.append(QLatin1String(key.name));
                candidate.codes.insert(key.code);
            }
        }
        candidate.score = candidate.keys.size();
        if (candidate.name.contains(QStringLiteral("kpd"), Qt::CaseInsensitive)
            || candidate.name.contains(QStringLiteral("key"), Qt::CaseInsensitive)) {
            candidate.score += 10;
        }
        if (candidate.score <= best.score) {
            close(fd);
            continue;
        }
        if (best.fd >= 0) {
            close(best.fd);
        }
        best = candidate;
    }
    return best;
}

QString hardwareModel()
{
    QFile file(QStringLiteral("/etc/hw-release"));
    if (!file.open(QIODevice::ReadOnly)) {
        return QString();
    }
    while (!file.atEnd()) {
        const QByteArray line = file.readLine().trimmed();
        if (!line.startsWith("NAME=")) {
            continue;
        }
        QString value = QString::fromUtf8(line.mid(5)).trimmed();
        if (value.size() >= 2 && ((value.startsWith(QLatin1Char('"')) && value.endsWith(QLatin1Char('"')))
                                  || (value.startsWith(QLatin1Char('\'')) && value.endsWith(QLatin1Char('\''))))) {
            value = value.mid(1, value.size() - 2);
        }
        return value.left(128);
    }
    return QString();
}

}

MirrorInput::MirrorInput(QObject *parent)
    : QObject(parent)
    , m_fd(-1)
    , m_keyFd(-1)
    , m_nativeCoordinates(false)
    , m_multi(false)
    , m_slot(false)
    , m_absX(false)
    , m_absY(false)
    , m_btnTouch(false)
    , m_xCode(ABS_X)
    , m_yCode(ABS_Y)
    , m_xMin(0)
    , m_xMax(0)
    , m_yMin(0)
    , m_yMax(0)
    , m_absXMin(0)
    , m_absXMax(0)
    , m_absYMin(0)
    , m_absYMax(0)
    , m_slotMin(0)
    , m_slotMax(-1)
    , m_selectedSlot(-1)
    , m_trackingId(1)
    , m_down(false)
    , m_liveContact(false)
    , m_keyCode(-1)
    , m_durationMs(0)
    , m_step(0)
    , m_steps(0)
{
    m_timer.setSingleShot(true);
    connect(&m_timer, &QTimer::timeout, this, &MirrorInput::advance);
    openTouchscreen();
    openKeypad();
    if (available()) {
        m_error.clear();
    } else {
        m_error = QStringLiteral("no writable touchscreen or keypad input device");
    }
}

MirrorInput::~MirrorInput()
{
    cancel();
    if (m_fd >= 0) {
        close(m_fd);
    }
    if (m_keyFd >= 0) {
        close(m_keyFd);
    }
}

MirrorKeypadInfo MirrorInput::keypadInfo()
{
    KeypadCandidate keypad = findKeypad();
    MirrorKeypadInfo info;
    if (keypad.fd >= 0) {
        close(keypad.fd);
        info.model = hardwareModel();
        info.keys = keypad.keys;
    }
    return info;
}

bool MirrorInput::validKeyName(const QString &key)
{
    return keypadCode(key) >= 0;
}

bool MirrorInput::openTouchscreen()
{
    Candidate best;
    const QFileInfoList entries = QDir(QStringLiteral("/dev/input"))
                                      .entryInfoList(QStringList() << QStringLiteral("event*"), QDir::System | QDir::Files,
                                                     QDir::Name);
    for (const QFileInfo &entry : entries) {
        const QByteArray path = entry.absoluteFilePath().toLocal8Bit();
        const int fd = open(path.constData(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) {
            continue;
        }
        unsigned long evBits[(EV_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                             / (sizeof(unsigned long) * CHAR_BIT)] = {};
        unsigned long absBits[(ABS_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                              / (sizeof(unsigned long) * CHAR_BIT)] = {};
        unsigned long keyBits[(KEY_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                              / (sizeof(unsigned long) * CHAR_BIT)] = {};
        unsigned long propBits[(INPUT_PROP_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                               / (sizeof(unsigned long) * CHAR_BIT)] = {};
        if (ioctl(fd, EVIOCGBIT(0, sizeof(evBits)), evBits) < 0 || !bit(evBits, EV_ABS)
            || ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(absBits)), absBits) < 0) {
            close(fd);
            continue;
        }
        const bool multi = bit(absBits, ABS_MT_POSITION_X) && bit(absBits, ABS_MT_POSITION_Y)
            && bit(absBits, ABS_MT_TRACKING_ID);
        const bool single = bit(absBits, ABS_X) && bit(absBits, ABS_Y);
        if (!multi && !single) {
            close(fd);
            continue;
        }
        const int xCode = multi ? ABS_MT_POSITION_X : ABS_X;
        const int yCode = multi ? ABS_MT_POSITION_Y : ABS_Y;
        input_absinfo x;
        input_absinfo y;
        std::memset(&x, 0, sizeof(x));
        std::memset(&y, 0, sizeof(y));
        if (ioctl(fd, EVIOCGABS(xCode), &x) < 0 || ioctl(fd, EVIOCGABS(yCode), &y) < 0
            || x.maximum <= x.minimum || y.maximum <= y.minimum) {
            close(fd);
            continue;
        }
        if (bit(evBits, EV_KEY)) {
            ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keyBits)), keyBits);
        }
        ioctl(fd, EVIOCGPROP(sizeof(propBits)), propBits);
        char rawName[256] = {};
        ioctl(fd, EVIOCGNAME(sizeof(rawName) - 1), rawName);
        const QString name = QString::fromLocal8Bit(rawName);
        const bool direct = bit(propBits, INPUT_PROP_DIRECT);
        const bool touchButton = bit(keyBits, BTN_TOUCH);
        // Do not mistake an accelerometer, joystick or absolute mouse for the touchscreen. Modern
        // phones expose MT coordinates and INPUT_PROP_DIRECT; BTN_TOUCH covers older single-touch
        // devices. A missing/ambiguous device is safer than sending a gesture to the wrong node.
        if ((!multi && !touchButton) || (!direct && !touchButton)) {
            close(fd);
            continue;
        }
        int score = multi ? 100 : 40;
        if (direct) {
            score += 100;
        }
        if (touchButton) {
            score += 20;
        }
        if (name.contains(QStringLiteral("touch"), Qt::CaseInsensitive)
            || name.contains(QStringLiteral("ts"), Qt::CaseInsensitive)) {
            score += 20;
        }
        if (score <= best.score) {
            close(fd);
            continue;
        }
        if (best.fd >= 0) {
            close(best.fd);
        }
        best.fd = fd;
        best.score = score;
        best.path = entry.absoluteFilePath();
        best.name = name;
        best.multi = multi;
        best.slot = multi && bit(absBits, ABS_MT_SLOT);
        best.absX = bit(absBits, ABS_X);
        best.absY = bit(absBits, ABS_Y);
        best.btnTouch = touchButton;
        best.xCode = xCode;
        best.yCode = yCode;
        best.x = x;
        best.y = y;
        if (best.absX) {
            ioctl(fd, EVIOCGABS(ABS_X), &best.legacyX);
        }
        if (best.absY) {
            ioctl(fd, EVIOCGABS(ABS_Y), &best.legacyY);
        }
        if (best.slot) {
            ioctl(fd, EVIOCGABS(ABS_MT_SLOT), &best.slotRange);
        }
    }
    if (best.fd < 0) {
        m_error = QStringLiteral("no writable touchscreen input device");
        return false;
    }
    m_fd = best.fd;
    m_device = best.path;
    m_multi = best.multi;
    m_slot = best.slot;
    m_absX = best.absX;
    m_absY = best.absY;
    m_btnTouch = best.btnTouch;
    m_xCode = best.xCode;
    m_yCode = best.yCode;
    m_xMin = best.x.minimum;
    m_xMax = best.x.maximum;
    m_yMin = best.y.minimum;
    m_yMax = best.y.maximum;
    m_absXMin = best.legacyX.minimum;
    m_absXMax = best.legacyX.maximum;
    m_absYMin = best.legacyY.minimum;
    m_absYMax = best.legacyY.maximum;
    m_slotMin = best.slot ? best.slotRange.minimum : 0;
    m_slotMax = best.slot ? best.slotRange.maximum : -1;
    fprintf(stderr, "sailfish-devagent: mirror input: %s (%s), axes %d..%d x %d..%d\n",
            qPrintable(m_device), qPrintable(best.name), m_xMin, m_xMax, m_yMin, m_yMax);
    return true;
}

bool MirrorInput::openKeypad()
{
    const KeypadCandidate keypad = findKeypad();
    if (keypad.fd < 0) {
        return false;
    }
    m_keyFd = keypad.fd;
    m_keyCodes = keypad.codes;
    fprintf(stderr, "sailfish-devagent: mirror keypad: %s (%s), %d keys\n", qPrintable(keypad.path),
            qPrintable(keypad.name), keypad.keys.size());
    return true;
}

int MirrorInput::scaleAxis(int value, int screenMax, int axisMin, int axisMax) const
{
    if (screenMax <= 0) {
        return axisMin;
    }
    return axisMin + static_cast<int>((static_cast<qint64>(value) * (axisMax - axisMin) + screenMax / 2) / screenMax);
}

QPoint MirrorInput::mapToPanel(const QPoint &point, bool *ok) const
{
    *ok = false;
    if (!touchAvailable() || !m_nativeCoordinates || m_screen.width() < 1 || m_screen.height() < 1
        || point.x() < 0 || point.y() < 0
        || point.x() >= m_screen.width() || point.y() >= m_screen.height()) {
        return QPoint();
    }
    // Recorder pixels and touchscreen axes are both fixed panel coordinates. If their aspect
    // directions disagree, the device has an axis transform we cannot infer safely; refuse rather
    // than send a gesture to a swapped axis.
    const bool axesPortrait = (m_xMax - m_xMin) <= (m_yMax - m_yMin);
    if (axesPortrait != (m_screen.width() <= m_screen.height())) {
        return QPoint();
    }
    *ok = true;
    return point;
}

bool MirrorInput::writePosition(const QPoint &point, bool down, bool up)
{
    if (up) {
        return releaseContact();
    }
    bool ok = false;
    const QPoint panel = mapToPanel(point, &ok);
    if (!ok) {
        m_error = m_nativeCoordinates ? QStringLiteral("touchscreen axis transform is not known")
                                     : QStringLiteral("screenshot rotation is not available for input");
        return false;
    }
    const QPoint p(scaleAxis(panel.x(), m_screen.width() - 1, m_xMin, m_xMax),
                   scaleAxis(panel.y(), m_screen.height() - 1, m_yMin, m_yMax));
    QVector<input_event> events;
    events.reserve(12);
    if (m_multi) {
        if (m_slot) {
            events << inputEvent(EV_ABS, ABS_MT_SLOT, m_selectedSlot);
        }
        if (down) {
            events << inputEvent(EV_ABS, ABS_MT_TRACKING_ID, m_trackingId++);
        }
        events << inputEvent(EV_ABS, ABS_MT_POSITION_X, p.x())
               << inputEvent(EV_ABS, ABS_MT_POSITION_Y, p.y());
    }
    if (!m_multi && m_absX && m_absY) {
        const int legacyX = scaleAxis(panel.x(), m_screen.width() - 1, m_absXMin, m_absXMax);
        const int legacyY = scaleAxis(panel.y(), m_screen.height() - 1, m_absYMin, m_absYMax);
        events << inputEvent(EV_ABS, ABS_X, legacyX) << inputEvent(EV_ABS, ABS_Y, legacyY);
    }
    if (!m_multi && m_btnTouch && down) {
        events << inputEvent(EV_KEY, BTN_TOUCH, 1);
    }
    if (m_multi && !m_slot) {
        events << inputEvent(EV_SYN, SYN_MT_REPORT, 0);
    }
    events << inputEvent(EV_SYN, SYN_REPORT, 0);
    if (!integerWrite(m_fd, events)) {
        m_error = QStringLiteral("touchscreen write failed: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    m_lastPoint = panel;
    emit contactChanged(panel, true);
    return true;
}

bool MirrorInput::physicalTouchDown() const
{
    unsigned long keys[(KEY_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                       / (sizeof(unsigned long) * CHAR_BIT)] = {};
    return m_btnTouch && ioctl(m_fd, EVIOCGKEY(sizeof(keys)), keys) >= 0 && bit(keys, BTN_TOUCH);
}

bool MirrorInput::physicalKeyDown(int code) const
{
    unsigned long keys[(KEY_CNT + sizeof(unsigned long) * CHAR_BIT - 1)
                       / (sizeof(unsigned long) * CHAR_BIT)] = {};
    return m_keyFd >= 0 && ioctl(m_keyFd, EVIOCGKEY(sizeof(keys)), keys) >= 0 && bit(keys, code);
}

bool MirrorInput::chooseSlot()
{
    m_selectedSlot = -1;
    if (!m_slot) {
        return !physicalTouchDown();
    }
    const int count = m_slotMax - m_slotMin + 1;
    if (count < 1 || count > 128) {
        return false;
    }
    QVector<int> values(count + 1, -1);
    values[0] = ABS_MT_TRACKING_ID;
    if (ioctl(m_fd, EVIOCGMTSLOTS(values.size() * static_cast<int>(sizeof(int))), values.data()) < 0) {
        return false;
    }
    for (int i = 0; i < count; ++i) {
        if (values.at(i + 1) < 0) {
            m_selectedSlot = m_slotMin + i;
            return true;
        }
    }
    return false; // all contacts belong to real fingers or another injector
}

bool MirrorInput::releaseContact()
{
    QVector<input_event> events;
    events.reserve(6);
    if (m_multi) {
        if (m_slot && m_selectedSlot >= m_slotMin && m_selectedSlot <= m_slotMax) {
            events << inputEvent(EV_ABS, ABS_MT_SLOT, m_selectedSlot);
        }
        events << inputEvent(EV_ABS, ABS_MT_TRACKING_ID, -1);
    }
    if (!m_multi && m_btnTouch) {
        events << inputEvent(EV_KEY, BTN_TOUCH, 0);
    }
    if (m_multi && !m_slot) {
        events << inputEvent(EV_SYN, SYN_MT_REPORT, 0);
    }
    events << inputEvent(EV_SYN, SYN_REPORT, 0);
    m_selectedSlot = -1;
    const bool written = integerWrite(m_fd, events);
    emit contactChanged(m_lastPoint, false);
    if (!written) {
        m_error = QStringLiteral("touchscreen release failed: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    return true;
}

bool MirrorInput::begin(const QPoint &point, bool live)
{
    if (m_down || !chooseSlot() || !writePosition(point, true, false)) {
        m_selectedSlot = -1;
        return false;
    }
    m_down = true;
    m_liveContact = live;
    return true;
}

bool MirrorInput::move(const QPoint &point)
{
    return m_down && writePosition(point, false, false);
}

bool MirrorInput::end()
{
    if (!m_down) {
        return true;
    }
    // Release never depends on the last coordinate or current screen size. A rotation/resize or
    // mapping failure during a swipe must not leave BTN_TOUCH/tracking id held down.
    const bool ok = releaseContact();
    m_down = false;
    m_liveContact = false;
    return ok;
}

bool MirrorInput::tap(const QPoint &point)
{
    if (m_down) {
        return false;
    }
    m_from = point;
    m_to = point;
    m_durationMs = 40;
    m_step = 0;
    m_steps = 1;
    if (!begin(point, false)) {
        return false;
    }
    m_timer.start(m_durationMs);
    return true;
}

bool MirrorInput::contactDown(const QPoint &point)
{
    m_timer.stop();
    return begin(point, true);
}

bool MirrorInput::contactMove(const QPoint &point)
{
    return liveContact() && move(point);
}

bool MirrorInput::contactUp()
{
    if (!liveContact()) {
        return true;
    }
    m_timer.stop();
    return end();
}

bool MirrorInput::keyDown(const QString &key)
{
    const int code = keypadCode(key);
    if (m_keyFd < 0 || m_keyCode >= 0 || code < 0 || !m_keyCodes.contains(code) || physicalKeyDown(code)) {
        return false;
    }
    QVector<input_event> events;
    events << inputEvent(EV_KEY, static_cast<unsigned short>(code), 1) << inputEvent(EV_SYN, SYN_REPORT, 0);
    if (!integerWrite(m_keyFd, events)) {
        m_error = QStringLiteral("keypad write failed: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    m_keyCode = code;
    return true;
}

bool MirrorInput::releaseKey()
{
    if (m_keyCode < 0) {
        return true;
    }
    QVector<input_event> events;
    events << inputEvent(EV_KEY, static_cast<unsigned short>(m_keyCode), 0) << inputEvent(EV_SYN, SYN_REPORT, 0);
    if (!integerWrite(m_keyFd, events)) {
        m_error = QStringLiteral("keypad release failed: ") + QString::fromLocal8Bit(strerror(errno));
        return false;
    }
    m_keyCode = -1;
    return true;
}

bool MirrorInput::keyUp(const QString &key)
{
    const int code = keypadCode(key);
    return code >= 0 && (m_keyCode < 0 || code == m_keyCode) && releaseKey();
}

bool MirrorInput::swipe(const QPoint &from, const QPoint &to, int durationMs)
{
    if (m_down || durationMs < 50 || durationMs > 2000) {
        return false;
    }
    m_from = from;
    m_to = to;
    m_durationMs = durationMs;
    m_step = 0;
    m_steps = qMax(1, durationMs / SWIPE_INTERVAL_MS);
    if (!begin(from, false)) {
        return false;
    }
    m_timer.start(qMax(1, durationMs / m_steps));
    return true;
}

void MirrorInput::advance()
{
    if (!m_down) {
        return;
    }
    ++m_step;
    if (m_step >= m_steps) {
        move(m_to);
        end();
        return;
    }
    const QPoint p(m_from.x() + (m_to.x() - m_from.x()) * m_step / m_steps,
                   m_from.y() + (m_to.y() - m_from.y()) * m_step / m_steps);
    if (!move(p)) {
        cancel();
        return;
    }
    m_timer.start(qMax(1, m_durationMs / m_steps));
}

void MirrorInput::cancel()
{
    m_timer.stop();
    if (m_down) {
        end();
    }
    releaseKey();
}
