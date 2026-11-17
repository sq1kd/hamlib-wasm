/*
 * SPDX-License-Identifier: MIT
 *
 * Narrow native facade for the Hamlib WebAssembly build.
 *
 * Everything the browser package may do is expressed here as Embind
 * operations that exchange only value objects and primitive integers.  No C
 * pointer, no Hamlib struct and no Wasm memory address ever crosses the
 * boundary; RIG objects live behind integer handles owned by this file.
 *
 * The facade deliberately depends on public Hamlib API only:
 *
 *   - model metadata and capabilities come from `rig_get_caps()` and the
 *     public `struct rig_caps`,
 *   - every port and state setting goes through `rig_token_lookup()` +
 *     `rig_set_conf()`, so no `struct rig_state` or `hamlib_port_t` field is
 *     written directly and no deprecated mirror field has to be maintained,
 *   - the browser transport is reached through `native/web_serial.h`.
 *
 * `IN_HAMLIB` / `hamlib/rig_state.h` are therefore not needed here.
 *
 * Provenance: project-owned code, MIT.  Hamlib itself remains
 * LGPL-2.1-or-later and is linked in statically.
 */

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <string>
#include <type_traits>
#include <vector>

#include <emscripten/bind.h>

#include "hamlib/rig.h"

#include "generated/codecs.h"
#include "generated/policy.h"
#include "web_serial.h"

/* --------------------------------------------------------------------- */
/* value objects                                                         */
/* --------------------------------------------------------------------- */

/* A C string Hamlib may leave NULL, as a std::string. */
static std::string textOrEmpty(const char *text)
{
    return text ? std::string(text) : std::string();
}

/*
 * Every value object the boundary returns, and the packing of a projection a
 * bespoke body returns.  Regenerated from hamlib.config.yaml and the upstream
 * AST; see packages/hamlib-codegen.
 */
#include "generated/results.inc"

