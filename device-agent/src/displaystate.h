#ifndef DISPLAYSTATE_H
#define DISPLAYSTATE_H

#include <QObject>

// Whether the phone's display is blank, from MCE (system bus): its current status at start and the
// display_status_ind signal. Unknown (no MCE, no answer) counts as on.
class DisplayState : public QObject
{
    Q_OBJECT
public:
    explicit DisplayState(QObject *parent = nullptr);

    bool off() const { return m_off; }

signals:
    void changed();

private slots:
    void onStatus(const QString &status);

private:
    bool m_off;
};

#endif
