Name:       sailfish-devagent
Summary:    Developer agent for VS Code: screenshots and system logs over the SDK's SSH login
Version:    1.1.0
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

%description
A small service for developers, installed from the Sailfish OS Tools extension
for VS Code. It takes screenshots through lipstick (also repeatedly, as a live view of the
screen) and streams the system journal, over a Unix socket that only the device user can open; VS Code reaches
it through the SDK's existing SSH login. It runs as defaultuser with the
privileged and systemd-journal groups only, serves only while Developer Mode
(jolla-developer-mode) is installed, and opens no network port.

%prep
%setup -q -n %{name}-%{version}

%build
%qmake5
%make_build

%install
%qmake5_install

%post
systemctl daemon-reload >/dev/null 2>&1 || :
systemctl enable --now sailfish-devagent.service >/dev/null 2>&1 || :

%preun
if [ "$1" = "0" ]; then
    systemctl disable --now sailfish-devagent.service >/dev/null 2>&1 || :
fi

%postun
systemctl daemon-reload >/dev/null 2>&1 || :

%files
%defattr(-,root,root,-)
%{_bindir}/sailfish-devagent
/usr/lib/systemd/system/sailfish-devagent.service