namespace
{

const unsigned int kMaxHandle = 0x7fffffffU;

/*
 * A JavaScript number as the native type T.  An integer type (an enum
 * through its underlying type) takes only a whole number inside its range:
 * a fraction would be truncated silently, and converting a value outside the
 * range is undefined behaviour.  A floating type takes any number.
 */
template <typename T>
bool fromNumber(double value, T *out)
{
    if constexpr (std::is_floating_point<T>::value)
    {
        *out = (T) value;
        return true;
    }
    else
    {
        using Integer = typename std::conditional<std::is_enum<T>::value,
              std::underlying_type<T>, std::common_type<T>>::type::type;
        using Limits = std::numeric_limits<Integer>;
        const double bound = std::ldexp(1.0, Limits::digits);
        const double lowest = Limits::is_signed ? -bound : 0.0;

        /* NaN fails the first test, an infinity the second. */
        if (std::trunc(value) != value || value >= bound || value < lowest) { return false; }

        *out = (T) (Integer) value;
        return true;
    }
}

std::string takeTransportError()
{
    const char *why = webserial_last_error();

    if (!why) { return std::string(); }

    return std::string(why);
}

/* A serial RTS/DTR PTT line and a serial DSR/CTS/CAR DCD line are driven by
 * the browser transport, not by a backend callback, so the corresponding
 * capabilities have to be reported as available. */
bool serialPttCapable(ptt_type_t ptt)
{
    return ptt == RIG_PTT_SERIAL_RTS || ptt == RIG_PTT_SERIAL_DTR;
}

bool serialDcdCapable(dcd_type_t dcd)
{
    return dcd == RIG_DCD_SERIAL_DSR || dcd == RIG_DCD_SERIAL_CTS
           || dcd == RIG_DCD_SERIAL_CAR;
}

int collectModel(const struct rig_caps *caps, void *data)
{
    std::vector<ModelInfo> *models = static_cast<std::vector<ModelInfo> *>(data);

    if (caps->port_type != RIG_PORT_SERIAL)
    {
        return 1;
    }

    ModelInfo info;
    info.id = (int) caps->rig_model;
    info.manufacturer = caps->mfg_name ? caps->mfg_name : "";
    info.model = caps->model_name ? caps->model_name : "";
    info.backendVersion = caps->version ? caps->version : "";
    info.status = (int) caps->status;
    info.serialRateMin = caps->serial_rate_min;
    info.serialRateMax = caps->serial_rate_max;
    info.serialDataBits = caps->serial_data_bits;
    info.serialStopBits = caps->serial_stop_bits;
    /* The declared line settings travel as names, not Hamlib enum values, so
     * the public TypeScript API never exposes an upstream enum. */
    info.serialParity = textOrEmpty(strSerialParity(caps->serial_parity));
    info.serialHandshake = textOrEmpty(strSerialHandshake(caps->serial_handshake));
    /* get_freq/set_freq/get_mode/set_mode are not projected here: the
     * capability list the generator emits already carries those operations,
     * and TypeScript derives the booleans from it. */
    info.canGetPtt = caps->get_ptt != NULL || serialPttCapable(caps->ptt_type);
    info.canSetPtt = caps->set_ptt != NULL || serialPttCapable(caps->ptt_type);

    models->push_back(info);
    return 1;
}

/*
 * rig_debug() hands every line to this callback instead of stderr once it is
 * registered.  The line is formatted here, because a va_list cannot cross into
 * JavaScript, and forwarded whole; Hamlib's own lines end in a newline, which
 * the log hook trims.
 */
int forwardDebug(enum rig_debug_level_e level, rig_ptr_t, const char *format, va_list args)
{
    va_list measure;
    va_copy(measure, args);
    int length = vsnprintf(NULL, 0, format, measure);
    va_end(measure);

    if (length < 0) { return RIG_OK; }

    std::vector<char> line((size_t) length + 1, '\0');
    vsnprintf(line.data(), line.size(), format, args);
    hamlibWsLog((int) level, line.data());
    return RIG_OK;
}

/* Bytes cross the Embind boundary as hex: a std::string from JavaScript is
 * UTF-8, which would mangle every byte above 0x7f. */
bool hexToBytes(const std::string &hex, std::vector<unsigned char> *bytes)
{
    if (hex.size() % 2 != 0) { return false; }

    bytes->clear();

    for (size_t index = 0; index < hex.size(); index += 2)
    {
        unsigned int value = 0;

        if (sscanf(hex.c_str() + index, "%2x", &value) != 1) { return false; }

        bytes->push_back((unsigned char) value);
    }

    return true;
}

std::string bytesToHex(const unsigned char *bytes, int count)
{
    static const char digits[] = "0123456789abcdef";
    std::string hex;

    for (int index = 0; index < count; ++index)
    {
        hex.push_back(digits[bytes[index] >> 4]);
        hex.push_back(digits[bytes[index] & 0x0f]);
    }

    return hex;
}

/* Upstream's Morse worker sends at most this many characters per command when
 * a backend declares no morse_qsize: the shortest any rig accepts. */
const int kDefaultMorseChunk = 20;

/* The largest reply rig_send_raw() reads: its own stack buffer. */
const int kMaxRawReply = 200;

/*
 * What a single command gets while probing a baud rate.
 *
 * A rig that answers answers in milliseconds - a 3 byte command and its reply
 * at 1200 baud is still under 200 ms - so this only has to outlast a slow round
 * trip, while keeping a candidate that produces silence to a fraction of the
 * model's declared timeout.  A rig whose CAT genuinely needs longer can still
 * be opened by stating its rate: the normal open runs under the model's own
 * timeout and retries.
 */
const int kProbeTimeoutMs = 400;

class Facade
{
public:
    /*
     * Generated method bodies for every operation the upstream AST describes.
     * Regenerated by packages/hamlib-codegen.
     */
#include "generated/operations.inc"

    /*
     * Capability matrix derived from `struct rig_caps`, so callers can tell
     * which generated operations a model actually implements.
     */
#include "generated/capabilities.inc"

    CodeResult initialize()
    {
        webserial_clear_error();

        if (!backendsLoaded_)
        {
            /* Hamlib defaults to RIG_DEBUG_TRACE, which sends a line per
             * registered backend and per transaction to the host console.  A
             * library embedded in a page should report errors only, so quieten
             * it before the backends announce themselves. */
            rig_set_debug(RIG_DEBUG_ERR);

            int rc = rig_load_all_backends();

            if (rc != RIG_OK) { return failure<CodeResult>(rc); }

            backendsLoaded_ = true;
        }

        return ok<CodeResult>();
    }

