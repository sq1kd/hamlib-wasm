/*
 * Native reference transaction for the emulated TS-480.
 *
 * This program is the host-side twin of what the browser package does:
 * the same public Hamlib configuration sequence, the same transaction, and an
 * emulator that mirrors tests/browser/fixtures/rigs.ts byte for byte.  The
 * command log it prints is compared with the browser baseline
 * (packages/hamlib-web/baseline/baseline.json) by build/compare-native.ts,
 * so the adapter can be shown not to perturb protocol behaviour.
 *
 * Hamlib talks to a pseudo terminal, which is what a host build has instead of
 * Web Serial.  Everything above the transport layer is the same upstream code
 * the Wasm build links.
 *
 * Usage: host-trace <library-dir>   (prints one decoded CAT command per line)
 *
 * Build: see build/compare-native.ts.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif

#include <hamlib/rig.h>

/* The emulator stops logging when it sees this byte, so the trace covers the
 * same window the browser baseline records: open through the last command,
 * excluding whatever closing the rig sends. */
#define STOP_LOGGING 0x23 /* '#' */

#define TERMINATOR ';'
#define MODE_USB 2

static int emulator(int master)
{
    char command[256];
    size_t used = 0;
    long frequency = 14074000;
    int mode_digit = MODE_USB;
    int filter_value = 0;
    int transmitting = 0;
    unsigned char chunk[256];

    for (;;)
    {
        ssize_t got = read(master, chunk, sizeof(chunk));

        if (got <= 0) { return 0; }

        for (ssize_t i = 0; i < got; i++)
        {
            char character = (char) chunk[i];
            char reply[64];

            if (character == STOP_LOGGING) { return 0; }

            if (character == TERMINATOR)
            {
                command[used] = '\0';
                used = 0;

                if (command[0] == '\0') { continue; }

                printf("%s\n", command);
                fflush(stdout);

                reply[0] = '\0';

                if (strlen(command) > 2)
                {
                    /* A set command: the backend verifies it with the next
                     * `ID;`, so answering would corrupt the protocol. */
                    char prefix = command[0];
                    char second = command[1];

                    if (prefix == 'F' && second == 'A') { frequency = atol(command + 2); }
                    else if (prefix == 'M' && second == 'D') { mode_digit = atoi(command + 2); }
                    else if (prefix == 'F' && second == 'W') { filter_value = atoi(command + 2); }
                    else if (prefix == 'T' && second == 'X') { transmitting = 1; }
                }
                else if (strcmp(command, "TX") == 0)
                {
                    transmitting = 1;
                }
                else if (strcmp(command, "RX") == 0)
                {
                    transmitting = 0;
                }
                else if (strcmp(command, "ID") == 0) { snprintf(reply, sizeof(reply), "ID020"); }
                else if (strcmp(command, "PS") == 0) { snprintf(reply, sizeof(reply), "PS1"); }
                else if (strcmp(command, "AI") == 0) { snprintf(reply, sizeof(reply), "AI0"); }
                else if (strcmp(command, "FA") == 0 || strcmp(command, "FB") == 0)
                {
                    snprintf(reply, sizeof(reply), "%s%011ld", command, frequency);
                }
                else if (strcmp(command, "MD") == 0)
                {
                    snprintf(reply, sizeof(reply), "MD%d", mode_digit);
                }
                else if (strcmp(command, "FW") == 0)
                {
                    snprintf(reply, sizeof(reply), "FW%04d", filter_value);
                }
                else if (strcmp(command, "IF") == 0)
                {
                    /* The 37 character IF status payload the backend parses:
                     * PTT at [28], mode at [29], VFO at [30], split at [32]. */
                    char status[64];
                    char payload[64];

                    snprintf(status, sizeof(status), "000000000%c%d00%c000",
                             transmitting ? '1' : '0', mode_digit, '0');
                    snprintf(payload, sizeof(payload), "IF%011ld     +%s ",
                             frequency, status);
                    snprintf(reply, sizeof(reply), "%s", payload);
                }
                else if (strcmp(command, "FR") == 0) { snprintf(reply, sizeof(reply), "FR0"); }
                else if (strcmp(command, "FT") == 0) { snprintf(reply, sizeof(reply), "FT0"); }
                else { snprintf(reply, sizeof(reply), "?"); }

                if (reply[0] != '\0')
                {
                    size_t length = strlen(reply);
                    reply[length] = TERMINATOR;
                    reply[length + 1] = '\0';

                    if (write(master, reply, length + 1) < 0)
                    {
                        fprintf(stderr, "emulator: write failed: %s\n", strerror(errno));
                        return 1;
                    }
                }
            }
            else if (used < sizeof(command) - 1)
            {
                command[used++] = character;
            }
        }
    }
}

