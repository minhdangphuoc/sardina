/* Emulator test helper: a virtual 720x1600 multi-touch screen, so the input module has a device to
 * write to (the emulator has none; Lipstick reads it like a real one). Run as root until killed;
 * the device goes with the process. */
#include <fcntl.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void absinfo(struct uinput_user_dev *d, int code, int max) { d->absmin[code] = 0; d->absmax[code] = max; }

int main(void)
{
    int fd = open("/dev/uinput", O_WRONLY);
    if (fd < 0) { perror("uinput"); return 1; }
    ioctl(fd, UI_SET_EVBIT, EV_KEY); ioctl(fd, UI_SET_KEYBIT, BTN_TOUCH);
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    int codes[] = { ABS_X, ABS_Y, ABS_MT_SLOT, ABS_MT_POSITION_X, ABS_MT_POSITION_Y, ABS_MT_TRACKING_ID, ABS_MT_PRESSURE, ABS_MT_TOUCH_MAJOR };
    for (unsigned i = 0; i < sizeof codes / sizeof *codes; ++i) ioctl(fd, UI_SET_ABSBIT, codes[i]);
    ioctl(fd, UI_SET_PROPBIT, INPUT_PROP_DIRECT);
    struct uinput_user_dev d; memset(&d, 0, sizeof d);
    snprintf(d.name, sizeof d.name, "ovtest touchscreen");
    d.id.bustype = BUS_VIRTUAL; d.id.vendor = 1; d.id.product = 1;
    absinfo(&d, ABS_X, 719); absinfo(&d, ABS_Y, 1599); absinfo(&d, ABS_MT_SLOT, 9);
    absinfo(&d, ABS_MT_POSITION_X, 719); absinfo(&d, ABS_MT_POSITION_Y, 1599);
    absinfo(&d, ABS_MT_TRACKING_ID, 65535); absinfo(&d, ABS_MT_PRESSURE, 255); absinfo(&d, ABS_MT_TOUCH_MAJOR, 255);
    if (write(fd, &d, sizeof d) != sizeof d || ioctl(fd, UI_DEV_CREATE) < 0) { perror("create"); return 1; }
    printf("created\n"); fflush(stdout);
    pause();
    return 0;
}
