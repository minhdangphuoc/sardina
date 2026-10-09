TEMPLATE = app
TARGET = sailfish-devagent-input
include(../common/module.pri)
QT = core network

SOURCES += \
    main.cpp \
    mirrorinput.cpp \
    virtualpointer.cpp

HEADERS += \
    mirrorinput.h \
    virtualpointer.h \
    ../common/pointertrack.h \
    ../common/keypadkeys.h