    std::string version()
    {
        return textOrEmpty(rig_version());
    }

    std::vector<ModelInfo> listModels()
    {
        std::vector<ModelInfo> models;

        if (!backendsLoaded_) { initialize(); }

        rig_list_foreach(collectModel, &models);

        std::sort(models.begin(), models.end(),
                  [](const ModelInfo &a, const ModelInfo &b)
        {
            if (a.manufacturer != b.manufacturer)
            {
                return a.manufacturer < b.manufacturer;
            }

            if (a.model != b.model) { return a.model < b.model; }

            return a.id < b.id;
        });

        return models;
    }

    /*
     * The SerialPort object itself is stored by the JavaScript transport, which
     * is the only layer able to hold a real JavaScript value (an Embind `val`
     * cannot be handed to JavaScript library code).  The bridge therefore
     * exchanges an opaque token: the TypeScript layer stores the object and the
     * facade binds the token to a logical path.
     */
    CodeResult registerPort(const std::string &logicalPath, int portToken)
    {
        webserial_clear_error();

        if (logicalPath.empty() || portToken <= 0)
        {
            return failure<CodeResult>(-RIG_EINVAL);
        }

        return status<CodeResult>(webserial_map_error(hamlibWsRegisterPort(logicalPath.c_str(), portToken)));
    }

    CodeResult unregisterPort(const std::string &logicalPath)
    {
        webserial_clear_error();

        if (logicalPath.empty()) { return failure<CodeResult>(-RIG_EINVAL); }

        return status<CodeResult>(webserial_map_error(hamlibWsUnregisterPort(logicalPath.c_str())));
    }

    OpenResult openRig(int modelId, const std::string &logicalPath,
                       int baudRate, const std::string &conf)
    {
        webserial_clear_error();

        int rc = RIG_OK;
        std::string message;
        RIG *rig = openOn(modelId, logicalPath, baudRate, conf, false, &rc, &message);

        if (!rig) { return failure<OpenResult>(rc, message); }

        OpenResult result = ok<OpenResult>();

        if (nextHandle_ >= kMaxHandle) { nextHandle_ = 1; }

        result.handle = nextHandle_++;
        rigs_[result.handle] = rig;
        return result;
    }

    /*
     * Open the rig at one rate only to find out whether it answers at all,
     * then close it again.
     *
     * `detectBaudRate` walks the rates a model declares, so a rate that
     * produces silence has to be cheap: the probe shortens the port timeout and
     * drops the retry counts, which the model's own values would otherwise
     * spend seconds on for every command of the open sequence.  A rate the rig
     * does answer at is unaffected in practice - it replies far inside the
     * probe's timeout.  The caller opens the rig for real with the rate found,
     * under the model's declared timeout and retries.
     */
    CodeResult probeBaudRate(int modelId, const std::string &logicalPath,
                             int baudRate, const std::string &conf)
    {
        webserial_clear_error();

        int rc = RIG_OK;
        std::string message;
        RIG *rig = openOn(modelId, logicalPath, baudRate, conf, true, &rc, &message);

        if (!rig) { return failure<CodeResult>(rc, message); }

        /* The probe owns nothing: whatever opened here closes here. */
        rig_close(rig);
        rig_cleanup(rig);

        return ok<CodeResult>();
    }

    CodeResult closeRig(int handle)
    {
        webserial_clear_error();

        RIG *rig = takeRig(handle);

        if (!rig)
        {
            /* Idempotent: closing an unknown handle is not an error. */
            return ok<CodeResult>();
        }

        int rc = rig_close(rig);

        /* rig_cleanup also closes the rig when necessary. */
        int rc2 = rig_cleanup(rig);

        return status<CodeResult>(rc == RIG_OK ? rc2 : rc);
    }

    /*
     * Release everything this module owns.
     *
     * dispose() closes the rigs and releases the ports it knows about; this is
     * the backstop: it closes anything still registered, clears the handle map
     * and empties the JavaScript port registry.  Wasm memory itself is
     * reclaimed when the module is collected - Emscripten has no unload - so
     * this is the deterministic part of teardown.
     */
    CodeResult destroy()
    {
        webserial_clear_error();

        for (std::map<int, RIG *>::iterator it = rigs_.begin(); it != rigs_.end(); ++it)
        {
            rig_close(it->second);
            rig_cleanup(it->second);
        }

        rigs_.clear();
        nextHandle_ = 1;

        /* Best effort by design: the ports belong to the caller and the
         * instance is being discarded. */
        hamlibWsForceCloseAll();

        return ok<CodeResult>();
    }

