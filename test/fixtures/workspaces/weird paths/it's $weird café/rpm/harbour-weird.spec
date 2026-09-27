Name:       harbour-weird
Summary:    Weird-path demo Sailfish OS application
Version:    0.1
Release:    1
Group:      Qt/Qt
License:    LICENSE
URL:        https://example.com
Source0:    %{name}-%{version}.tar.bz2
Requires:   sailfishsilica-qt5 >= 0.10.9

%description
%{summary}.

%build

%install

%files
%defattr(-,root,root,-)
%{_bindir}/%{name}
