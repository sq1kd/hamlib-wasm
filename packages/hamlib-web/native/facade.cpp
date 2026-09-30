/*
 * Narrow native facade for the Hamlib WebAssembly build.
 *
 * Everything the browser package may do is expressed here as Embind
 * operations that exchange only value objects and primitive integers.  No C
 * pointer, no Hamlib struct and no Wasm memory address ever crosses the
 * boundary; RIG objects live behind integer handles owned by this file.
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

/* The facade sits inside the build and needs Hamlib's internal port
 * accessors (RIGPORT/PTTPORT/DCDPORT) to point a rig at a logical path. */
#define IN_HAMLIB 1

#include "hamlib/rig.h"
#include "hamlib/rig_state.h"

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

struct FrequencyResult
{
    int code;
    double frequency;
    std::string error;
};

struct ModeResult
{
    int code;
    std::string mode;
    double passband;
    std::string error;
};

struct StatusResult
{
    int code;
    double frequency;
    std::string mode;
    double passband;
    std::string error;
};

struct PttResult
{
    int code;
    std::string ptt;
    std::string error;
};

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
    info.canGetFrequency = caps->get_freq != NULL;
    info.canSetFrequency = caps->set_freq != NULL;
    info.canGetMode = caps->get_mode != NULL;
    info.canSetMode = caps->set_mode != NULL;
    info.canGetPtt = caps->get_ptt != NULL || serialPttCapable(caps->ptt_type);
    info.canSetPtt = caps->set_ptt != NULL || serialPttCapable(caps->ptt_type);

    models->push_back(info);
    return 1;
}

class Facade
{
public:
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

        hamlib_port_t *port = RIGPORT(rig);
        hamlib_port_t *pttPort = &rig->state.pttport;
        hamlib_port_t *dcdPort = &rig->state.dcdport;

        std::strncpy(port->pathname, logicalPath.c_str(),
                     sizeof(port->pathname) - 1);
        port->pathname[sizeof(port->pathname) - 1] = '\0';

        /* A serial RTS/DTR PTT line and a serial DCD line live on the same
         * physical port, so they must use the same logical path. */
        if (serialPttCapable(caps->ptt_type))
        {
            std::strncpy(pttPort->pathname, logicalPath.c_str(),
                         sizeof(pttPort->pathname) - 1);
            pttPort->pathname[sizeof(pttPort->pathname) - 1] = '\0';
        }

        if (serialDcdCapable(caps->dcd_type))
        {
            std::strncpy(dcdPort->pathname, logicalPath.c_str(),
                         sizeof(dcdPort->pathname) - 1);
            dcdPort->pathname[sizeof(dcdPort->pathname) - 1] = '\0';
        }

        /* The browser build has no threads: no async data handler, no polling
         * thread and no background Morse worker may be started. */
        rig->state.async_data_enabled = 0;
        rig->state.poll_interval = 0;
        port->asyncio = 0;
        pttPort->asyncio = 0;
        dcdPort->asyncio = 0;
        rig->state.auto_power_on = 0;
        rig->state.auto_power_off = 0;

        if (baudRate > 0)
        {
            /* Equivalent to rig_set_conf(TOK_SERIAL_SPEED): the token enum is
             * internal (src/token.h) and its only effect is assigning the port
             * baud rate, see conf.c frontend_set_conf(). */
            port->parm.serial.rate = baudRate;
            rig->state.rigport_deprecated.parm.serial.rate = baudRate;
        }

        /* rig_open() starts the optional async data handler, the Morse worker
         * thread and reads the rig's initial state unless Hamlib's exported
         * skip_init flag is set.  This build has no threads and no Morse
         * worker, so skip that startup work; rig_close()'s matching stop calls
         * are no-ops when a handler never started. */
        int rc;
        {
            const int savedSkipInit = skip_init;
            skip_init = 1;
            rc = rig_open(rig);
            skip_init = savedSkipInit;
        }

        if (rc != RIG_OK)
        {
            if (RIGPORT(rig)->fd != -1) { rig_close(rig); }

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

    FrequencyResult getFrequency(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<FrequencyResult>(-RIG_EINVAL); }

        freq_t frequency = 0;
        int rc = rig_get_freq(rig, RIG_VFO_CURR, &frequency);

        if (rc != RIG_OK) { return failure<FrequencyResult>(rc); }

        FrequencyResult result;
        result.code = RIG_OK;
        result.frequency = (double) frequency;
        return result;
    }