    /* RIG handles currently registered: a probe for the lifecycle tests. */
    int liveHandles() const
    {
        return (int) rigs_.size();
    }

    CodeResult setDebug(int level)
    {
        webserial_clear_error();

        if (level < RIG_DEBUG_NONE || level > RIG_DEBUG_CACHE)
        {
            return failure<CodeResult>(-RIG_EINVAL);
        }

        rig_set_debug_callback(forwardDebug, NULL);
        rig_set_debug((enum rig_debug_level_e) level);

        return ok<CodeResult>();
    }

    /*
     * What upstream's Morse worker does with one chunk: hand at most
     * morse_qsize characters to the backend's send_morse, and retry a refusal
     * that is not a bad argument (a rig whose keyer buffer is full) for up to
     * a second.  `checkMode` repeats rig_send_morse()'s own CW/CWR check, once
     * per message rather than once per chunk.
     */
    NumberResult sendMorse(int handle, const std::string &text, bool checkMode)
    {
        return withRig<NumberResult>(handle, [&](RIG *rig)
        {
            if (!rig->caps->send_morse) { return failure<NumberResult>(-RIG_ENAVAIL); }

            if (checkMode)
            {
                rmode_t mode = RIG_MODE_NONE;
                pbwidth_t width = 0;
                int rc = rig_get_mode(rig, RIG_VFO_CURR, &mode, &width);

                if (rc != RIG_OK) { return failure<NumberResult>(rc); }

                if ((mode & (RIG_MODE_CW | RIG_MODE_CWR)) == 0)
                {
                    return failure<NumberResult>(
                               -RIG_EINVAL,
                               std::string("the rig is in ") + rig_strrmode(mode)
                               + " mode; Morse needs CW or CWR");
                }
            }

            int size = rig->caps->morse_qsize > 0 ? rig->caps->morse_qsize : kDefaultMorseChunk;
            std::string chunk = text.substr(0, (size_t) size);
            int rc = RIG_OK;

            for (int attempt = 0; attempt < 10; ++attempt)
            {
                rc = rig->caps->send_morse(rig, RIG_VFO_CURR, chunk.c_str());

                if (rc == RIG_OK || rc == -RIG_EINVAL) { break; }

                hl_usleep(100 * 1000);
            }

            if (rc != RIG_OK) { return failure<NumberResult>(rc); }

            NumberResult result = ok<NumberResult>();
            result.value = (double) chunk.size();
            return result;
        });
    }

    CodeResult stopMorse(int handle)
    {
        return withRig<CodeResult>(handle, [&](RIG *rig)
        {
            if (!rig->caps->stop_morse) { return failure<CodeResult>(-RIG_ENAVAIL); }

            return status<CodeResult>(rig->caps->stop_morse(rig, RIG_VFO_CURR));
        });
    }

    /*
     * rig_send_raw() with hex on both sides.  A terminator reads up to it
     * (0xfd reads one Icom frame); otherwise `replyLength` bytes are read
     * exactly.  Upstream refuses a reply that fills `reply_len`, so the
     * buffer handed in is always one byte longer than the reply wanted.
     */
    TextResult sendRaw(int handle, const std::string &data, int terminator, int replyLength)
    {
        return withRig<TextResult>(handle, [&](RIG *rig)
        {
            std::vector<unsigned char> bytes;

            if (!hexToBytes(data, &bytes) || bytes.empty()
                    || terminator > 0xff || replyLength < 0 || replyLength > kMaxRawReply)
            {
                return failure<TextResult>(-RIG_EINVAL);
            }

            unsigned char term = (unsigned char) (terminator < 0 ? 0 : terminator);
            bool reads = terminator >= 0 || replyLength > 0;
            int length = terminator >= 0 ? kMaxRawReply + 1 : replyLength + 1;
            std::vector<unsigned char> reply((size_t) length, 0);

            int rc = rig_send_raw(rig, bytes.data(), (int) bytes.size(),
                                  reads ? reply.data() : NULL, length,
                                  terminator >= 0 ? &term : NULL);

            if (rc < 0) { return failure<TextResult>(rc); }

            TextResult result = ok<TextResult>();
            result.value = reads ? bytesToHex(reply.data(), rc) : std::string();
            return result;
        });
    }

