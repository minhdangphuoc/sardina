# Shared by the daemon and its module executables. Plain Qt only (Qt 5.6 on the phone): no Silica.
AGENT_VERSION = 1.11.2
DEFINES += AGENT_VERSION=\\\"$$AGENT_VERSION\\\"

CONFIG += c++11 console link_pkgconfig
CONFIG -= app_bundle

INCLUDEPATH += $$PWD
HEADERS += $$PWD/paths.h $$PWD/childlink.h $$PWD/linebuffer.h $$PWD/signalpipe.h
SOURCES += $$PWD/paths.cpp $$PWD/childlink.cpp $$PWD/signalpipe.cpp