    CodeResult setFrequency(int handle, double frequency)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<CodeResult>(-RIG_EINVAL); }

        int rc = rig_set_freq(rig, RIG_VFO_CURR, (freq_t) frequency);

        if (rc != RIG_OK) { return failure<CodeResult>(rc); }

        CodeResult result;
        result.code = RIG_OK;
        return result;
    }

    ModeResult getMode(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<ModeResult>(-RIG_EINVAL); }

        rmode_t mode = RIG_MODE_NONE;
        pbwidth_t width = 0;
        int rc = rig_get_mode(rig, RIG_VFO_CURR, &mode, &width);

        if (rc != RIG_OK) { return failure<ModeResult>(rc); }

        ModeResult result;
        result.code = RIG_OK;
        result.mode = rig_strrmode(mode);
        result.passband = (double) width;
        return result;
    }

    ModeResult setMode(int handle, const std::string &mode, double passband)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<ModeResult>(-RIG_EINVAL); }

        rmode_t parsed = rig_parse_mode(mode.c_str());

        if (parsed == RIG_MODE_NONE) { return failure<ModeResult>(-RIG_EINVAL); }

        pbwidth_t width = (pbwidth_t) passband;

        if (width <= 0) { width = rig_passband_normal(rig, parsed); }

        int rc = rig_set_mode(rig, RIG_VFO_CURR, parsed, width);

        if (rc != RIG_OK) { return failure<ModeResult>(rc); }

        ModeResult result;
        result.code = RIG_OK;
        result.mode = rig_strrmode(parsed);
        result.passband = (double) width;
        return result;
    }

    StatusResult getStatus(int handle)
    {
        webserial_clear_error();

        RIG *rig = lookupRig(handle);

        if (!rig) { return failure<StatusResult>(-RIG_EINVAL); }

        freq_t frequency = 0;
        int rc = rig_get_freq(rig, RIG_VFO_CURR, &frequency);

        if (rc != RIG_OK) { return failure<StatusResult>(rc); }

        rmode_t mode = RIG_MODE_NONE;
        pbwidth_t width = 0;
        rc = rig_get_mode(rig, RIG_VFO_CURR, &mode, &width);

        if (rc != RIG_OK) { return failure<StatusResult>(rc); }

        StatusResult result;
        result.code = RIG_OK;
        result.frequency = (double) frequency;
        result.mode = rig_strrmode(mode);
        result.passband = (double) width;
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

private:
    template <typename T>
    T failure(int code) const
    {
        T result;
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

EMSCRIPTEN_BINDINGS(hamlib_web)
{
    emscripten::value_object<ModelInfo>("RigModelInfo")
    .field("id", &ModelInfo::id)
    .field("manufacturer", &ModelInfo::manufacturer)
    .field("model", &ModelInfo::model)
    .field("backendVersion", &ModelInfo::backendVersion)
    .field("status", &ModelInfo::status)
    .field("serialRateMin", &ModelInfo::serialRateMin)
    .field("serialRateMax", &ModelInfo::serialRateMax)
    .field("canGetFrequency", &ModelInfo::canGetFrequency)
    .field("canSetFrequency", &ModelInfo::canSetFrequency)
    .field("canGetMode", &ModelInfo::canGetMode)
    .field("canSetMode", &ModelInfo::canSetMode)
    .field("canGetPtt", &ModelInfo::canGetPtt)
    .field("canSetPtt", &ModelInfo::canSetPtt);
    emscripten::register_vector<ModelInfo>("RigModelList");

    emscripten::value_object<CodeResult>("CodeResult")
    .field("code", &CodeResult::code)
    .field("error", &CodeResult::error);

    emscripten::value_object<OpenResult>("OpenResult")
    .field("code", &OpenResult::code)
    .field("handle", &OpenResult::handle)
    .field("error", &OpenResult::error);

    emscripten::value_object<FrequencyResult>("FrequencyResult")
    .field("code", &FrequencyResult::code)
    .field("frequency", &FrequencyResult::frequency)
    .field("error", &FrequencyResult::error);

    emscripten::value_object<ModeResult>("ModeResult")
    .field("code", &ModeResult::code)
    .field("mode", &ModeResult::mode)
    .field("passband", &ModeResult::passband)
    .field("error", &ModeResult::error);

    emscripten::value_object<StatusResult>("StatusResult")
    .field("code", &StatusResult::code)
    .field("frequency", &StatusResult::frequency)
    .field("mode", &StatusResult::mode)
    .field("passband", &StatusResult::passband)
    .field("error", &StatusResult::error);

    emscripten::value_object<PttResult>("PttResult")
    .field("code", &PttResult::code)
    .field("ptt", &PttResult::ptt)
    .field("error", &PttResult::error);

    emscripten::function("initialize", +[]() { return facade().initialize(); });
    emscripten::function("version", +[]() { return facade().version(); });
    emscripten::function("listModels", +[]() { return facade().listModels(); });
    emscripten::function("registerPort",
                         +[](const std::string &path, int token)
    {
        return facade().registerPort(path, token);
    });
    emscripten::function("unregisterPort", +[](const std::string &path)
    {
        return facade().unregisterPort(path);
    });
    emscripten::function("openRig",
                         +[](int modelId, const std::string &path, int baudRate)
    {
        return facade().openRig(modelId, path, baudRate);
    });
    emscripten::function("closeRig", +[](int handle)
    {
        return facade().closeRig(handle);
    });
    emscripten::function("getStatus", +[](int handle)
    {
        return facade().getStatus(handle);
    });
    emscripten::function("getFrequency", +[](int handle)
    {
        return facade().getFrequency(handle);
    });
    emscripten::function("setFrequency", +[](int handle, double frequency)
    {
        return facade().setFrequency(handle, frequency);
    });
    emscripten::function("getMode", +[](int handle)
    {
        return facade().getMode(handle);
    });
    emscripten::function("setMode",
                         +[](int handle, const std::string &mode, double passband)
    {
        return facade().setMode(handle, mode, passband);
    });
    emscripten::function("getPtt", +[](int handle)
    {
        return facade().getPtt(handle);
    });
    emscripten::function("setPtt", +[](int handle, const std::string &state)
    {
        return facade().setPtt(handle, state);
    });
}
