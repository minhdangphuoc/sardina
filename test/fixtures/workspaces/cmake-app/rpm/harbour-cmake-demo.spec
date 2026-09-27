Name:       harbour-cmake-demo
Summary:    CMake-based demo Sailfish OS application
Version:    0.1
Release:    1
Group:      Qt/Qt
License:    LICENSE
URL:        https://example.com
Source0:    %{name}-%{version}.tar.bz2
Requires:   sailfishsilica-qt5 >= 0.10.9
BuildRequires: cmake >= 3.10
BuildRequires: pkgconfig(Qt5Core)
BuildRequires: pkgconfig(Qt5Qml)
BuildRequires: pkgconfig(Qt5Quick)

%description
%{summary}.

%prep
%setup -q -n %{name}-%{version}

%build
%cmake
make %{?_smp_mflags}

%install
%cmake_install

%files
%defattr(-,root,root,-)
%{_bindir}/%{name}
