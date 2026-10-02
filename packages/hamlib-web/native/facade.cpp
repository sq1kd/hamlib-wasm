/*
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
 * Provenance: project-owned code, UNLICENSED.  Hamlib itself remains
 * LGPL-2.1-or-later and is linked in statically.
 */

#include <algorithm>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <emscripten/bind.h>

#include "hamlib/rig.h"

#include "web_serial.h"

/* --------------------------------------------------------------------- */
/* value objects                                                         */
/* --------------------------------------------------------------------- */

struct ModelInfo
{
    int id;
    std::string manufacturer;
    std::string model;
    std::string backendVersion;
    int status;
    int serialRateMin;
    int serialRateMax;
    int serialDataBits;
    int serialStopBits;
    std::string serialParity;
    std::string serialHandshake;
    bool canGetFrequency;
    bool canSetFrequency;
    bool canGetMode;
    bool canSetMode;
    bool canGetPtt;
    bool canSetPtt;
};

struct CodeResult
{
    int code;
    std::string error;
};

struct OpenResult
{
    int code;
    int handle;
    std::string error;
};

struct PttResult
{
    int code;
    std::string ptt;
    std::string error;
};

/*
 * Result value objects for the mechanically generated getters.  Regenerated
 * from hamlib.config.yaml and the upstream AST; see packages/hamlib-codegen.
 */
#include "generated/results.inc"

/* --------------------------------------------------------------------- */
/* JavaScript registry access                                            */
/* --------------------------------------------------------------------- */

/*
 * The SerialPort object itself is stored by the JavaScript transport, which
 * is the only layer able to hold a real JavaScript value (an Embind `val`
 * cannot be handed to JavaScript library code).  The bridge therefore
 * exchanges an opaque token: the TypeScript layer stores the object and the
 * facade binds the token to a logical path.
 */
extern "C"
{
    int hamlibWsRegisterPort(const char *path, int token);
    int hamlibWsUnregisterPort(const char *path);
}

namespace
{

const unsigned int kMaxHandle = 0x7fffffffU;

std::string takeTransportError()
{
    const char *why = webserial_last_error();

    if (!why) { return std::string(); }

    return std::string(why);
}

std::string pttToString(ptt_t ptt)
{
    switch (ptt)
    {
    case RIG_PTT_ON:
        return "on";

    case RIG_PTT_ON_MIC:
        return "on-mic";

    case RIG_PTT_ON_DATA:
        return "on-data";

    case RIG_PTT_OFF:
    default:
        return "off";
    }
}

bool stringToPtt(const std::string &value, ptt_t *ptt)
{
    if (value == "off")
    {
        *ptt = RIG_PTT_OFF;
    }
    else if (value == "on")
    {
        *ptt = RIG_PTT_ON;
    }
    else if (value == "on-mic")
    {
        *ptt = RIG_PTT_ON_MIC;
    }
    else if (value == "on-data")
    {
        *ptt = RIG_PTT_ON_DATA;
    }
    else
    {
        return false;
    }

    return true;
}

/* The declared line settings travel as names, not Hamlib enum values, so the
 * public TypeScript API never exposes an upstream enum. */
std::string parityToString(enum serial_parity_e parity)
{
    switch (parity)
    {
    case RIG_PARITY_ODD:
        return "odd";

    case RIG_PARITY_EVEN:
        return "even";

    case RIG_PARITY_MARK:
        return "mark";

    case RIG_PARITY_SPACE:
        return "space";

    case RIG_PARITY_NONE:
    default:
        return "none";
    }
}

std::string handshakeToString(enum serial_handshake_e handshake)
{
    switch (handshake)
    {
    case RIG_HANDSHAKE_XONXOFF:
        return "xon-xoff";

    case RIG_HANDSHAKE_HARDWARE:
        return "hardware";

    case RIG_HANDSHAKE_NONE:
    default:
        return "none";
    }
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
    info.serialParity = parityToString(caps->serial_parity);
    info.serialHandshake = handshakeToString(caps->serial_handshake);
    info.canGetFrequency = caps->get_freq != NULL;
    info.canSetFrequency = caps->set_freq != NULL;
    info.canGetMode = caps->get_mode != NULL;
    info.canSetMode = caps->set_mode != NULL;
    info.canGetPtt = caps->get_ptt != NULL || serialPttCapable(caps->ptt_type);
    info.canSetPtt = caps->set_ptt != NULL || serialPttCapable(caps->ptt_type);

    models->push_back(info);
    return 1;
}

/* Hamlib's own default for the level cache (rig_init: cachep->timeout_ms). */
const char *kDefaultCacheTimeoutMs = "500";

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

