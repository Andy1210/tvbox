/* tvbox - LD_PRELOAD shim: replace libcec's hardcoded CEC vendor identity.
 *
 * libcec's Linux adapter registers vendor_id = Pulse-Eight (0x001582) with
 * the kernel (broadcast at every logical-address claim) and its generic
 * handler answers <Give Device Vendor ID> with the same before any
 * TV-specific masquerade handler is installed. Some TVs key protocol
 * features on that identity - LG SIMPLINK only forwards remote keys to
 * devices whose vendor reads LG (0x00e091), queries it ~200 ms after a
 * device appears, and caches the first answer per logical address - so the
 * masquerade always loses the race and the box gets blacklisted (symptom:
 * endless 89:01 vendor-command probing, no keys).
 *
 * The shim is vendor-agnostic: it rewrites libcec's Pulse-Eight identity to
 * the 24-bit vendor ID given in $CEC_SHIM_VENDOR_ID (6 hex digits, e.g.
 * "00e091"); unset/invalid means no-op. Loaded into cec-client (only) by
 * cec_uinput_bridge.py - which TVs get it and which vendor is announced is
 * the bridge's policy (see its docstring; default: LG TVs only, as that is
 * the only brand this has been tested against).
 */
#define _GNU_SOURCE
#include <linux/cec.h>
#include <sys/ioctl.h>
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#define VENDOR_PULSE_EIGHT 0x001582
#define VENDOR_NONE        0xffffffff

static int (*real_ioctl)(int, unsigned long, ...) = NULL;
static unsigned long target = VENDOR_NONE;

__attribute__((constructor)) static void init(void) {
    const char *env = getenv("CEC_SHIM_VENDOR_ID");
    if (env && env[0]) {
        char *end = NULL;
        unsigned long v = strtoul(env, &end, 16);
        if (end && *end == '\0' && v <= 0xffffff) {
            target = v;
            fprintf(stderr, "[cec_vendor_shim] active, vendor -> %06lx\n", target);
            return;
        }
        fprintf(stderr, "[cec_vendor_shim] bad CEC_SHIM_VENDOR_ID %s - disabled\n", env);
    }
}

int ioctl(int fd, unsigned long req, ...) {
    va_list ap;
    va_start(ap, req);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (!real_ioctl)
        real_ioctl = dlsym(RTLD_NEXT, "ioctl");
    if (target != VENDOR_NONE && req == CEC_ADAP_S_LOG_ADDRS && arg) {
        struct cec_log_addrs *la = arg;
        if (la->num_log_addrs > 0 && la->vendor_id == VENDOR_PULSE_EIGHT)
            la->vendor_id = target;
    } else if (target != VENDOR_NONE && req == CEC_TRANSMIT && arg) {
        struct cec_msg *m = arg;
        /* <Device Vendor ID> (opcode 0x87) carrying Pulse-Eight */
        if (m->len >= 5 && m->msg[1] == 0x87 &&
            m->msg[2] == 0x00 && m->msg[3] == 0x15 && m->msg[4] == 0x82) {
            m->msg[2] = (target >> 16) & 0xff;
            m->msg[3] = (target >> 8) & 0xff;
            m->msg[4] = target & 0xff;
        }
    }
    return real_ioctl(fd, req, arg);
}
