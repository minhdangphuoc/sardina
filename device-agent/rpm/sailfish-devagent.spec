Name:       sailfish-devagent
Summary:    Developer agent for VS Code: screen, logs, and a Settings page
Version:    1.10.0
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
for VS Code. It takes screenshots through lipstick, streams a live view of the
screen (through lipstick's Wayland recorder, as JPEG images or VP8 video
through libvpx) and streams the system journal, over a Unix socket that only the device user can open; VS Code reaches
it through the SDK's existing SSH login. It runs as defaultuser with the
privileged and systemd-journal groups only, serves only while Developer Mode
(jolla-developer-mode) is installed, and opens no network port.

A page in Settings > System > Developer agent lets the person at the phone
allow or refuse screen view, control and system logs, choose how a session is
indicated, and stop every session at once. Only the Settings app (the
privileged group) can change these settings; VS Code's SSH login cannot.

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

%post
systemctl daemon-reload >/dev/null 2>&1 || :
systemctl enable --now sailfish-devagent.service >/dev/null 2>&1 || :
# On an upgrade the old daemon is still running: restart it so the new version serves.
if [ "$1" -ge 2 ]; then
    systemctl try-restart sailfish-devagent.service >/dev/null 2>&1 || :
fi

%preun
if [ "$1" = "0" ]; then
    systemctl disable --now sailfish-devagent.service >/dev/null 2>&1 || :
    # Remove the "Developer agent is running" notification; the unit's user owns it.
    runuser -u defaultuser -- /usr/bin/sailfish-devagent --remove-notifications >/dev/null 2>&1 || :
fi

%postun
systemctl daemon-reload >/dev/null 2>&1 || :
if [ "$1" = "0" ]; then
    # Settings and any temporary file the agent left behind.
    rm -rf /var/lib/sailfish-devagent
fi

%files
%defattr(-,root,root,-)
%{_bindir}/sailfish-devagent
/usr/lib/systemd/system/sailfish-devagent.service
/usr/share/jolla-settings/entries/sailfish-devagent.json
%dir /usr/share/sailfish-devagent
%dir /usr/share/sailfish-devagent/settings
/usr/share/sailfish-devagent/settings/DeveloperAgentPage.qml
%dir %attr(0770,root,privileged) /var/lib/sailfish-devagent
%ghost %attr(0660,defaultuser,privileged) /var/lib/sailfish-devagent/settings.json
