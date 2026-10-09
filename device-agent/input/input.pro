TEMPLATE = app
TARGET = sailfish-devagent-input
include(../common/module.pri)
QT = core network

SOURCES += \
    main.cpp \
    mirrorinput.cpp

HEADERS += \
    mirrorinput.h \
    ../common/keypadkeys.h
