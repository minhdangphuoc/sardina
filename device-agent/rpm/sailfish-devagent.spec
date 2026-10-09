Name:       sailfish-devagent
Summary:    Developer agent for VS Code: the service and its Settings page
Version:    1.11.0
Release:    1
License:    GPL-3.0-or-later
URL:        https://github.com/minhdangphuoc/vscode-sailfish
Source0:    %{name}-%{version}.tar.bz2
Requires:   systemd
Requires(post):   systemd
Requires(preun):  systemd
Requires(postun): systemd
BuildRequires:  pkgconfig(Qt5Core)
BuildRequires:  pkgconfig(Qt5DBus)
BuildRequires:  pkgconfig(Qt5Network)
BuildRequires:  pkgconfig(Qt5Gui)
BuildRequires:  pkgconfig(wayland-client)
BuildRequires:  wayland-devel
BuildRequires:  pkgconfig(vpx)

%description
A small service for developers, installed from the Sailfish OS Tools extension
for VS Code. It listens on a Unix socket that only the device user can open;
VS Code reaches it through the SDK's existing SSH login. Each feature is a
module package of its own, started only for one request or stream. It runs as
defaultuser with the privileged and systemd-journal groups only, serves only
while Developer Mode (jolla-developer-mode) is installed, and opens no network
port.

A page in Settings > System > Developer agent lets the person at the phone
allow or refuse screen view, control and system logs, choose how a session is
indicated, and stop every session at once. Only the Settings app (the
privileged group) can change these settings; VS Code's SSH login cannot.

%package logs
Summary:    Developer agent module: system logs
Requires:   %{name} = %{version}-%{release}

%description logs
Streams the system journal to VS Code through the developer agent, while
"Allow system logs" is on in Settings > System > Developer agent.

%package stats
Summary:    Developer agent module: app statistics
Requires:   %{name} = %{version}-%{release}

%description stats
Streams CPU and memory numbers of the app being debugged, read from /proc, to
the VS Code Device Monitor through the developer agent.

%package screenshot
Summary:    Developer agent module: screenshots
Requires:   %{name} = %{version}-%{release}

%description screenshot
Takes screenshots through lipstick for VS Code through the developer agent,
while "Allow screen view" is on in Settings > System > Developer agent.

%package mirror
Summary:    Developer agent module: live screen mirror
Requires:   %{name} = %{version}-%{release}

%description mirror
Streams a live view of the screen to VS Code through the developer agent:
lipstick's Wayland recorder, JPEG images or VP8 video through libvpx. Runs
only while a mirror panel is open and "Allow screen view" is on.

%package input
Summary:    Developer agent module: control from VS Code
Requires:   %{name}-mirror = %{version}-%{release}

%description input
Lets VS Code tap, swipe and press keypad keys on the phone from the mirror
panel, through the phone's own input devices, while "Allow control from VS
Code" is on. Without it the mirror is view-only.

%prep
%setup -q -n %{name}-%{version}

%build
%qmake5
%make_build

%install
%qmake5_install
# The phone's settings: root-owned so the SSH login (same uid as the agent, not in the privileged
# group) can neither enter nor chmod it; the agent writes settings.json with its privileged group.
mkdir -p %{buildroot}/var/lib/sailfish-devagent
# Started at boot through a wants link the package owns, so nothing is written to /etc
# (`systemctl enable` would) and erasing the package removes it.
mkdir -p %{buildroot}/usr/lib/systemd/system/multi-user.target.wants
ln -s ../sailfish-devagent.service %{buildroot}/usr/lib/systemd/system/multi-user.target.wants/sailfish-devagent.service

%post
systemctl daemon-reload >/dev/null 2>&1 || :
# Agents up to 1.10.0 were enabled with `systemctl enable`; their link in /etc is ours, and the
# package's own wants link replaces it.
if [ -L /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service ]; then
    rm -f /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service
fi
# On an upgrade the old daemon is still running: restart it so the new version serves.
if [ "$1" -ge 2 ]; then
    systemctl try-restart sailfish-devagent.service >/dev/null 2>&1 || :
fi
systemctl start sailfish-devagent.service >/dev/null 2>&1 || :
# A running Settings app does not see a new or changed entry and page: close it (only it, never
# lipstick), so it reads them again when it is next opened.
pkill -u defaultuser -x jolla-settings >/dev/null 2>&1 || :

%preun
# $1 is the number of versions left after this step: 0 on erase, 1 or more on an upgrade. An upgrade
# keeps everything (the settings survive it, and %post restarts the new daemon).
if [ "$1" = "0" ]; then
    # The daemon closes its session entry and removes its socket directory on SIGTERM.
    systemctl stop sailfish-devagent.service >/dev/null 2>&1 || :
    # Remove the "Developer agent is running" notification and any stream entry; the unit's user owns
    # them, and lipstick keeps them after the daemon is gone.
    runuser -u defaultuser -- /usr/bin/sailfish-devagent --remove-notifications >/dev/null 2>&1 || :
