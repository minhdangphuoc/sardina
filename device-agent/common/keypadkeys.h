#ifndef KEYPADKEYS_H
#define KEYPADKEYS_H

#include <QString>

// The keypad keys VS Code may press, by name. The mirror checks names before forwarding them; the
// input module maps them to evdev codes in the same order (input/mirrorinput.cpp).
const char *const KEYPAD_KEY_NAMES[] = {
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#",
    "OK", "UP", "DOWN", "LEFT", "RIGHT", "MENU", "BACK", "CALL", "F21", "F22", "F23",
};
const int KEYPAD_KEY_COUNT = sizeof(KEYPAD_KEY_NAMES) / sizeof(KEYPAD_KEY_NAMES[0]);

inline int keypadKeyIndex(const QString &name)
{
    for (int i = 0; i < KEYPAD_KEY_COUNT; ++i) {
        if (name == QLatin1String(KEYPAD_KEY_NAMES[i])) {
            return i;
        }
    }
    return -1;
}

#endif