    PttResult getPtt(int handle)
    {
        return withRig<PttResult>(handle, [&](RIG *rig)
        {
            ptt_t ptt = RIG_PTT_OFF;
            int rc = rig_get_ptt(rig, RIG_VFO_CURR, &ptt);

            if (rc != RIG_OK) { return failure<PttResult>(rc); }

            const char *name = strPttState(ptt);

            if (!name)
            {
                return failure<PttResult>(-RIG_EPROTO,
                                          "the rig reported PTT state " + std::to_string((int) ptt)
                                          + ", which Hamlib does not define");
            }

            PttResult result = ok<PttResult>();
            result.ptt = name;
            return result;
        });
    }

    PttResult setPtt(int handle, const std::string &state)
    {
        return withRig<PttResult>(handle, [&](RIG *rig)
        {
            ptt_t ptt = parsePttState(state.c_str());

            if (ptt == (ptt_t) -1) { return failure<PttResult>(-RIG_EINVAL); }

            int rc = rig_set_ptt(rig, RIG_VFO_CURR, ptt);

            if (rc != RIG_OK) { return failure<PttResult>(rc); }

            PttResult result = ok<PttResult>();
            result.ptt = state;
            return result;
        });
    }

    /*
     * Caller-buffer operation.  `rig_get_rig_info` takes a buffer whose length
     * is not implied by the signature, so the size is a facade decision here;
     * the returned string is what Hamlib wrote, null terminated.
     */
    TextResult getRigInfo(int handle)
    {
        return withRig<TextResult>(handle, [&](RIG *rig)
        {
            std::vector<char> buffer(kRigInfoBufferSize, '\0');
            int rc = rig_get_rig_info(rig, buffer.data(), (int) buffer.size());

            if (rc != RIG_OK) { return failure<TextResult>(rc); }

            TextResult result = ok<TextResult>();
            result.value = std::string(buffer.data());
            return result;
        });
    }

    NumberResult getExtLevel(int handle, double token)
    {
        return getExt(handle, token, [](RIG *rig, hamlib_token_t tok, value_t *value)
        {
            return rig_get_ext_level(rig, RIG_VFO_CURR, tok, value);
        });
    }

    CodeResult setExtLevel(int handle, double token, double value)
    {
        return setExt(handle, token, value, [](RIG *rig, hamlib_token_t tok, value_t packed)
        {
            return rig_set_ext_level(rig, RIG_VFO_CURR, tok, packed);
        });
    }

    NumberResult getExtParm(int handle, double token)
    {
        return getExt(handle, token, rig_get_ext_parm);
    }

    CodeResult setExtParm(int handle, double token, double value)
    {
        return setExt(handle, token, value, rig_set_ext_parm);
    }

    /*
     * Table walkers.  The callback only appends to a vector that is returned
     * after the walk, so nothing has to re-enter JavaScript from inside a
     * native call: the caller drains the returned list.
     */
    std::vector<RigConfparams> tokenForeach(int handle)
    {
        return walkTable(handle, rig_token_foreach);
    }

    std::vector<RigConfparams> extLevelForeach(int handle)
    {
        return walkTable(handle, rig_ext_level_foreach);
    }

    std::vector<RigConfparams> extFuncForeach(int handle)
    {
        return walkTable(handle, rig_ext_func_foreach);
    }

    std::vector<RigConfparams> extParmForeach(int handle)
    {
        return walkTable(handle, rig_ext_parm_foreach);
    }

private:
    /* Foreach callbacks return a positive value to keep iterating. */
    static int collectConfparam(const struct confparams *cfp, rig_ptr_t data)
    {
        static_cast<std::vector<RigConfparams> *>(data)->push_back(projectRigConfparams(*cfp));
        return 1;
    }

    static int collectConfparam(RIG *, const struct confparams *cfp, rig_ptr_t data)
    {
        return collectConfparam(cfp, data);
    }