static int set_conf(RIG *rig, const char *name, const char *value)
{
    hamlib_token_t token = rig_token_lookup(rig, name);

    if (token == RIG_CONF_END)
    {
        fprintf(stderr, "no such configuration token: %s\n", name);
        return -1;
    }

    int rc = rig_set_conf(rig, token, value);

    if (rc != RIG_OK)
    {
        fprintf(stderr, "rig_set_conf(%s) failed: %s\n", name, rigerror(rc));
        return -1;
    }

    return 0;
}

int main(int argc, char **argv)
{
    int master = -1;
    int slave = -1;
    char slave_path[256];
    pid_t emulator_pid;

    if (argc != 2)
    {
        fprintf(stderr, "usage: %s <library-dir>\n", argv[0]);
        return 2;
    }

    if (openpty(&master, &slave, slave_path, NULL, NULL) != 0)
    {
        fprintf(stderr, "openpty failed: %s\n", strerror(errno));
        return 1;
    }

    emulator_pid = fork();

    if (emulator_pid < 0)
    {
        fprintf(stderr, "fork failed: %s\n", strerror(errno));
        return 1;
    }

    if (emulator_pid == 0)
    {
        close(slave);
        return emulator(master);
    }

    close(master);

    rig_set_debug(RIG_DEBUG_ERR);
    rig_load_all_backends();

    RIG *rig = rig_init(RIG_MODEL_TS480);

    if (!rig)
    {
        fprintf(stderr, "rig_init failed\n");
        return 1;
    }

    /* The same configuration the browser facade applies. */
    if (set_conf(rig, "rig_pathname", slave_path) != 0) { return 1; }

    if (set_conf(rig, "async", "0") != 0) { return 1; }

    if (set_conf(rig, "poll_interval", "0") != 0) { return 1; }

    if (set_conf(rig, "cache_timeout", "500") != 0) { return 1; }

    if (set_conf(rig, "auto_power_on", "0") != 0) { return 1; }

    if (set_conf(rig, "auto_power_off", "0") != 0) { return 1; }

    if (set_conf(rig, "serial_speed", "115200") != 0) { return 1; }

    int rc = rig_open(rig);

    if (rc != RIG_OK)
    {
        fprintf(stderr, "rig_open failed: %s\n", rigerror(rc));
        return 1;
    }

    /* The transaction tests/browser/baseline.spec.ts records. */
    freq_t frequency = 0;
    rc = rig_get_freq(rig, RIG_VFO_CURR, &frequency);

    if (rc != RIG_OK) { fprintf(stderr, "rig_get_freq: %s\n", rigerror(rc)); }

    rmode_t mode = RIG_MODE_NONE;
    pbwidth_t width = 0;
    rc = rig_get_mode(rig, RIG_VFO_CURR, &mode, &width);

    if (rc != RIG_OK) { fprintf(stderr, "rig_get_mode: %s\n", rigerror(rc)); }

    rc = rig_set_freq(rig, RIG_VFO_CURR, 7074000);

    if (rc != RIG_OK) { fprintf(stderr, "rig_set_freq: %s\n", rigerror(rc)); }

    rc = rig_set_mode(rig, RIG_VFO_CURR, RIG_MODE_CW, 500);

    if (rc != RIG_OK) { fprintf(stderr, "rig_set_mode: %s\n", rigerror(rc)); }

    rc = rig_set_ptt(rig, RIG_VFO_CURR, RIG_PTT_ON);

    if (rc != RIG_OK) { fprintf(stderr, "rig_set_ptt(on): %s\n", rigerror(rc)); }

    rc = rig_set_ptt(rig, RIG_VFO_CURR, RIG_PTT_OFF);

    if (rc != RIG_OK) { fprintf(stderr, "rig_set_ptt(off): %s\n", rigerror(rc)); }

    /* Stop the emulator log here, then close cleanly. */
    if (write(slave, "#", 1) < 0) { fprintf(stderr, "sentinel write failed\n"); }

    rig_close(rig);
    rig_cleanup(rig);

    fsync(slave);
    close(slave);

    int status = 0;
    waitpid(emulator_pid, &status, 0);

    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
