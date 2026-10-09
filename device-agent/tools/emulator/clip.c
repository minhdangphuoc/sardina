/* Emulator test helper: changes Lipstick's clipboard COUNT times (0: until killed), every
 * INTERVAL_MS, as a plain Wayland client (qtwayland 5.6 checks no serial or focus for a selection).
 * Libc only, so it builds without the target's Wayland headers.
 *
 *   clip COUNT INTERVAL_MS */
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static int sock, nid = 2, fdq[64], nfd;
static char kinds[100000];
static uint32_t gname[3], gver[3]; /* seat, ddm */
static unsigned char in[65536]; static int inlen;
static int cbdone[100000];
enum { K_NONE, K_REG, K_CB, K_SRC, K_DD };

static int newid(int k) { kinds[nid] = k; return nid++; }
static void sendmsgw(uint32_t obj, uint32_t op, const void *p, int n)
{
    unsigned char b[512]; uint32_t h[2] = { obj, ((uint32_t)(8 + n) << 16) | op };
    memcpy(b, h, 8); memcpy(b + 8, p, n);
    if (write(sock, b, 8 + n) != 8 + n) { perror("write"); exit(1); }
}
static int putstr(unsigned char *p, const char *s)
{
    uint32_t n = strlen(s) + 1; memcpy(p, &n, 4); memset(p + 4, 0, (n + 3) & ~3u);
    memcpy(p + 4, s, n); return 4 + ((n + 3) & ~3u);
}
static long long nowms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000LL + t.tv_nsec / 1000000; }
static int counter, nsend;

static void handle(uint32_t obj, uint32_t op, unsigned char *b, int n)
{
    int k = obj < sizeof kinds ? kinds[obj] : 0;
    if (obj == 1 && op == 0) { fprintf(stderr, "protocol error\n"); exit(2); }
    if (k == K_REG && op == 0) {
        uint32_t name, len; memcpy(&name, b, 4); memcpy(&len, b + 4, 4);
        const char *iface = (const char *)b + 8; uint32_t ver; memcpy(&ver, b + 8 + ((len + 3) & ~3u), 4);
        if (!strcmp(iface, "wl_seat") && !gname[0]) { gname[0] = name; gver[0] = ver; }
        if (!strcmp(iface, "wl_data_device_manager") && !gname[1]) { gname[1] = name; gver[1] = ver; }
    } else if (k == K_CB) {
        cbdone[obj] = 1;
    } else if (k == K_SRC && op == 1) { /* send(mime, fd) */
        ++nsend;
        if (nfd > 0) {
            int fd = fdq[0]; memmove(fdq, fdq + 1, --nfd * sizeof(int));
            char t[64]; int l = snprintf(t, sizeof t, "clip %d %lld", counter, nowms());
            if (write(fd, t, l) < 0) { }
            close(fd);
        }
    } else if (k == K_SRC && op == 2) { /* cancelled */
        sendmsgw(obj, 1, 0, 0);
    } else if (k == K_DD && op == 0) { /* data_offer: drop at once */
        uint32_t id; memcpy(&id, b, 4); sendmsgw(id, 2, 0, 0);
    }
    (void)n;
}

static void pump(int timeout)
{
    struct pollfd p = { sock, POLLIN, 0 };
    if (poll(&p, 1, timeout) <= 0) return;
    char cbuf[CMSG_SPACE(16 * sizeof(int))];
    struct iovec iov = { in + inlen, sizeof in - inlen };
    struct msghdr m = { 0 }; m.msg_iov = &iov; m.msg_iovlen = 1; m.msg_control = cbuf; m.msg_controllen = sizeof cbuf;
    int r = recvmsg(sock, &m, MSG_CMSG_CLOEXEC);
    if (r <= 0) { fprintf(stderr, "EOF\n"); exit(1); }
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&m); c; c = CMSG_NXTHDR(&m, c))
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            int cnt = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
            memcpy(fdq + nfd, CMSG_DATA(c), cnt * sizeof(int)); nfd += cnt;
        }
    inlen += r;
    int off = 0;
    while (inlen - off >= 8) {
        uint32_t h[2]; memcpy(h, in + off, 8); int size = h[1] >> 16;
        if (inlen - off < size) break;
        handle(h[0], h[1] & 0xffff, in + off + 8, size - 8); off += size;
    }
    memmove(in, in + off, inlen - off); inlen -= off;
}

static void roundtrip(void)
{
    int cb = newid(K_CB); uint32_t a = cb; sendmsgw(1, 0, &a, 4);
    long long end = nowms() + 3000;
    while (!cbdone[cb] && nowms() < end) pump(100);
}

int main(int argc, char **argv)
{
    int count = argc > 1 ? atoi(argv[1]) : 1, interval = argc > 2 ? atoi(argv[2]) : 100;
    struct sockaddr_un a = { AF_UNIX, "/run/display/wayland-0" };
    sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (connect(sock, (struct sockaddr *)&a, sizeof a) < 0) { perror("connect"); return 1; }
    int reg = newid(K_REG); uint32_t v = reg; sendmsgw(1, 1, &v, 4); roundtrip();
    unsigned char p[256]; int n;
    int seat = newid(K_NONE);
    n = 0; memcpy(p, &gname[0], 4); n = 4 + putstr(p + 4, "wl_seat"); v = 1; memcpy(p + n, &v, 4); n += 4; v = seat; memcpy(p + n, &v, 4); n += 4;
    sendmsgw(reg, 0, p, n);
    int ddm = newid(K_NONE);
    n = 0; memcpy(p, &gname[1], 4); n = 4 + putstr(p + 4, "wl_data_device_manager"); v = 1; memcpy(p + n, &v, 4); n += 4; v = ddm; memcpy(p + n, &v, 4); n += 4;
    sendmsgw(reg, 0, p, n);
    int dd = newid(K_DD); uint32_t two[2] = { dd, seat }; sendmsgw(ddm, 1, two, 8); roundtrip();
    for (counter = 0; count == 0 || counter < count; ++counter) {
        if (nid > 90000) break;
        int src = newid(K_SRC); v = src; sendmsgw(ddm, 0, &v, 4);
        n = putstr(p, "text/plain;charset=utf-8"); sendmsgw(src, 0, p, n);
        n = putstr(p, "text/plain"); sendmsgw(src, 0, p, n);
        two[0] = src; two[1] = 0; sendmsgw(dd, 1, two, 8);
        long long end = nowms() + interval;
        do pump((int)(end - nowms() > 0 ? end - nowms() : 0)); while (nowms() < end);
    }
    roundtrip();
    long long end = nowms() + 300; while (nowms() < end) pump(50);
    printf("clipboard changes %d, data sent %d\n", counter, nsend);
    return 0;
}