    /*
     * Walk one of Hamlib's parameter tables into a vector.  A vector cannot
     * carry a result code, so an unknown handle walks nothing; the TypeScript
     * layer never calls a walker on a closed rig.
     */
    template <typename Callback>
    std::vector<RigConfparams> walkTable(int handle, int (*foreach)(RIG *, Callback, rig_ptr_t))
    {
        webserial_clear_error();

        std::vector<RigConfparams> entries;
        RIG *rig = lookupRig(handle);

        if (rig) { foreach(rig, collectConfparam, &entries); }

        return entries;
    }

    /*
     * Extended levels and parameters carry a `value_t` whose union member
     * follows the token's `confparams.type` at runtime, not a compile-time
     * predicate: numeric tokens are floats, everything else is an integer.
     * This is the same rule Hamlib's own `rigctl` uses.
     */
    template <typename Get>
    NumberResult getExt(int handle, double token, Get get)
    {
        return withRig<NumberResult>(handle, [&](RIG *rig)
        {
            hamlib_token_t tok;

            if (!fromNumber(token, &tok)) { return failure<NumberResult>(-RIG_EINVAL); }

            value_t value{};
            int rc = get(rig, tok, &value);

            if (rc != RIG_OK) { return failure<NumberResult>(rc); }

            NumberResult result = ok<NumberResult>();
            result.value = extValueIsFloat(rig, tok) ? (double) value.f : (double) value.i;
            return result;
        });
    }

    template <typename Set>
    CodeResult setExt(int handle, double token, double value, Set set)
    {
        return withRig<CodeResult>(handle, [&](RIG *rig)
        {
            hamlib_token_t tok;

            if (!fromNumber(token, &tok)) { return failure<CodeResult>(-RIG_EINVAL); }

            value_t packed{};

            if (extValueIsFloat(rig, tok)) { packed.f = (float) value; }
            else if (!fromNumber(value, &packed.i)) { return failure<CodeResult>(-RIG_EINVAL); }

            return status<CodeResult>(set(rig, tok, packed));
        });
    }

    /* Fixed size for the caller-buffer operation, sized to hold the largest
     * response Hamlib builds for a serial backend. */
    static const int kRigInfoBufferSize = 16384;

    /* A numeric extended token stores its value in `.f`; everything else
     * (checkbutton, combo, integer) stores it in `.i`. */
    static bool extValueIsFloat(RIG *rig, hamlib_token_t token)
    {
        const struct confparams *cfp = rig_ext_lookup_tok(rig, token);

        return cfp != NULL && cfp->type == RIG_CONF_NUMERIC;
    }

    /* Set one named Hamlib configuration value through the public API. */
    static int setConf(RIG *rig, const char *name, const std::string &value)
    {
        hamlib_token_t token = rig_token_lookup(rig, name);

        if (token == RIG_CONF_END) { return -RIG_EINVAL; }

        return rig_set_conf(rig, token, value.c_str());
    }

    /* Read one named Hamlib configuration value through the public API. */
    static int getConf(RIG *rig, const char *name, std::string *value)
    {
        hamlib_token_t token = rig_token_lookup(rig, name);

        if (token == RIG_CONF_END) { return -RIG_EINVAL; }

        char text[64] = "";
        int rc = rig_get_conf2(rig, token, text, (int) sizeof(text));

        *value = text;
        return rc;
    }

    /* Whether the facade sets `name` itself (ownedConf in hamlib.config.yaml). */
    static bool facadeOwnsConf(const std::string &name)
    {
        for (const char *owned : kOwnedConf)
        {
            if (name == owned) { return true; }
        }

        return false;
    }