fi

%postun
systemctl daemon-reload >/dev/null 2>&1 || :
if [ "$1" = "0" ]; then
    # Erase only: whatever the agent (or the extension's install) created outside %files.
    if [ -L /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service ]; then
        rm -f /etc/systemd/system/multi-user.target.wants/sailfish-devagent.service
    fi
    systemctl reset-failed sailfish-devagent.service >/dev/null 2>&1 || :
    # Settings and the temporary file of an interrupted settings write.
    rm -rf /var/lib/sailfish-devagent
    devagent_uid=$(id -u defaultuser 2>/dev/null) || devagent_uid=
    devagent_home=$(getent passwd defaultuser 2>/dev/null | cut -d: -f6) || devagent_home=
    # Socket and unfetched screenshots of a daemon that did not stop cleanly. rm does not follow a
    # symlink given as the operand, so a link planted there removes only the link.
    if [ -n "$devagent_uid" ]; then
        rm -rf "/run/user/$devagent_uid/sailfish-devagent"
    fi
    # lipstick's screenshot staging folder: only the agent's own file names, then the folder if empty.
    if [ -n "$devagent_home" ] && [ -d "$devagent_home/sailfish-devagent" ] && [ ! -L "$devagent_home/sailfish-devagent" ]; then
        rm -f "$devagent_home"/sailfish-devagent/shot-*.png
        rmdir "$devagent_home/sailfish-devagent" >/dev/null 2>&1 || :
    fi
    # The Settings app would keep showing the removed entry until it restarts.
    pkill -u defaultuser -x jolla-settings >/dev/null 2>&1 || :
fi

# A removed module's running stream ends with it; the daemon sees its process exit.
%preun logs
if [ "$1" = "0" ]; then
    pkill -u defaultuser -f '^/usr/libexec/sailfish-devagent/sailfish-devagent-logs( |$)' >/dev/null 2>&1 || :
fi

%preun stats
if [ "$1" = "0" ]; then
    pkill -u defaultuser -f '^/usr/libexec/sailfish-devagent/sailfish-devagent-stats( |$)' >/dev/null 2>&1 || :
fi

%preun screenshot
if [ "$1" = "0" ]; then
    pkill -u defaultuser -f '^/usr/libexec/sailfish-devagent/sailfish-devagent-screenshot( |$)' >/dev/null 2>&1 || :
fi

%preun mirror
if [ "$1" = "0" ]; then
    pkill -u defaultuser -f '^/usr/libexec/sailfish-devagent/sailfish-devagent-mirror( |$)' >/dev/null 2>&1 || :
fi

%preun input
if [ "$1" = "0" ]; then
    pkill -u defaultuser -f '^/usr/libexec/sailfish-devagent/sailfish-devagent-input( |$)' >/dev/null 2>&1 || :
fi

%files
%defattr(-,root,root,-)
%{_bindir}/sailfish-devagent
/usr/lib/systemd/system/sailfish-devagent.service
/usr/lib/systemd/system/multi-user.target.wants/sailfish-devagent.service
/usr/share/jolla-settings/entries/sailfish-devagent.json
%dir /usr/share/sailfish-devagent
%dir /usr/share/sailfish-devagent/settings
/usr/share/sailfish-devagent/settings/DeveloperAgentPage.qml
%dir %attr(0770,root,privileged) /var/lib/sailfish-devagent
%ghost %attr(0660,defaultuser,privileged) /var/lib/sailfish-devagent/settings.json

%files logs
%defattr(-,root,root,-)
%dir %{_libexecdir}/sailfish-devagent
%{_libexecdir}/sailfish-devagent/sailfish-devagent-logs

%files stats
%defattr(-,root,root,-)
%dir %{_libexecdir}/sailfish-devagent
%{_libexecdir}/sailfish-devagent/sailfish-devagent-stats

%files screenshot
%defattr(-,root,root,-)
%dir %{_libexecdir}/sailfish-devagent
%{_libexecdir}/sailfish-devagent/sailfish-devagent-screenshot

%files mirror
%defattr(-,root,root,-)
%dir %{_libexecdir}/sailfish-devagent
%{_libexecdir}/sailfish-devagent/sailfish-devagent-mirror

%files input
%defattr(-,root,root,-)
%dir %{_libexecdir}/sailfish-devagent
%{_libexecdir}/sailfish-devagent/sailfish-devagent-input