            if (rc != RIG_OK)
            {
                return failure<CodeResult>(rc);
            }

            backendsLoaded_ = true;
        }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    std::string version()
    {
        const char *value = rig_version();
        return value ? std::string(value) : std::string();
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

    CodeResult registerPort(const std::string &logicalPath, int portToken)
    {
        webserial_clear_error();

        if (logicalPath.empty() || portToken <= 0)
        {
            return failure<CodeResult>(-RIG_EINVAL);
        }

        int rc = hamlibWsRegisterPort(logicalPath.c_str(), portToken);

        if (rc != WS_OK) { return failure<CodeResult>(mapTransport(rc)); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    CodeResult unregisterPort(const std::string &logicalPath)
    {
        webserial_clear_error();

        if (logicalPath.empty()) { return failure<CodeResult>(-RIG_EINVAL); }

        int rc = hamlibWsUnregisterPort(logicalPath.c_str());

        if (rc != WS_OK) { return failure<CodeResult>(mapTransport(rc)); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    OpenResult openRig(int modelId, const std::string &logicalPath,
                       int baudRate)
    {
        webserial_clear_error();

        OpenResult result;
        result.code = RIG_OK;
        result.handle = 0;

        if (logicalPath.empty() || baudRate < 0)
        {
            return failure<OpenResult>(-RIG_EINVAL);
        }

        const struct rig_caps *caps = rig_get_caps((rig_model_t) modelId);

        if (!caps || caps->port_type != RIG_PORT_SERIAL)
        {
            return failure<OpenResult>(-RIG_EINVAL);
        }

        RIG *rig = rig_init((rig_model_t) modelId);

        if (!rig) { return failure<OpenResult>(-RIG_EINVAL); }

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
         * that token also set the level cache timeout, so the cache is
         * restored to its default right away - the setters rely on it to keep
         * a read-after-write coherent.
         */
        if (rc == RIG_OK) { rc = setConf(rig, "poll_interval", "0"); }

        if (rc == RIG_OK) { rc = setConf(rig, "cache_timeout", kDefaultCacheTimeoutMs); }

        if (rc == RIG_OK) { rc = setConf(rig, "auto_power_on", "0"); }

        if (rc == RIG_OK) { rc = setConf(rig, "auto_power_off", "0"); }

        if (rc == RIG_OK && baudRate > 0)
        {
            rc = setConf(rig, "serial_speed", std::to_string(baudRate));
        }

        if (rc != RIG_OK)
        {
            rig_cleanup(rig);
            return failure<OpenResult>(rc);
        }

        rc = rig_open(rig);

        if (rc != RIG_OK)
        {
            /* Upstream closes the ports it opened; rig_close() is the public
             * way to be sure, and rig_cleanup() frees the handle either way. */
            rig_close(rig);
            rig_cleanup(rig);
            return failure<OpenResult>(rc);
        }

        if (nextHandle_ >= kMaxHandle) { nextHandle_ = 1; }

        result.code = RIG_OK;
        result.handle = nextHandle_++;
        rigs_[result.handle] = rig;
        return result;
    }

    CodeResult closeRig(int handle)
    {
        webserial_clear_error();

        RIG *rig = takeRig(handle);

        if (!rig)
        {
            /* Idempotent: closing an unknown handle is not an error. */
            CodeResult result;
            result.code = RIG_OK;
            return result;
        }

        int rc = rig_close(rig);

        /* rig_cleanup also closes the rig when necessary. */
        int rc2 = rig_cleanup(rig);

        if (rc == RIG_OK) { rc = rc2; }

        if (rc != RIG_OK) { return failure<CodeResult>(rc); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    PttResult getPtt(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<PttResult>(-RIG_EINVAL); }

        ptt_t ptt = RIG_PTT_OFF;
        int rc = rig_get_ptt(rig, RIG_VFO_CURR, &ptt);

        if (rc != RIG_OK) { return failure<PttResult>(rc); }

        PttResult result;
        result.code = RIG_OK;
        result.ptt = pttToString(ptt);
        return result;
    }

    PttResult setPtt(int handle, const std::string &state)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<PttResult>(-RIG_EINVAL); }

        ptt_t ptt;

        if (!stringToPtt(state, &ptt)) { return failure<PttResult>(-RIG_EINVAL); }

        int rc = rig_set_ptt(rig, RIG_VFO_CURR, ptt);

        if (rc != RIG_OK) { return failure<PttResult>(rc); }

        PttResult result;
        result.code = RIG_OK;
        result.ptt = pttToString(ptt);
        return result;
    }

    /*
     * Caller-buffer operations.  `rig_get_rig_info` and `rig_get_vfo_list` take
     * a buffer whose length is not implied by the signature, so the size is a
     * facade decision here; the returned string is what Hamlib wrote, null
     * terminated.
     */
    TextResult getRigInfo(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<TextResult>(-RIG_EINVAL); }

        std::vector<char> buffer(kRigInfoBufferSize, '\0');
        int rc = rig_get_rig_info(rig, buffer.data(), (int) buffer.size());

        if (rc != RIG_OK) { return failure<TextResult>(rc); }

        TextResult result;
        result.code = RIG_OK;
        result.value = std::string(buffer.data());
        return result;
    }

    TextResult getVfoList(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<TextResult>(-RIG_EINVAL); }

        std::vector<char> buffer(kVfoListBufferSize, '\0');
        int rc = rig_get_vfo_list(rig, buffer.data(), (int) buffer.size());

        if (rc != RIG_OK) { return failure<TextResult>(rc); }

        TextResult result;
        result.code = RIG_OK;
        result.value = std::string(buffer.data());
        return result;
    }

    /*
     * Extended levels and parameters carry a `value_t` whose union member
     * follows the token's `confparams.type` at runtime, not a compile-time
     * predicate: numeric tokens are floats, everything else is an integer.
     * This is the same rule Hamlib's own `rigctl` uses.
     */
    NumberResult getExtLevel(int handle, double token)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<NumberResult>(-RIG_EINVAL); }

        hamlib_token_t tok = (hamlib_token_t) token;
        value_t value{};
        int rc = rig_get_ext_level(rig, RIG_VFO_CURR, tok, &value);

        if (rc != RIG_OK) { return failure<NumberResult>(rc); }

        NumberResult result;
        result.code = RIG_OK;
        result.value = extValueIsFloat(rig, tok) ? (double) value.f : (double) value.i;
        return result;
    }

    CodeResult setExtLevel(int handle, double token, double value)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<CodeResult>(-RIG_EINVAL); }

        hamlib_token_t tok = (hamlib_token_t) token;
        value_t packed{};

        if (extValueIsFloat(rig, tok)) { packed.f = (float) value; }
        else { packed.i = (int) value; }

        int rc = rig_set_ext_level(rig, RIG_VFO_CURR, tok, packed);

        if (rc != RIG_OK) { return failure<CodeResult>(rc); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    NumberResult getExtParm(int handle, double token)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<NumberResult>(-RIG_EINVAL); }

        hamlib_token_t tok = (hamlib_token_t) token;
        value_t value{};
        int rc = rig_get_ext_parm(rig, tok, &value);

        if (rc != RIG_OK) { return failure<NumberResult>(rc); }

        NumberResult result;
        result.code = RIG_OK;
        result.value = extValueIsFloat(rig, tok) ? (double) value.f : (double) value.i;
        return result;
    }

    CodeResult setExtParm(int handle, double token, double value)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<CodeResult>(-RIG_EINVAL); }

        hamlib_token_t tok = (hamlib_token_t) token;
        value_t packed{};

        if (extValueIsFloat(rig, tok)) { packed.f = (float) value; }
        else { packed.i = (int) value; }

        int rc = rig_set_ext_parm(rig, tok, packed);

        if (rc != RIG_OK) { return failure<CodeResult>(rc); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    /*
     * Table walkers.  The callback only appends to a vector that is returned
     * after the walk, so nothing has to re-enter JavaScript from inside a
     * native call: the caller drains the returned list.
     */
    std::vector<RigConfparams> tokenForeach(int handle)
    {
        webserial_clear_error();

        std::vector<RigConfparams> entries;
        RIG *rig = lookupRig(handle);

        if (!rig) { return entries; }

        rig_token_foreach(rig, collectTokenConfparam, &entries);
        return entries;
    }

    std::vector<RigConfparams> extLevelForeach(int handle)
    {
        webserial_clear_error();

        std::vector<RigConfparams> entries;
        RIG *rig = lookupRig(handle);

        if (!rig) { return entries; }

        rig_ext_level_foreach(rig, collectExtConfparam, &entries);
        return entries;
    }

    std::vector<RigConfparams> extFuncForeach(int handle)
    {
        webserial_clear_error();

        std::vector<RigConfparams> entries;
        RIG *rig = lookupRig(handle);

        if (!rig) { return entries; }

        rig_ext_func_foreach(rig, collectExtConfparam, &entries);
        return entries;
    }

    std::vector<RigConfparams> extParmForeach(int handle)
    {
        webserial_clear_error();

        std::vector<RigConfparams> entries;
        RIG *rig = lookupRig(handle);

        if (!rig) { return entries; }

        rig_ext_parm_foreach(rig, collectExtConfparam, &entries);
        return entries;
    }

private:
    static RigConfparams projectConfparam(const struct confparams *cfp)
    {
        RigConfparams entry{};
        entry.token = (double) cfp->token;
        entry.name = cfp->name ? cfp->name : "";
        entry.label = cfp->label ? cfp->label : "";
        entry.tooltip = cfp->tooltip ? cfp->tooltip : "";
        entry.dflt = cfp->dflt ? cfp->dflt : "";
        entry.type = (double) cfp->type;
        return entry;
    }

    /* Foreach callbacks return a positive value to keep iterating. */
    static int collectTokenConfparam(const struct confparams *cfp, rig_ptr_t data)
    {
        std::vector<RigConfparams> *entries = static_cast<std::vector<RigConfparams> *>(data);

        entries->push_back(projectConfparam(cfp));
        return 1;
    }

    static int collectExtConfparam(RIG *rig, const struct confparams *cfp, rig_ptr_t data)
    {
        (void) rig;
        std::vector<RigConfparams> *entries = static_cast<std::vector<RigConfparams> *>(data);

        entries->push_back(projectConfparam(cfp));
        return 1;
    }

    /* Fixed sizes for the two caller-buffer operations, sized to hold the
     * largest response Hamlib builds for a serial backend. */
    static const int kRigInfoBufferSize = 16384;
    static const int kVfoListBufferSize = 512;

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

    static int mapTransport(int rc)
    {
        switch (rc)
        {
        case WS_ERR_CONF:
            return -RIG_ECONF;

        case WS_ERR_INVAL:
            return -RIG_EINVAL;

        case WS_ERR_TIMEOUT:
            return -RIG_ETIMEOUT;

        case WS_ERR_ACCESS:
            return -RIG_EACCESS;

        case WS_ERR_BUSY:
            return -RIG_EACCESS;

        case WS_ERR_IO:
        default:
            return -RIG_EIO;
        }
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
EMSCRIPTEN_BINDINGS(hamlib_web)
{
#include "generated/embind.inc"
}