    /*
     * Apply `name=value` lines, one token per line.  An unknown name, or a
     * value the backend refuses, fails the open with a message naming it.
     */
    static int applyConf(RIG *rig, const std::string &conf, std::string *message)
    {
        size_t start = 0;

        while (start < conf.size())
        {
            size_t end = conf.find('\n', start);

            if (end == std::string::npos) { end = conf.size(); }

            std::string line = conf.substr(start, end - start);
            start = end + 1;

            if (line.empty()) { continue; }

            size_t equals = line.find('=');
            std::string name = line.substr(0, equals);
            std::string value = equals == std::string::npos ? "" : line.substr(equals + 1);

            if (facadeOwnsConf(name))
            {
                *message = "config token \"" + name + "\" is set by hamlib-wasm itself";
                return -RIG_EINVAL;
            }

            if (rig_token_lookup(rig, name.c_str()) == RIG_CONF_END)
            {
                *message = "unknown config token \"" + name + "\" for "
                           + rig->caps->mfg_name + " " + rig->caps->model_name;
                return -RIG_EINVAL;
            }

            int rc = setConf(rig, name.c_str(), value);

            if (rc != RIG_OK)
            {
                *message = "config token \"" + name + "\" refused the value \""
                           + value + "\"";
                return rc;
            }
        }

        return RIG_OK;
    }

    /*
     * rig_init() -> configure through the public token interface -> rig_open()
     * -> make sure the rig answered.
     *
     * Returns the open rig, or NULL with `*code` set, and `*message` when the
     * failure needs more words than the transport has; whatever was opened is
     * closed again.  `probe` shortens the port budget for the baud-rate
     * search; see probeBaudRate().
     */
    static RIG *openOn(int modelId, const std::string &logicalPath, int baudRate,
                       const std::string &conf, bool probe, int *code,
                       std::string *message)
    {
        *code = RIG_OK;

        /* 0 means "the model's own default rate"; anything else has to be a
         * rate and a path this transport can use. */
        if (logicalPath.empty() || baudRate < 0)
        {
            *code = -RIG_EINVAL;
            return NULL;
        }

        const struct rig_caps *caps = rig_get_caps((rig_model_t) modelId);

        if (!caps || caps->port_type != RIG_PORT_SERIAL)
        {
            *code = -RIG_EINVAL;
            return NULL;
        }

        RIG *rig = rig_init((rig_model_t) modelId);

        if (!rig)
        {
            *code = -RIG_EINVAL;
            return NULL;
        }

        /*
         * Point the rig at the browser transport and disable everything that
         * would need a second thread, through Hamlib's public configuration
         * interface.  rig_open() copies the CAT pathname onto a serial
         * RTS/DTR PTT line and a serial DCD line that has none of its own.
         */
        int rc = setConf(rig, "rig_pathname", logicalPath);

        if (rc == RIG_OK) { rc = setConf(rig, "async", "0"); }

        /*
         * poll_interval has to be zero: rig_open() would otherwise try to
         * start the polling thread, which cannot exist here.  Hamlib makes
         * that token also set the level cache timeout, so the timeout
         * rig_init() chose is read first and restored right after - the
         * setters rely on it to keep a read-after-write coherent.
         */
        std::string cacheTimeout;

        if (rc == RIG_OK) { rc = getConf(rig, "cache_timeout", &cacheTimeout); }

        if (rc == RIG_OK) { rc = setConf(rig, "poll_interval", "0"); }

        if (rc == RIG_OK) { rc = setConf(rig, "cache_timeout", cacheTimeout); }

        if (rc == RIG_OK) { rc = setConf(rig, "auto_power_on", "0"); }

        if (rc == RIG_OK) { rc = setConf(rig, "auto_power_off", "0"); }

        if (rc == RIG_OK && baudRate > 0)
        {
            rc = setConf(rig, "serial_speed", std::to_string(baudRate));
        }

        /* The caller's tokens, after the facade's own so none of those can be
         * undone, and before the probe budget so a search stays short.  The
         * TypeScript layer has already refused the tokens the facade owns. */
        if (rc == RIG_OK) { rc = applyConf(rig, conf, message); }

        if (probe)
        {
            /* One attempt per command, and the shortened timeout above: a
             * candidate that produces silence then costs a fraction of the
             * model's declared retry budget instead of all of it. */
            rc = rc == RIG_OK ? setConf(rig, "timeout", std::to_string(kProbeTimeoutMs)) : rc;
            rc = rc == RIG_OK ? setConf(rig, "retry", "0") : rc;
            rc = rc == RIG_OK ? setConf(rig, "timeout_retry", "0") : rc;
        }

        if (rc != RIG_OK)
        {
            rig_cleanup(rig);
            *code = rc;
            return NULL;
        }

        rc = rig_open(rig);

        if (rc != RIG_OK)
        {
            /* Upstream closes the ports it opened; rig_close() is the public
             * way to be sure, and rig_cleanup() frees the handle either way. */
            rig_close(rig);
            rig_cleanup(rig);
            *code = rc;
            return NULL;
        }

        if (!rigAnswered(caps, logicalPath))
        {
            rig_close(rig);
            rig_cleanup(rig);
            *code = -RIG_ETIMEOUT;
            *message = unreachableMessage(caps, logicalPath, baudRate);
            return NULL;
        }

        return rig;
    }

