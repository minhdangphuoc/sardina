Name:       harbour-pureqml
Summary:    Pure-QML demo Sailfish OS application
Version:    0.1
Release:    1
Group:      Qt/Qt
License:    LICENSE
URL:        https://example.com
Source0:    %{name}-%{version}.tar.bz2
Requires:   sailfish-qml
BuildArch:  noarch

%description
%{summary}.

%prep
%setup -q -n %{name}-%{version}

%build

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}%{_datadir}/%{name}/qml
cp -a qml/* %{buildroot}%{_datadir}/%{name}/qml/

%files
%defattr(-,root,root,-)
%{_datadir}/%{name}/qml
%{_datadir}/applications/%{name}.desktop
%{_datadir}/icons/hicolor/86x86/apps/%{name}.png
