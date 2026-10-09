#ifndef NOTICE_H
#define NOTICE_H

class Settings;

// The "Developer agent is running" entry on the phone, and the cleanup of every entry the agent
// posted (the stream indicator's too).
class StartNotice
{
public:
    explicit StartNotice(const Settings *settings);

    // Posts the entry unless muted; `silent` posts it without a banner (after an unmute).
    void post(bool silent = false);
    // Closes it ("Mute agent notifications").
    void close();
    // The entry is gone with the stopped daemon (closed by removeAll()); the next start posts it.
    void forget() { m_notified = false; }

    // Closes stream entries left by a daemon that did not stop cleanly.
    static void closeStaleStreamEntries();
    // Closes every entry the agent posted. Run as the device user by the package's %preun on
    // uninstall, and when the daemon stops; returns the exit code.
    static int removeAll();

private:
    const Settings *m_settings;
    bool m_notified;
};

#endif