    /*
     * Whether the rig that just opened has answered at all.
     *
     * rig_open() reads the rig's state and throws the result away ("if they
     * don't succeed, so be it"), so a line that never answered - wrong baud
     * rate, wrong port, rig switched off - comes back as a successfully opened
     * rig, and every later call fails with a message that names neither the
     * rate nor the reason.  A model whose open performs that state read (it has
     * get_freq) has written at least one command by now, so a rig that is
     * really there has sent something back.  When the transport has seen not a
     * single byte on this path, the port opened but no rig did.
     */
    static bool rigAnswered(const struct rig_caps *caps,
                            const std::string &logicalPath)
    {
        return !caps->get_freq || webserial_rx_bytes(logicalPath.c_str()) != 0;
    }

    /** The failure message for a rig that never answered. */
    static std::string unreachableMessage(const struct rig_caps *caps,
                                          const std::string &logicalPath,
                                          int baudRate)
    {
        int rate = baudRate > 0 ? baudRate : caps->serial_rate_max;

        return "no reply from " + std::string(caps->mfg_name) + " "
               + caps->model_name + " at " + std::to_string(rate)
               + " baud on " + logicalPath + ": the port opened, but "
               + "nothing arrived.  The model advertises "
               + std::to_string(caps->serial_rate_min) + "-"
               + std::to_string(caps->serial_rate_max)
               + " baud; check the rig's CAT rate, that it is switched on, "
               + "and that the right serial port was granted.";
    }

    /* A successful result: every field value-initialized, the code RIG_OK. */
    template <typename T>
    static T ok()
    {
        T result{};
        result.code = RIG_OK;
        return result;
    }

    /*
     * The prologue every rig operation shares: forget the last transport
     * error, resolve the handle, and fail with -RIG_EINVAL when it names no
     * open rig.  `body` runs with the rig and returns the result.
     */
    /* The result of a call that only reports a Hamlib code. */
    template <typename T>
    T status(int code) const
    {
        return code == RIG_OK ? ok<T>() : failure<T>(code);
    }

    template <typename T, typename Body>
    T withRig(int handle, Body body)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<T>(-RIG_EINVAL); }

        return body(rig);
    }

    template <typename T>
    T failure(int code) const
    {
        /* Value-initialize: on the failure path only `code` and `error` carry
         * information, but every other field still crosses the Embind boundary
         * and must not hold an indeterminate value. */
        T result{};
        result.code = code;
        result.error = takeTransportError();
        return result;
    }

    /* Failure with a message the transport cannot supply, such as a rig that
     * never answered at all; without one, the transport's own. */
    template <typename T>
    T failure(int code, const std::string &message) const
    {
        if (message.empty()) { return failure<T>(code); }

        T result{};
        result.code = code;
        result.error = message;
        return result;
    }

    RIG *lookupRig(int handle) const
    {
        std::map<int, RIG *>::const_iterator it = rigs_.find(handle);

        if (it == rigs_.end()) { return NULL; }

        return it->second;
    }

    RIG *takeRig(int handle)
    {
        RIG *rig = lookupRig(handle);

        if (rig) { rigs_.erase(handle); }

        return rig;
    }

    std::map<int, RIG *> rigs_;
    unsigned int nextHandle_ = 1;
    bool backendsLoaded_ = false;
};

Facade &facade()
{
    static Facade instance;
    return instance;
}

} // namespace

/* --------------------------------------------------------------------- */
/* bindings                                                              */
/* --------------------------------------------------------------------- */

/*
 * The value-object and function registrations are generated from
 * hamlib.config.yaml by packages/hamlib-codegen.  Editing the config and
 * running `mise run generate` is the only supported way to add or change an
 * operation.
 */
EMSCRIPTEN_BINDINGS(hamlib_wasm)
{
#include "generated/embind.inc"
}
