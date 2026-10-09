#ifndef SIGNALPIPE_H
#define SIGNALPIPE_H

#include <QList>
#include <QObject>

class QSocketNotifier;

// Turns POSIX signals into a Qt signal through a self-pipe, so handlers only write one byte and the
// work runs in the event loop. One instance per process.
class SignalPipe : public QObject
{
    Q_OBJECT
public:
    explicit SignalPipe(const QList<int> &signalNumbers, QObject *parent = nullptr);

signals:
    void received(int signalNumber);

private slots:
    void onReadable();

private:
    QSocketNotifier *m_notifier;
};

#endif
