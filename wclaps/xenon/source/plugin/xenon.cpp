// Xenon, a granular instrument as a WebCLAP. Grains read a mono sample, each with its own pitch, envelope, filter
// and place in 3D (interaural time and level, head shadow, elevation tilt, distance, a shared room). openDAW shows
// the page in its device panel (feature "opendaw:device-panel", extension "opendaw.device-panel/1"), every host in
// the window. openDAW also keeps the sample in its project (extension "opendaw.samples/1", slot 0): the state then
// holds only its name, the host hands the frames over; other hosts get the sample in the state.

#include <clap/clap.h>
#include <clap/ext/draft/webview.h>
#include <clap/ext/draft/param-hovered.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>

extern "C" void emscripten_notify_memory_growth(size_t index) {(void) index;}

enum : clap_id {
    P_POSITION, P_SPRAY, P_SCAN, P_SIZE, P_DENSITY, P_SYNC, P_REVERSE, P_SHAPE,
    P_PITCH, P_FINE, P_PITCH_RANDOM, P_SCALE, P_KEY_TRACK, P_GLIDE,
    P_FILTER_TYPE, P_CUTOFF, P_RESONANCE, P_CUTOFF_RANDOM,
    P_AZIMUTH, P_SPREAD, P_ELEVATION, P_DISTANCE, P_DISTANCE_RANDOM, P_MOTION, P_ROOM, P_WIDTH,
    P_ATTACK, P_DECAY, P_SUSTAIN, P_RELEASE, P_VELOCITY, P_GAIN, P_VOICES, P_MODE,
    P_LFO1_RATE, P_LFO1_SHAPE, P_LFO2_RATE, P_LFO2_SHAPE, P_ENV2_ATTACK, P_ENV2_DECAY, P_ENV2_SUSTAIN, P_ENV2_RELEASE,
    PARAM_COUNT
};

enum Source {S_LFO1, S_LFO2, S_ENV1, S_ENV2, S_RANDOM, S_VELOCITY, S_NOTE, S_WHEEL, S_PRESSURE, S_AGE, SOURCE_COUNT};

enum Curve : uint8_t {LINEAR, EXPONENTIAL, STEPPED};

struct ParamDef {
    const char *name;
    const char *module;
    double min, max, value;
    Curve curve;
    bool modulatable;
};

// the page (page/index.html) keeps the same table, ids are the indices
static const ParamDef DEFS[PARAM_COUNT] = {
    {"Position", "Grain", 0.0, 1.0, 0.0, LINEAR, true},
    {"Spray", "Grain", 0.0, 1.0, 0.05, LINEAR, true},
    {"Scan", "Grain", -2.0, 2.0, 0.0, LINEAR, false},
    {"Size", "Grain", 1.0, 2000.0, 80.0, EXPONENTIAL, true},
    {"Density", "Grain", 0.5, 200.0, 20.0, EXPONENTIAL, true},
    {"Sync", "Grain", 0.0, 4.0, 0.0, STEPPED, false},
    {"Reverse", "Grain", 0.0, 1.0, 0.0, LINEAR, true},
    {"Shape", "Grain", 0.0, 1.0, 0.25, LINEAR, true},
    {"Pitch", "Pitch", -48.0, 48.0, 0.0, LINEAR, true},
    {"Fine", "Pitch", -100.0, 100.0, 0.0, LINEAR, true},
    {"Pitch Random", "Pitch", 0.0, 24.0, 0.0, LINEAR, true},
    {"Scale", "Pitch", 0.0, 4.0, 0.0, STEPPED, false},
    {"Key Track", "Pitch", 0.0, 1.0, 1.0, STEPPED, false},
    {"Glide", "Pitch", 0.0, 1000.0, 0.0, LINEAR, false},
    {"Filter Type", "Filter", 0.0, 2.0, 0.0, STEPPED, false},
    {"Cutoff", "Filter", 20.0, 20000.0, 20000.0, EXPONENTIAL, true},
    {"Resonance", "Filter", 0.0, 1.0, 0.1, LINEAR, true},
    {"Cutoff Random", "Filter", 0.0, 1.0, 0.0, LINEAR, true},
    {"Azimuth", "Space", -180.0, 180.0, 0.0, LINEAR, true},
    {"Spread", "Space", 0.0, 180.0, 30.0, LINEAR, true},
    {"Elevation", "Space", -90.0, 90.0, 0.0, LINEAR, true},
    {"Distance", "Space", 0.5, 30.0, 1.0, EXPONENTIAL, true},
    {"Distance Random", "Space", 0.0, 1.0, 0.0, LINEAR, true},
    {"Motion", "Space", 0.0, 1.0, 0.0, LINEAR, true},
    {"Room", "Space", 0.0, 1.0, 0.15, LINEAR, true},
    {"Width", "Space", 0.0, 1.0, 1.0, LINEAR, false},
    {"Attack", "Amp", 1.0, 5000.0, 10.0, EXPONENTIAL, false},
    {"Decay", "Amp", 1.0, 5000.0, 300.0, EXPONENTIAL, false},
    {"Sustain", "Amp", 0.0, 1.0, 1.0, LINEAR, false},
    {"Release", "Amp", 1.0, 8000.0, 600.0, EXPONENTIAL, false},
    {"Velocity", "Amp", 0.0, 1.0, 0.5, LINEAR, false},
    {"Gain", "Amp", -36.0, 12.0, 0.0, LINEAR, true},
    {"Voices", "Amp", 1.0, 16.0, 8.0, STEPPED, false},
    {"Mode", "Amp", 0.0, 1.0, 1.0, STEPPED, false},
    {"LFO 1 Rate", "Mod", 0.02, 20.0, 0.5, EXPONENTIAL, false},
    {"LFO 1 Shape", "Mod", 0.0, 4.0, 0.0, STEPPED, false},
    {"LFO 2 Rate", "Mod", 0.02, 20.0, 3.0, EXPONENTIAL, false},
    {"LFO 2 Shape", "Mod", 0.0, 4.0, 1.0, STEPPED, false},
    {"Env 2 Attack", "Mod", 1.0, 5000.0, 200.0, EXPONENTIAL, false},
    {"Env 2 Decay", "Mod", 1.0, 5000.0, 800.0, EXPONENTIAL, false},
    {"Env 2 Sustain", "Mod", 0.0, 1.0, 0.0, LINEAR, false},
    {"Env 2 Release", "Mod", 1.0, 8000.0, 600.0, EXPONENTIAL, false}
};

static const char *SYNC_TEXTS[] = {"OFF", "1/4", "1/8", "1/16", "1/32"};
static const char *SHAPE_TEXTS[] = {"GAUSS", "HANN", "TRI", "PERC", "SWELL"};
static const char *SCALE_TEXTS[] = {"OFF", "OCT", "5TH", "MAJ", "MIN"};
static const char *FILTER_TEXTS[] = {"LP", "BP", "HP"};
static const char *LFO_TEXTS[] = {"SIN", "TRI", "SAW", "SQR", "S&H"};
static const char *ONOFF_TEXTS[] = {"OFF", "ON"};
static const char *MODE_TEXTS[] = {"MONO", "POLY"};

#define MAX_VOICES 16
#define GRAIN_POOL 128
#define BLOCK 32
#define ITD_RING 256
#define PEAK_COLUMNS 2048
#define NAME_CAPACITY 128
#define MAX_SECONDS 60
#define OUT_EVENTS 128
#define GUI_WIDTH 512
#define GUI_HEIGHT 176
#define GUI_MIN_SCALE 1.0
#define GUI_MAX_SCALE 3.0
#define STATE_MAGIC 0x4e4f4e58u
#define STATE_VERSION 1u

// message types, see page/index.html
#define PAGE_POLL 1
#define PAGE_PARAM_BEGIN 2
#define PAGE_PARAM_SET 3
#define PAGE_PARAM_END 4
#define PAGE_MOD_SET 5
#define PAGE_SAMPLE_BEGIN 6
#define PAGE_HOVER 7
#define PAGE_SAMPLE_CHUNK 8
#define PAGE_SAMPLE_COMMIT 9
#define PAGE_SAMPLE_CLEAR 10
#define PAGE_REQUEST_PEAKS 11
#define PAGE_REQUEST_MODS 12
#define PAGE_SAMPLE_NAME 13
#define PLUGIN_STATUS 1
#define PLUGIN_PEAKS 2
#define PLUGIN_MODS 3
#define STATUS_HEADER 24
#define STATUS_GRAIN_FLOATS 5

#define OPENDAW_PLUGIN_FEATURE_DEVICE_PANEL "opendaw:device-panel"
#define OPENDAW_EXT_DEVICE_PANEL "opendaw.device-panel/1"
#define OPENDAW_EXT_SAMPLES "opendaw.samples/1"
#define MAX_HOST_SECONDS 600

// openDAW keeps the plugin's samples by key: the host's side says it does, the plugin's takes the frames
typedef struct opendaw_host_samples {
    bool (*available)(const clap_host_t *host);
} opendaw_host_samples_t;

typedef struct opendaw_plugin_samples {
    float *(*prepare)(const clap_plugin_t *plugin, uint32_t key, uint32_t frames, uint32_t channels, double rate);
    void (*commit)(const clap_plugin_t *plugin, uint32_t key);
    void (*clear)(const clap_plugin_t *plugin, uint32_t key);
} opendaw_plugin_samples_t;

typedef struct opendaw_plugin_device_panel {
    int32_t (*get_uri)(const clap_plugin_t *plugin, char *uri, uint32_t capacity);
    bool (*get_width)(const clap_plugin_t *plugin, uint32_t height, uint32_t *width);
} opendaw_plugin_device_panel_t;

static const double TAU = 6.283185307179586;

struct Sample {
    uint32_t frames;
    double rate;
    float *mono;
    int8_t peaks[PEAK_COLUMNS * 2];
    char name[NAME_CAPACITY];
};

struct Adsr {
    enum Stage : uint8_t {IDLE, ATTACK, DECAY, SUSTAIN, RELEASE} stage;
    double level;
};

struct Voice {
    bool active, gate;
    int key;
    double velocity, note, target, pressure;
    Adsr amp, mod;
    double countdown, scan;
    uint64_t started;
    float env[BLOCK];
};

struct Grain {
    bool active;
    int voice;
    double position, increment, length, age;
    double shape, gain, normal;
    double semitones, cutoff, resonance, azimuth, elevation, distance, room, turn;
    double age_semitones, age_octaves, age_resonance, age_azimuth, age_elevation, age_distance, age_gain;
    int filter;
    double rate_base;
    double ic1, ic2, air, tilt, shadow;
    float ring[ITD_RING];
    uint32_t ring_write;
    double svf_g, svf_k, air_coef, tilt_k, near_gain, far_gain, shadow_coef, itd, distance_gain, send;
    bool right_near;
};

struct OutEvent {
    uint16_t type;
    clap_id id;
    double value;
};

struct Room {
    float *lines[4];
    uint32_t lengths[4], index[4];
    float damp[4];
};

struct Xenon {
    clap_plugin_t plugin;
    const clap_host_t *host;
    const clap_host_params_t *host_params;
    const clap_host_state_t *host_state;
    const clap_host_webview_t *host_webview;
    const clap_host_param_hovered_t *host_hovered;
    double values[PARAM_COUNT];
    float depths[PARAM_COUNT][SOURCE_COUNT];
    double sample_rate;
    Voice voices[MAX_VOICES];
    Grain grains[GRAIN_POOL];
    Room room;
    Sample *current;
    std::atomic<Sample *> pending;
    std::atomic<Sample *> retired;
    Sample *latest;
    Sample *uploading;
    // openDAW keeps the sample (opendaw.samples/1): the state holds its name, the frames arrive in staging
    bool host_keeps, embedded;
    char host_name[NAME_CAPACITY];
    float *staging;
    uint32_t staging_frames, staging_channels;
    double staging_rate;
    uint32_t sample_generation, mod_generation;
    uint64_t clock;
    double lfo_phase[2], lfo_hold[2], lfo_value[2];
    double tempo, wheel, pressure;
    uint32_t random;
    bool held[128];
    uint64_t held_at[128];
    float live[PARAM_COUNT];
    uint32_t gui_width, gui_height;
    OutEvent out_events[OUT_EVENTS];
    uint32_t out_read, out_write;
    uint8_t *status;
};

static const char *features[] = {
    CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, CLAP_PLUGIN_FEATURE_SAMPLER,
    CLAP_PLUGIN_FEATURE_STEREO, OPENDAW_PLUGIN_FEATURE_DEVICE_PANEL, nullptr
};

static const clap_plugin_descriptor_t descriptor = {
    CLAP_VERSION_INIT,
    "studio.opendaw.commons.xenon",
    "Xenon",
    "openDAW Commons",
    "https://github.com/andremichelle/opendaw-commons/tree/main/wclaps/xenon",
    "",
    "",
    "1.0.0",
    "A granular synthesizer: grains with their own pitch, filter and place in 3D, a glowing waveform",
    features
};

static Xenon *xenon_of(const clap_plugin_t *plugin) {return static_cast<Xenon *>(plugin->plugin_data);}

static double clamp(double value, double min, double max) {return value < min ? min : value > max ? max : value;}

static double normalize(clap_id id, double value) {
    const ParamDef &def = DEFS[id];
    if (def.curve == EXPONENTIAL) {return std::log(clamp(value, def.min, def.max) / def.min) / std::log(def.max / def.min);}
    return (clamp(value, def.min, def.max) - def.min) / (def.max - def.min);
}

static double denormalize(clap_id id, double normal) {
    const ParamDef &def = DEFS[id];
    normal = clamp(normal, 0.0, 1.0);
    if (def.curve == EXPONENTIAL) {return def.min * std::pow(def.max / def.min, normal);}
    return def.min + normal * (def.max - def.min);
}

static double clamp_value(clap_id id, double value) {
    const ParamDef &def = DEFS[id];
    value = clamp(value, def.min, def.max);
    return def.curve == STEPPED ? std::round(value) : value;
}

static int stepped(const Xenon *xenon, clap_id id) {return static_cast<int>(std::lround(xenon->values[id]));}

static double next_random(Xenon *xenon) {
    uint32_t x = xenon->random;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    xenon->random = x;
    return static_cast<double>(x) / 4294967296.0;
}

static double bipolar(Xenon *xenon) {return next_random(xenon) * 2.0 - 1.0;}

// a target's value with every source applied in the normalized range
static double modulated(const Xenon *xenon, clap_id id, const double *sources) {
    double normal = normalize(id, xenon->values[id]);
    if (DEFS[id].modulatable) {
        for (int source = 0; source < SOURCE_COUNT; source++) {
            if (source != S_AGE) {normal += xenon->depths[id][source] * sources[source];}
        }
    }
    return denormalize(id, normal);
}

static double age_depth(const Xenon *xenon, clap_id id) {return xenon->depths[id][S_AGE];}

// ---- sample handoff: built on the main thread, swapped in on the audio thread, freed on the main thread ----

static Sample *sample_create(uint32_t frames, double rate, const char *name, uint32_t name_length) {
    Sample *sample = static_cast<Sample *>(std::calloc(1, sizeof(Sample)));
    if (sample == nullptr) {return nullptr;}
    sample->mono = static_cast<float *>(std::calloc(frames > 0 ? frames : 1, sizeof(float)));
    if (sample->mono == nullptr) {
        std::free(sample);
        return nullptr;
    }
    sample->frames = frames;
    sample->rate = rate;
    const uint32_t length = name_length < NAME_CAPACITY - 1 ? name_length : NAME_CAPACITY - 1;
    std::memcpy(sample->name, name, length);
    sample->name[length] = '\0';
    return sample;
}

static void sample_free(Sample *sample) {
    if (sample == nullptr) {return;}
    std::free(sample->mono);
    std::free(sample);
}

static void sample_peaks(Sample *sample) {
    for (uint32_t column = 0; column < PEAK_COLUMNS; column++) {
        const uint64_t from = static_cast<uint64_t>(column) * sample->frames / PEAK_COLUMNS;
        uint64_t to = static_cast<uint64_t>(column + 1) * sample->frames / PEAK_COLUMNS;
        if (to <= from) {to = from + 1;}
        float min = 0.0f, max = 0.0f;
        for (uint64_t index = from; index < to && index < sample->frames; index++) {
            const float value = sample->mono[index];
            if (value < min) {min = value;}
            if (value > max) {max = value;}
        }
        sample->peaks[column * 2] = static_cast<int8_t>(std::lround(clamp(min, -1.0, 1.0) * 127.0));
        sample->peaks[column * 2 + 1] = static_cast<int8_t>(std::lround(clamp(max, -1.0, 1.0) * 127.0));
    }
}

static void collect_retired(Xenon *xenon) {sample_free(xenon->retired.exchange(nullptr));}

static void publish(Xenon *xenon, Sample *sample) {
    collect_retired(xenon);
    xenon->latest = sample;
    sample_free(xenon->pending.exchange(sample));
    xenon->sample_generation++;
}

// an empty sample stands for "none", so the audio thread can tell a clear from nothing pending
static bool clear_sample(Xenon *xenon) {
    Sample *empty = sample_create(0, 48000.0, "", 0);
    if (empty == nullptr) {return false;}
    empty->frames = 0;
    publish(xenon, empty);
    xenon->latest = nullptr;
    return true;
}

static void swap_sample(Xenon *xenon) {
    if (xenon->pending.load() == nullptr || xenon->retired.load() != nullptr) {return;}
    Sample *next = xenon->pending.exchange(nullptr);
    if (next == nullptr) {return;}
    xenon->retired.store(xenon->current);
    xenon->current = next;
    for (Grain &grain: xenon->grains) {grain.active = false;}
}

// ---- envelopes and modulation sources ----

static void adsr_gate(Adsr &adsr, bool on) {adsr.stage = on ? Adsr::ATTACK : (adsr.stage == Adsr::IDLE ? Adsr::IDLE : Adsr::RELEASE);}

static double adsr_step(Adsr &adsr, double attack_ms, double decay_ms, double sustain, double release_ms, double rate) {
    switch (adsr.stage) {
        case Adsr::ATTACK:
            adsr.level += 1000.0 / (attack_ms * rate);
            if (adsr.level >= 1.0) {
                adsr.level = 1.0;
                adsr.stage = Adsr::DECAY;
            }
            break;
        case Adsr::DECAY:
            adsr.level += (sustain - adsr.level) * (1.0 - std::exp(-5000.0 / (decay_ms * rate)));
            if (std::fabs(adsr.level - sustain) < 1e-4) {
                adsr.level = sustain;
                adsr.stage = Adsr::SUSTAIN;
            }
            break;
        case Adsr::SUSTAIN:
            adsr.level = sustain;
            break;
        case Adsr::RELEASE:
            adsr.level *= std::exp(-5000.0 / (release_ms * rate));
            if (adsr.level < 1e-4) {
                adsr.level = 0.0;
                adsr.stage = Adsr::IDLE;
            }
            break;
        default:
            break;
    }
    return adsr.level;
}

static double lfo_wave(int shape, double phase, double hold) {
    switch (shape) {
        case 0: return std::sin(TAU * phase);
        case 1: return 1.0 - 4.0 * std::fabs(phase - 0.5);
        case 2: return 2.0 * phase - 1.0;
        case 3: return phase < 0.5 ? 1.0 : -1.0;
        default: return hold;
    }
}

static void advance_lfos(Xenon *xenon, uint32_t frames) {
    for (int index = 0; index < 2; index++) {
        const clap_id rate = index == 0 ? P_LFO1_RATE : P_LFO2_RATE;
        const clap_id shape = index == 0 ? P_LFO1_SHAPE : P_LFO2_SHAPE;
        double phase = xenon->lfo_phase[index] + xenon->values[rate] * frames / xenon->sample_rate;
        if (phase >= 1.0) {
            phase -= std::floor(phase);
            xenon->lfo_hold[index] = bipolar(xenon);
        }
        xenon->lfo_phase[index] = phase;
        xenon->lfo_value[index] = lfo_wave(stepped(xenon, shape), phase, xenon->lfo_hold[index]);
    }
}

static void voice_sources(const Xenon *xenon, const Voice &voice, double *sources) {
    sources[S_LFO1] = xenon->lfo_value[0];
    sources[S_LFO2] = xenon->lfo_value[1];
    sources[S_ENV1] = voice.amp.level;
    sources[S_ENV2] = voice.mod.level;
    sources[S_RANDOM] = 0.0;
    sources[S_VELOCITY] = voice.velocity;
    sources[S_NOTE] = (voice.note - 60.0) / 60.0;
    sources[S_WHEEL] = xenon->wheel;
    sources[S_PRESSURE] = voice.pressure > xenon->pressure ? voice.pressure : xenon->pressure;
    sources[S_AGE] = 0.0;
}

// ---- grains ----

static double window_of(int shape, double phase) {
    switch (shape) {
        case 0: {
            const double x = (phase - 0.5) / 0.16;
            return std::exp(-0.5 * x * x);
        }
        case 1: return 0.5 - 0.5 * std::cos(TAU * phase);
        case 2: return 1.0 - std::fabs(2.0 * phase - 1.0);
        case 3: return std::exp(-5.0 * phase) * clamp(phase * 30.0, 0.0, 1.0);
        default: return std::exp(-5.0 * (1.0 - phase)) * clamp((1.0 - phase) * 30.0, 0.0, 1.0);
    }
}

static double envelope(double shape, double phase) {
    const double scaled = clamp(shape, 0.0, 1.0) * 4.0;
    const int index = static_cast<int>(scaled);
    const double fraction = scaled - index;
    const double value = index >= 4 ? window_of(4, phase)
        : window_of(index, phase) * (1.0 - fraction) + window_of(index + 1, phase) * fraction;
    const double edge = clamp(phase * 100.0, 0.0, 1.0) * clamp((1.0 - phase) * 100.0, 0.0, 1.0);
    return value * edge;
}

static bool in_scale(int scale, int semitone) {
    const int degree = ((semitone % 12) + 12) % 12;
    switch (scale) {
        case 1: return degree == 0;
        case 2: return degree == 0 || degree == 7;
        case 3: return degree == 0 || degree == 2 || degree == 4 || degree == 5 || degree == 7 || degree == 9 || degree == 11;
        case 4: return degree == 0 || degree == 2 || degree == 3 || degree == 5 || degree == 7 || degree == 8 || degree == 10;
        default: return true;
    }
}

static double random_pitch(Xenon *xenon, double range, int scale) {
    if (range <= 0.0) {return 0.0;}
    if (scale == 0) {return bipolar(xenon) * range;}
    const int limit = static_cast<int>(std::floor(range));
    int count = 0;
    for (int semitone = -limit; semitone <= limit; semitone++) {if (in_scale(scale, semitone)) {count++;}}
    int pick = static_cast<int>(next_random(xenon) * count);
    for (int semitone = -limit; semitone <= limit; semitone++) {
        if (in_scale(scale, semitone) && pick-- == 0) {return semitone;}
    }
    return 0.0;
}

static double sync_interval(const Xenon *xenon) {
    static const double per_beat[] = {0.0, 1.0, 2.0, 4.0, 8.0};
    const int sync = stepped(xenon, P_SYNC);
    return xenon->sample_rate * 60.0 / (xenon->tempo > 1.0 ? xenon->tempo : 120.0) / per_beat[sync];
}

static double overlap_gain(double density, double size_ms) {
    const double overlap = density * size_ms * 0.001;
    return 1.0 / std::sqrt(overlap > 1.0 ? overlap : 1.0);
}

// the per-block spatial and filter coefficients from the grain's values at its age
static void grain_coefficients(Xenon *xenon, Grain &grain) {
    const double rate = xenon->sample_rate;
    const double age = grain.age > 0.0 ? grain.age : 0.0;
    const double phase = age / grain.length;
    const double seconds = age / rate;
    const double octaves = std::log2(DEFS[P_CUTOFF].max / DEFS[P_CUTOFF].min);
    const double cutoff = clamp(grain.cutoff * std::pow(2.0, grain.age_octaves * octaves * phase), 20.0, rate * 0.45);
    const double resonance = clamp(grain.resonance + grain.age_resonance * phase, 0.0, 1.0);
    grain.svf_g = std::tan(M_PI * cutoff / rate);
    grain.svf_k = 2.0 - 1.96 * resonance;
    const double azimuth = (grain.azimuth + grain.turn * seconds + grain.age_azimuth * 360.0 * phase) * M_PI / 180.0;
    const double elevation = clamp(grain.elevation + grain.age_elevation * 180.0 * phase, -90.0, 90.0) * M_PI / 180.0;
    const double distance = clamp(grain.distance * std::exp(grain.age_distance * std::log(60.0) * phase), 0.5, 30.0);
    const double lateral = std::sin(azimuth) * std::cos(elevation);
    const double side = std::fabs(lateral);
    grain.right_near = lateral >= 0.0;
    grain.itd = 0.0875 / 343.0 * (std::asin(side) + side) * rate;
    grain.near_gain = 1.0 + 0.15 * side;
    grain.far_gain = 1.0 - 0.35 * side;
    // fades in with the side, so a grain in the centre sounds the same on both ears
    grain.shadow_coef = clamp(side * 8.0, 0.0, 1.0) * std::exp(-TAU * clamp(20000.0 * std::pow(1200.0 / 20000.0, side), 20.0, rate * 0.45) / rate);
    grain.tilt_k = 0.6 * std::sin(elevation);
    const double air = clamp(20000.0 / (1.0 + 0.25 * (distance - 1.0 > 0.0 ? distance - 1.0 : 0.0)), 1000.0, rate * 0.45);
    grain.air_coef = std::exp(-TAU * air / rate);
    grain.distance_gain = 1.0 / (distance > 0.5 ? distance : 0.5);
    grain.send = grain.room * (0.3 + 0.7 * clamp(distance / 10.0, 0.0, 1.0));
    const double gain_db = grain.gain + grain.age_gain * 48.0 * phase;
    grain.rate_base = std::pow(2.0, (grain.semitones + grain.age_semitones * 96.0 * phase) / 12.0);
    grain.normal = std::pow(10.0, gain_db / 20.0);
}

static void spawn_grain(Xenon *xenon, int voice_index, uint32_t offset) {
    const Sample *sample = xenon->current;
    if (sample == nullptr || sample->frames < 4) {return;}
    Grain *grain = nullptr;
    for (Grain &candidate: xenon->grains) {
        if (!candidate.active) {
            grain = &candidate;
            break;
        }
    }
    if (grain == nullptr) {return;}
    const Voice &voice = xenon->voices[voice_index];
    double sources[SOURCE_COUNT];
    voice_sources(xenon, voice, sources);
    sources[S_RANDOM] = bipolar(xenon);
    const double position = modulated(xenon, P_POSITION, sources);
    const double spray = modulated(xenon, P_SPRAY, sources);
    double start = position + voice.scan + bipolar(xenon) * spray * 0.5;
    start -= std::floor(start);
    const double size_ms = modulated(xenon, P_SIZE, sources);
    const bool reverse = next_random(xenon) < modulated(xenon, P_REVERSE, sources);
    const double key = stepped(xenon, P_KEY_TRACK) == 1 ? voice.note - 60.0 : 0.0;
    std::memset(grain, 0, sizeof(Grain));
    grain->active = true;
    grain->voice = voice_index;
    grain->position = start * sample->frames;
    grain->length = size_ms * 0.001 * xenon->sample_rate;
    grain->age = -static_cast<double>(offset);
    grain->shape = modulated(xenon, P_SHAPE, sources);
    grain->semitones = modulated(xenon, P_PITCH, sources) + modulated(xenon, P_FINE, sources) * 0.01 + key
        + random_pitch(xenon, modulated(xenon, P_PITCH_RANDOM, sources), stepped(xenon, P_SCALE));
    grain->increment = (reverse ? -1.0 : 1.0) * sample->rate / xenon->sample_rate;
    grain->filter = stepped(xenon, P_FILTER_TYPE);
    grain->cutoff = modulated(xenon, P_CUTOFF, sources) * std::pow(2.0, modulated(xenon, P_CUTOFF_RANDOM, sources) * 4.0 * bipolar(xenon));
    grain->resonance = modulated(xenon, P_RESONANCE, sources);
    grain->azimuth = modulated(xenon, P_AZIMUTH, sources) + bipolar(xenon) * modulated(xenon, P_SPREAD, sources) * 0.5;
    grain->elevation = modulated(xenon, P_ELEVATION, sources);
    grain->distance = clamp(modulated(xenon, P_DISTANCE, sources)
        * std::exp(bipolar(xenon) * modulated(xenon, P_DISTANCE_RANDOM, sources) * std::log(4.0)), 0.5, 30.0);
    grain->turn = (next_random(xenon) < 0.5 ? -1.0 : 1.0) * modulated(xenon, P_MOTION, sources) * 360.0;
    grain->room = modulated(xenon, P_ROOM, sources);
    grain->gain = modulated(xenon, P_GAIN, sources);
    const double density = stepped(xenon, P_SYNC) > 0 ? xenon->sample_rate / sync_interval(xenon) : modulated(xenon, P_DENSITY, sources);
    grain->gain += 20.0 * std::log10(overlap_gain(density, size_ms));
    grain->age_semitones = age_depth(xenon, P_PITCH);
    grain->age_octaves = age_depth(xenon, P_CUTOFF);
    grain->age_resonance = age_depth(xenon, P_RESONANCE);
    grain->age_azimuth = age_depth(xenon, P_AZIMUTH);
    grain->age_elevation = age_depth(xenon, P_ELEVATION);
    grain->age_distance = age_depth(xenon, P_DISTANCE);
    grain->age_gain = age_depth(xenon, P_GAIN);
    grain->age_semitones += age_depth(xenon, P_FINE) * 200.0 / 9600.0;
}

static float read_sample(const Sample *sample, double position) {
    const double frames = sample->frames;
    position -= std::floor(position / frames) * frames;
    const int64_t index = static_cast<int64_t>(position);
    const float t = static_cast<float>(position - index);
    const int64_t count = sample->frames;
    const float y0 = sample->mono[(index - 1 + count) % count];
    const float y1 = sample->mono[index % count];
    const float y2 = sample->mono[(index + 1) % count];
    const float y3 = sample->mono[(index + 2) % count];
    const float c1 = 0.5f * (y2 - y0);
    const float c2 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    const float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
}

static void render_grain(Xenon *xenon, Grain &grain, const float *voice_env, float *left, float *right, float *room,
                         uint32_t frames) {
    const Sample *sample = xenon->current;
    grain_coefficients(xenon, grain);
    const double a1 = 1.0 / (1.0 + grain.svf_g * (grain.svf_g + grain.svf_k));
    const double a2 = grain.svf_g * a1;
    const double a3 = grain.svf_g * a2;
    const double step = grain.increment * grain.rate_base;
    for (uint32_t frame = 0; frame < frames; frame++) {
        if (grain.age < 0.0) {
            grain.age += 1.0;
            continue;
        }
        if (grain.age >= grain.length) {
            grain.active = false;
            return;
        }
        const double phase = grain.age / grain.length;
        const double x = read_sample(sample, grain.position);
        grain.position += step;
        grain.age += 1.0;
        const double v3 = x - grain.ic2;
        const double v1 = a1 * grain.ic1 + a2 * v3;
        const double v2 = grain.ic2 + a2 * grain.ic1 + a3 * v3;
        grain.ic1 = 2.0 * v1 - grain.ic1;
        grain.ic2 = 2.0 * v2 - grain.ic2;
        double y = grain.filter == 0 ? v2 : grain.filter == 1 ? v1 : x - grain.svf_k * v1 - v2;
        grain.air = y + (grain.air - y) * grain.air_coef;
        y = grain.air;
        grain.tilt = y + (grain.tilt - y) * 0.65;
        y += grain.tilt_k * (y - grain.tilt);
        y *= envelope(grain.shape, phase) * grain.normal * grain.distance_gain * voice_env[frame];
        grain.ring[grain.ring_write & (ITD_RING - 1)] = static_cast<float>(y);
        const double delayed_at = static_cast<double>(grain.ring_write) - grain.itd;
        grain.ring_write++;
        const double base = std::floor(delayed_at);
        const float fraction = static_cast<float>(delayed_at - base);
        const uint32_t index = static_cast<uint32_t>(static_cast<int64_t>(base)) & (ITD_RING - 1);
        const float far = grain.ring[index] * (1.0f - fraction) + grain.ring[(index + 1) & (ITD_RING - 1)] * fraction;
        grain.shadow = far + (grain.shadow - far) * grain.shadow_coef;
        const float near_out = static_cast<float>(y * grain.near_gain);
        const float far_out = static_cast<float>(grain.shadow * grain.far_gain);
        left[frame] += grain.right_near ? far_out : near_out;
        right[frame] += grain.right_near ? near_out : far_out;
        room[frame] += static_cast<float>(y * grain.send);
    }
}

// ---- room: four delay lines in a Hadamard loop, damped ----

static void room_free(Room &room) {
    for (float *&line: room.lines) {
        std::free(line);
        line = nullptr;
    }
}

static bool room_prepare(Room &room, double rate) {
    static const double milliseconds[4] = {23.3, 29.9, 37.1, 43.7};
    room_free(room);
    for (int index = 0; index < 4; index++) {
        room.lengths[index] = static_cast<uint32_t>(milliseconds[index] * 0.001 * rate);
        room.lines[index] = static_cast<float *>(std::calloc(room.lengths[index], sizeof(float)));
        if (room.lines[index] == nullptr) {return false;}
        room.index[index] = 0;
        room.damp[index] = 0.0f;
    }
    return true;
}

static void room_process(Room &room, const float *input, float *left, float *right, uint32_t frames, double rate) {
    if (room.lines[0] == nullptr) {return;}
    const float damping = static_cast<float>(std::exp(-TAU * 5000.0 / rate));
    for (uint32_t frame = 0; frame < frames; frame++) {
        float out[4];
        for (int index = 0; index < 4; index++) {
            const float value = room.lines[index][room.index[index]];
            room.damp[index] = value + (room.damp[index] - value) * damping;
            out[index] = room.damp[index];
        }
        const float a = out[0] + out[1], b = out[0] - out[1], c = out[2] + out[3], d = out[2] - out[3];
        const float mixed[4] = {a + c, b + d, a - c, b - d};
        for (int index = 0; index < 4; index++) {
            room.lines[index][room.index[index]] = input[frame] + 0.5f * 0.55f * mixed[index];
            if (++room.index[index] >= room.lengths[index]) {room.index[index] = 0;}
        }
        left[frame] += 0.35f * (out[0] + out[2]);
        right[frame] += 0.35f * (out[1] + out[3]);
    }
}

// ---- voices ----

static int voice_limit(const Xenon *xenon) {return stepped(xenon, P_MODE) == 0 ? 1 : stepped(xenon, P_VOICES);}

static void voice_start(Xenon *xenon, Voice &voice, int key, double velocity, bool legato) {
    const bool glide = legato && xenon->values[P_GLIDE] > 0.0;
    voice.key = key;
    voice.target = key;
    if (!glide) {voice.note = key;}
    voice.velocity = velocity;
    voice.gate = true;
    voice.started = xenon->clock;
    if (!legato || !voice.active) {
        adsr_gate(voice.amp, true);
        adsr_gate(voice.mod, true);
        voice.countdown = 0.0;
        voice.scan = 0.0;
        voice.pressure = 0.0;
    }
    voice.active = true;
}

static void note_on(Xenon *xenon, int key, double velocity) {
    if (key < 0 || key > 127) {return;}
    xenon->held[key] = true;
    xenon->held_at[key] = ++xenon->clock;
    if (stepped(xenon, P_MODE) == 0) {
        Voice &voice = xenon->voices[0];
        voice_start(xenon, voice, key, velocity, voice.active && voice.gate);
        return;
    }
    const int limit = voice_limit(xenon);
    Voice *chosen = nullptr;
    for (int index = 0; index < limit; index++) {
        if (!xenon->voices[index].active) {
            chosen = &xenon->voices[index];
            break;
        }
    }
    if (chosen == nullptr) {
        chosen = &xenon->voices[0];
        for (int index = 1; index < limit; index++) {
            if (xenon->voices[index].started < chosen->started) {chosen = &xenon->voices[index];}
        }
    }
    voice_start(xenon, *chosen, key, velocity, false);
}

static void note_off(Xenon *xenon, int key) {
    if (key < 0 || key > 127) {return;}
    xenon->held[key] = false;
    if (stepped(xenon, P_MODE) == 0) {
        Voice &voice = xenon->voices[0];
        if (!voice.active || voice.key != key) {return;}
        int latest = -1;
        for (int other = 0; other < 128; other++) {
            if (xenon->held[other] && (latest < 0 || xenon->held_at[other] > xenon->held_at[latest])) {latest = other;}
        }
        if (latest >= 0) {
            voice_start(xenon, voice, latest, voice.velocity, true);
        } else {
            voice.gate = false;
            adsr_gate(voice.amp, false);
            adsr_gate(voice.mod, false);
        }
        return;
    }
    for (Voice &voice: xenon->voices) {
        if (voice.active && voice.gate && voice.key == key) {
            voice.gate = false;
            adsr_gate(voice.amp, false);
            adsr_gate(voice.mod, false);
        }
    }
}

static void all_off(Xenon *xenon) {
    for (Voice &voice: xenon->voices) {voice.active = false; voice.amp.stage = Adsr::IDLE; voice.amp.level = 0.0; voice.mod = voice.amp;}
    for (Grain &grain: xenon->grains) {grain.active = false;}
    std::memset(xenon->held, 0, sizeof(xenon->held));
}

// ---- events ----

static void set_value(Xenon *xenon, clap_id id, double value) {
    if (id >= PARAM_COUNT) {return;}
    xenon->values[id] = clamp_value(id, value);
}

static void handle_event(Xenon *xenon, const clap_event_header_t *header) {
    if (header->space_id != CLAP_CORE_EVENT_SPACE_ID) {return;}
    switch (header->type) {
        case CLAP_EVENT_NOTE_ON: {
            const clap_event_note_t *note = reinterpret_cast<const clap_event_note_t *>(header);
            note_on(xenon, note->key, note->velocity);
            break;
        }
        case CLAP_EVENT_NOTE_OFF:
        case CLAP_EVENT_NOTE_CHOKE: {
            const clap_event_note_t *note = reinterpret_cast<const clap_event_note_t *>(header);
            note_off(xenon, note->key);
            break;
        }
        case CLAP_EVENT_NOTE_EXPRESSION: {
            const clap_event_note_expression_t *expression = reinterpret_cast<const clap_event_note_expression_t *>(header);
            if (expression->expression_id != CLAP_NOTE_EXPRESSION_PRESSURE) {break;}
            for (Voice &voice: xenon->voices) {
                if (voice.active && (expression->key < 0 || voice.key == expression->key)) {voice.pressure = clamp(expression->value, 0.0, 1.0);}
            }
            break;
        }
        case CLAP_EVENT_MIDI: {
            const clap_event_midi_t *midi = reinterpret_cast<const clap_event_midi_t *>(header);
            const uint8_t status = midi->data[0] & 0xf0;
            if (status == 0x90 && midi->data[2] > 0) {
                note_on(xenon, midi->data[1], midi->data[2] / 127.0);
            } else if (status == 0x80 || (status == 0x90 && midi->data[2] == 0)) {
                note_off(xenon, midi->data[1]);
            } else if (status == 0xb0 && midi->data[1] == 1) {
                xenon->wheel = midi->data[2] / 127.0;
            } else if (status == 0xb0 && midi->data[1] == 123) {
                all_off(xenon);
            } else if (status == 0xd0) {
                xenon->pressure = midi->data[1] / 127.0;
            } else if (status == 0xa0) {
                for (Voice &voice: xenon->voices) {if (voice.active && voice.key == midi->data[1]) {voice.pressure = midi->data[2] / 127.0;}}
            }
            break;
        }
        case CLAP_EVENT_PARAM_VALUE: {
            const clap_event_param_value_t *param = reinterpret_cast<const clap_event_param_value_t *>(header);
            set_value(xenon, param->param_id, param->value);
            break;
        }
        case CLAP_EVENT_TRANSPORT: {
            const clap_event_transport_t *transport = reinterpret_cast<const clap_event_transport_t *>(header);
            if (transport->flags & CLAP_TRANSPORT_HAS_TEMPO) {xenon->tempo = transport->tempo;}
            break;
        }
        default:
            break;
    }
}

static void push_out_event(Xenon *xenon, uint16_t type, clap_id id, double value) {
    if (xenon->out_write - xenon->out_read >= OUT_EVENTS) {return;}
    xenon->out_events[xenon->out_write % OUT_EVENTS] = OutEvent{type, id, value};
    xenon->out_write++;
}

static void drain_out_events(Xenon *xenon, const clap_output_events_t *out) {
    while (xenon->out_read != xenon->out_write) {
        const OutEvent &event = xenon->out_events[xenon->out_read % OUT_EVENTS];
        if (event.type == CLAP_EVENT_PARAM_VALUE) {
            clap_event_param_value_t value = {};
            value.header = {sizeof(value), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
            value.param_id = event.id;
            value.note_id = -1;
            value.port_index = -1;
            value.channel = -1;
            value.key = -1;
            value.value = event.value;
            out->try_push(out, &value.header);
        } else {
            clap_event_param_gesture_t gesture = {};
            gesture.header = {sizeof(gesture), 0, CLAP_CORE_EVENT_SPACE_ID, event.type, 0};
            gesture.param_id = event.id;
            out->try_push(out, &gesture.header);
        }
        xenon->out_read++;
    }
}

// ---- process ----

static void render_block(Xenon *xenon, float *left, float *right, uint32_t frames) {
    float room_in[BLOCK];
    std::memset(left, 0, frames * sizeof(float));
    std::memset(right, 0, frames * sizeof(float));
    std::memset(room_in, 0, sizeof(room_in));
    const double rate = xenon->sample_rate;
    advance_lfos(xenon, frames);
    const int limit = voice_limit(xenon);
    const double glide = xenon->values[P_GLIDE] > 0.0 ? 1.0 - std::exp(-5000.0 * frames / (xenon->values[P_GLIDE] * rate)) : 1.0;
    const double velocity_amount = xenon->values[P_VELOCITY];
    for (int index = 0; index < MAX_VOICES; index++) {
        Voice &voice = xenon->voices[index];
        if (!voice.active) {continue;}
        if (index >= limit && voice.gate) {
            voice.gate = false;
            adsr_gate(voice.amp, false);
            adsr_gate(voice.mod, false);
        }
        const double level = 1.0 - velocity_amount * (1.0 - voice.velocity);
        for (uint32_t frame = 0; frame < frames; frame++) {
            voice.env[frame] = static_cast<float>(level * adsr_step(voice.amp, xenon->values[P_ATTACK], xenon->values[P_DECAY],
                xenon->values[P_SUSTAIN], xenon->values[P_RELEASE], rate));
        }
        adsr_step(voice.mod, xenon->values[P_ENV2_ATTACK] / frames, xenon->values[P_ENV2_DECAY] / frames,
                  xenon->values[P_ENV2_SUSTAIN], xenon->values[P_ENV2_RELEASE] / frames, rate);
        voice.note += (voice.target - voice.note) * glide;
        if (xenon->current != nullptr && xenon->current->frames > 0) {
            voice.scan += xenon->values[P_SCAN] * frames * xenon->current->rate / rate / xenon->current->frames;
            voice.scan -= std::floor(voice.scan);
        }
        if (voice.amp.stage == Adsr::IDLE) {
            voice.active = false;
            continue;
        }
        if (!voice.gate) {continue;}
        double sources[SOURCE_COUNT];
        voice_sources(xenon, voice, sources);
        const double interval = stepped(xenon, P_SYNC) > 0 ? sync_interval(xenon) : rate / modulated(xenon, P_DENSITY, sources);
        while (voice.countdown < frames) {
            spawn_grain(xenon, index, static_cast<uint32_t>(voice.countdown > 0.0 ? voice.countdown : 0.0));
            voice.countdown += interval;
        }
        voice.countdown -= frames;
    }
    for (Grain &grain: xenon->grains) {
        if (!grain.active) {continue;}
        const Voice &voice = xenon->voices[grain.voice];
        if (!voice.active) {
            grain.active = false;
            continue;
        }
        render_grain(xenon, grain, voice.env, left, right, room_in, frames);
    }
    room_process(xenon->room, room_in, left, right, frames, rate);
    const float width = static_cast<float>(xenon->values[P_WIDTH]);
    for (uint32_t frame = 0; frame < frames; frame++) {
        const float mid = 0.5f * (left[frame] + right[frame]);
        const float side = 0.5f * (left[frame] - right[frame]) * width;
        left[frame] = mid + side;
        right[frame] = mid - side;
    }
}

static void render(Xenon *xenon, float *left, float *right, uint32_t from, uint32_t to) {
    while (from < to) {
        const uint32_t frames = to - from < BLOCK ? to - from : BLOCK;
        render_block(xenon, left + from, right + from, frames);
        from += frames;
    }
}

static clap_process_status xenon_process(const clap_plugin_t *plugin, const clap_process_t *process) {
    Xenon *xenon = xenon_of(plugin);
    if (process->audio_outputs_count < 1 || process->audio_outputs[0].channel_count < 2) {return CLAP_PROCESS_ERROR;}
    swap_sample(xenon);
    if (process->transport != nullptr && (process->transport->flags & CLAP_TRANSPORT_HAS_TEMPO)) {xenon->tempo = process->transport->tempo;}
    float *left = process->audio_outputs[0].data32[0];
    float *right = process->audio_outputs[0].data32[1];
    const uint32_t frames = process->frames_count;
    const uint32_t count = process->in_events->size(process->in_events);
    uint32_t position = 0;
    for (uint32_t index = 0; index < count; index++) {
        const clap_event_header_t *header = process->in_events->get(process->in_events, index);
        const uint32_t time = header->time < frames ? header->time : frames;
        if (time > position) {
            render(xenon, left, right, position, time);
            position = time;
        }
        handle_event(xenon, header);
    }
    render(xenon, left, right, position, frames);
    drain_out_events(xenon, process->out_events);
    return CLAP_PROCESS_CONTINUE;
}

// ---- plugin ----

static bool xenon_init(const clap_plugin_t *plugin) {
    Xenon *xenon = xenon_of(plugin);
    const clap_host_t *host = xenon->host;
    xenon->host_params = static_cast<const clap_host_params_t *>(host->get_extension(host, CLAP_EXT_PARAMS));
    xenon->host_state = static_cast<const clap_host_state_t *>(host->get_extension(host, CLAP_EXT_STATE));
    xenon->host_webview = static_cast<const clap_host_webview_t *>(host->get_extension(host, CLAP_EXT_WEBVIEW));
    xenon->host_hovered = static_cast<const clap_host_param_hovered_t *>(host->get_extension(host, CLAP_EXT_PARAM_HOVERED));
    const auto *samples = static_cast<const opendaw_host_samples_t *>(host->get_extension(host, OPENDAW_EXT_SAMPLES));
    xenon->host_keeps = samples != nullptr && samples->available != nullptr && samples->available(host);
    return true;
}

static void xenon_destroy(const clap_plugin_t *plugin) {
    Xenon *xenon = xenon_of(plugin);
    sample_free(xenon->retired.exchange(nullptr));
    Sample *pending = xenon->pending.exchange(nullptr);
    if (pending != xenon->current) {sample_free(pending);}
    sample_free(xenon->current);
    sample_free(xenon->uploading);
    std::free(xenon->staging);
    room_free(xenon->room);
    std::free(xenon->status);
    xenon->~Xenon();
    std::free(xenon);
}

static bool xenon_activate(const clap_plugin_t *plugin, double sample_rate, uint32_t min_frames, uint32_t max_frames) {
    (void) min_frames; (void) max_frames;
    Xenon *xenon = xenon_of(plugin);
    xenon->sample_rate = sample_rate;
    all_off(xenon);
    return room_prepare(xenon->room, sample_rate);
}

static void xenon_deactivate(const clap_plugin_t *plugin) {(void) plugin;}

static bool xenon_start_processing(const clap_plugin_t *plugin) {(void) plugin; return true;}

static void xenon_stop_processing(const clap_plugin_t *plugin) {(void) plugin;}

static void xenon_reset(const clap_plugin_t *plugin) {
    Xenon *xenon = xenon_of(plugin);
    all_off(xenon);
    for (int index = 0; index < 4; index++) {
        if (xenon->room.lines[index] != nullptr) {std::memset(xenon->room.lines[index], 0, xenon->room.lengths[index] * sizeof(float));}
        xenon->room.damp[index] = 0.0f;
    }
}

static uint32_t audio_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 0 : 1;}

static bool audio_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    (void) plugin;
    if (index > 0 || is_input) {return false;}
    info->id = 0;
    std::snprintf(info->name, sizeof(info->name), "Stereo Out");
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

static const clap_plugin_audio_ports_t audio_ports = {audio_ports_count, audio_ports_get};

static uint32_t note_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 1 : 0;}

static bool note_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_note_port_info_t *info) {
    (void) plugin;
    if (index > 0 || !is_input) {return false;}
    info->id = 0;
    info->supported_dialects = CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI;
    info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
    std::snprintf(info->name, sizeof(info->name), "Notes");
    return true;
}

static const clap_plugin_note_ports_t note_ports = {note_ports_count, note_ports_get};

static uint32_t params_count(const clap_plugin_t *plugin) {(void) plugin; return PARAM_COUNT;}

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
    (void) plugin;
    if (index >= PARAM_COUNT) {return false;}
    const ParamDef &def = DEFS[index];
    std::memset(info, 0, sizeof(*info));
    info->id = index;
    info->flags = CLAP_PARAM_IS_AUTOMATABLE;
    if (def.curve == STEPPED) {info->flags |= CLAP_PARAM_IS_STEPPED;}
    if (def.curve == STEPPED && index != P_VOICES) {info->flags |= CLAP_PARAM_IS_ENUM;}
    info->min_value = def.min;
    info->max_value = def.max;
    info->default_value = def.value;
    std::snprintf(info->name, sizeof(info->name), "%s", def.name);
    std::snprintf(info->module, sizeof(info->module), "%s", def.module);
    return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *value) {
    if (id >= PARAM_COUNT) {return false;}
    *value = xenon_of(plugin)->values[id];
    return true;
}

static const char *const *texts_of(clap_id id) {
    switch (id) {
        case P_SYNC: return SYNC_TEXTS;
        case P_SCALE: return SCALE_TEXTS;
        case P_KEY_TRACK: return ONOFF_TEXTS;
        case P_FILTER_TYPE: return FILTER_TEXTS;
        case P_MODE: return MODE_TEXTS;
        case P_LFO1_SHAPE:
        case P_LFO2_SHAPE: return LFO_TEXTS;
        default: return nullptr;
    }
}

static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *text, uint32_t size) {
    (void) plugin;
    if (id >= PARAM_COUNT || size == 0) {return false;}
    const char *const *texts = texts_of(id);
    if (texts != nullptr) {
        std::snprintf(text, size, "%s", texts[static_cast<int>(clamp_value(id, value))]);
        return true;
    }
    switch (id) {
        case P_POSITION: case P_SPRAY: case P_REVERSE: case P_RESONANCE: case P_CUTOFF_RANDOM: case P_DISTANCE_RANDOM:
        case P_MOTION: case P_ROOM: case P_WIDTH: case P_SUSTAIN: case P_VELOCITY: case P_ENV2_SUSTAIN:
            std::snprintf(text, size, "%.0f %%", value * 100.0);
            break;
        case P_SHAPE: {
            const int index = static_cast<int>(std::lround(clamp(value, 0.0, 1.0) * 4.0));
            std::snprintf(text, size, "%s", SHAPE_TEXTS[index]);
            break;
        }
        case P_SCAN: std::snprintf(text, size, "%.2f x", value); break;
        case P_SIZE: case P_GLIDE: case P_ATTACK: case P_DECAY: case P_RELEASE: case P_ENV2_ATTACK: case P_ENV2_DECAY:
        case P_ENV2_RELEASE:
            std::snprintf(text, size, value < 10.0 ? "%.1f ms" : "%.0f ms", value);
            break;
        case P_DENSITY: std::snprintf(text, size, value < 10.0 ? "%.1f /s" : "%.0f /s", value); break;
        case P_PITCH: case P_PITCH_RANDOM: std::snprintf(text, size, "%.1f st", value); break;
        case P_FINE: std::snprintf(text, size, "%.0f ct", value); break;
        case P_CUTOFF: std::snprintf(text, size, value < 1000.0 ? "%.0f Hz" : "%.2f kHz", value < 1000.0 ? value : value * 0.001); break;
        case P_AZIMUTH: case P_SPREAD: case P_ELEVATION: std::snprintf(text, size, "%.0f deg", value); break;
        case P_DISTANCE: std::snprintf(text, size, "%.1f m", value); break;
        case P_GAIN: std::snprintf(text, size, "%.1f dB", value); break;
        case P_VOICES: std::snprintf(text, size, "%d", static_cast<int>(clamp_value(id, value))); break;
        default: std::snprintf(text, size, "%.2f Hz", value); break;
    }
    return true;
}

static bool matches(const char *text, const char *label) {
    while (*text == ' ') {text++;}
    for (; *label != '\0'; text++, label++) {
        const char letter = *text >= 'a' && *text <= 'z' ? static_cast<char>(*text - 32) : *text;
        if (letter != *label) {return false;}
    }
    return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text, double *value) {
    (void) plugin;
    if (id >= PARAM_COUNT || text == nullptr) {return false;}
    const char *const *texts = texts_of(id);
    if (texts != nullptr) {
        for (int index = 0; index <= static_cast<int>(DEFS[id].max); index++) {
            if (matches(text, texts[index])) {
                *value = index;
                return true;
            }
        }
    }
    if (id == P_SHAPE) {
        for (int index = 0; index < 5; index++) {
            if (matches(text, SHAPE_TEXTS[index])) {
                *value = index / 4.0;
                return true;
            }
        }
    }
    char *end = nullptr;
    double number = std::strtod(text, &end);
    if (end == text) {return false;}
    while (*end == ' ') {end++;}
    if (*end == '%') {number *= 0.01;}
    if (id == P_CUTOFF && (*end == 'k' || *end == 'K')) {number *= 1000.0;}
    *value = clamp_value(id, number);
    return true;
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in, const clap_output_events_t *out) {
    Xenon *xenon = xenon_of(plugin);
    const uint32_t count = in->size(in);
    for (uint32_t index = 0; index < count; index++) {handle_event(xenon, in->get(in, index));}
    drain_out_events(xenon, out);
}

static const clap_plugin_params_t params = {
    params_count, params_get_info, params_get_value, params_value_to_text, params_text_to_value, params_flush
};

// ---- state: magic, version, the parameters, the modulation depths, then the sample (16-bit mono) ----

static bool write_all(const clap_ostream_t *stream, const void *data, uint64_t size) {
    const uint8_t *bytes = static_cast<const uint8_t *>(data);
    uint64_t written = 0;
    while (written < size) {
        const int64_t result = stream->write(stream, bytes + written, size - written);
        if (result <= 0) {return false;}
        written += result;
    }
    return true;
}

static bool read_all(const clap_istream_t *stream, void *data, uint64_t size) {
    uint8_t *bytes = static_cast<uint8_t *>(data);
    uint64_t read = 0;
    while (read < size) {
        const int64_t result = stream->read(stream, bytes + read, size - read);
        if (result <= 0) {return false;}
        read += result;
    }
    return true;
}

static bool state_save(const clap_plugin_t *plugin, const clap_ostream_t *stream) {
    Xenon *xenon = xenon_of(plugin);
    collect_retired(xenon);
    const Sample *sample = xenon->latest;
    const uint32_t header[4] = {STATE_MAGIC, STATE_VERSION, PARAM_COUNT, SOURCE_COUNT};
    if (!write_all(stream, header, sizeof(header))) {return false;}
    if (!write_all(stream, xenon->values, sizeof(xenon->values))) {return false;}
    if (!write_all(stream, xenon->depths, sizeof(xenon->depths))) {return false;}
    // the host keeps the sample: its name, no frames, a rate of -1 (older Xenons read it as no sample)
    if (xenon->host_keeps && !xenon->embedded) {
        const char *name = sample != nullptr ? sample->name : xenon->host_name;
        const uint32_t name_length = static_cast<uint32_t>(std::strlen(name)), none = 0;
        const double marker = -1.0;
        return write_all(stream, &name_length, 4) && (name_length == 0 || write_all(stream, name, name_length))
            && write_all(stream, &marker, 8) && write_all(stream, &none, 4);
    }
    const uint32_t frames = sample != nullptr ? sample->frames : 0;
    const uint32_t name_length = sample != nullptr ? static_cast<uint32_t>(std::strlen(sample->name)) : 0;
    const double rate = sample != nullptr ? sample->rate : 0.0;
    if (!write_all(stream, &name_length, 4) || (name_length > 0 && !write_all(stream, sample->name, name_length))) {return false;}
    if (!write_all(stream, &rate, 8) || !write_all(stream, &frames, 4)) {return false;}
    int16_t chunk[4096];
    for (uint32_t offset = 0; offset < frames; offset += 4096) {
        const uint32_t count = frames - offset < 4096 ? frames - offset : 4096;
        for (uint32_t index = 0; index < count; index++) {
            chunk[index] = static_cast<int16_t>(std::lround(clamp(sample->mono[offset + index], -1.0, 32767.0 / 32768.0) * 32768.0));
        }
        if (!write_all(stream, chunk, count * 2)) {return false;}
    }
    return true;
}

static bool state_load(const clap_plugin_t *plugin, const clap_istream_t *stream) {
    Xenon *xenon = xenon_of(plugin);
    uint32_t header[4];
    if (!read_all(stream, header, sizeof(header)) || header[0] != STATE_MAGIC || header[1] != STATE_VERSION) {return false;}
    const uint32_t param_count = header[2], source_count = header[3];
    for (uint32_t id = 0; id < param_count; id++) {
        double value;
        if (!read_all(stream, &value, 8)) {return false;}
        if (id < PARAM_COUNT) {xenon->values[id] = clamp_value(id, value);}
    }
    std::memset(xenon->depths, 0, sizeof(xenon->depths));
    for (uint32_t id = 0; id < param_count; id++) {
        for (uint32_t source = 0; source < source_count; source++) {
            float depth;
            if (!read_all(stream, &depth, 4)) {return false;}
            if (id < PARAM_COUNT && source < SOURCE_COUNT) {xenon->depths[id][source] = static_cast<float>(clamp(depth, -1.0, 1.0));}
        }
    }
    xenon->mod_generation++;
    uint32_t name_length = 0, frames = 0;
    double rate = 0.0;
    char name[NAME_CAPACITY];
    if (!read_all(stream, &name_length, 4)) {return false;}
    for (uint32_t index = 0; index < name_length; index++) {
        char letter;
        if (!read_all(stream, &letter, 1)) {return false;}
        if (index < NAME_CAPACITY) {name[index] = letter;}
    }
    if (!read_all(stream, &rate, 8) || !read_all(stream, &frames, 4)) {return false;}
    if (frames == 0 && rate < 0.0) { // the host keeps it: the name now, the frames from the host
        const uint32_t length = name_length < NAME_CAPACITY ? name_length : NAME_CAPACITY - 1;
        std::memcpy(xenon->host_name, name, length);
        xenon->host_name[length] = '\0';
        xenon->embedded = false;
        return true;
    }
    xenon->embedded = frames > 0; // kept in the state until the host has a sample of its own
    if (frames == 0) {return xenon->latest == nullptr || clear_sample(xenon);}
    if (rate < 1000.0 || rate > 384000.0 || frames > MAX_SECONDS * rate) {return false;}
    Sample *sample = sample_create(frames, rate, name, name_length);
    if (sample == nullptr) {return false;}
    int16_t chunk[4096];
    for (uint32_t offset = 0; offset < frames; offset += 4096) {
        const uint32_t count = frames - offset < 4096 ? frames - offset : 4096;
        if (!read_all(stream, chunk, count * 2)) {
            sample_free(sample);
            return false;
        }
        for (uint32_t index = 0; index < count; index++) {sample->mono[offset + index] = chunk[index] / 32768.0f;}
    }
    sample_peaks(sample);
    publish(xenon, sample);
    return true;
}

static const clap_plugin_state_t state = {state_save, state_load};

// ---- webview ----

static int32_t webview_get_uri(const clap_plugin_t *plugin, char *uri, uint32_t capacity) {
    (void) plugin;
    static const char page[] = "/index.html";
    if (capacity > 0 && uri != nullptr) {std::snprintf(uri, capacity, "%s", page);}
    return static_cast<int32_t>(sizeof(page));
}

static bool webview_get_resource(const clap_plugin_t *plugin, const char *path, char *mime, uint32_t capacity,
                                 const clap_ostream_t *stream) {
    (void) plugin; (void) path; (void) mime; (void) capacity; (void) stream;
    return false;
}

static void send_status(Xenon *xenon) {
    const uint32_t capacity = STATUS_HEADER + PARAM_COUNT * 8 + PARAM_COUNT * 4 + GRAIN_POOL * STATUS_GRAIN_FLOATS * 4;
    if (xenon->status == nullptr) {xenon->status = static_cast<uint8_t *>(std::malloc(capacity));}
    if (xenon->status == nullptr) {return;}
    uint8_t *message = xenon->status;
    std::memset(message, 0, STATUS_HEADER);
    message[0] = PLUGIN_STATUS;
    const Sample *sample = xenon->current;
    uint32_t grains = 0, voices = 0;
    for (const Voice &voice: xenon->voices) {if (voice.active) {voices++;}}
    float *grain_out = reinterpret_cast<float *>(message + STATUS_HEADER + PARAM_COUNT * 12);
    if (sample != nullptr && sample->frames > 0) {
        for (const Grain &grain: xenon->grains) {
            if (!grain.active || grain.age < 0.0) {continue;}
            const double frames = sample->frames;
            double position = grain.position / frames;
            position -= std::floor(position);
            const double azimuth = grain.azimuth * M_PI / 180.0;
            float values[STATUS_GRAIN_FLOATS] = {
                static_cast<float>(position),
                static_cast<float>(std::fabs(grain.length * grain.increment * grain.rate_base) / frames),
                static_cast<float>(envelope(grain.shape, grain.age / grain.length) * xenon->voices[grain.voice].env[0] * grain.normal * grain.distance_gain),
                static_cast<float>(normalize(P_DISTANCE, grain.distance)),
                static_cast<float>(std::sin(azimuth))
            };
            std::memcpy(grain_out + grains * STATUS_GRAIN_FLOATS, values, sizeof(values));
            grains++;
        }
    }
    const uint32_t header[5] = {grains, xenon->sample_generation, xenon->mod_generation, voices, 0};
    std::memcpy(message + 4, header, sizeof(header));
    std::memcpy(message + STATUS_HEADER, xenon->values, sizeof(xenon->values));
    const Voice *shown = nullptr;
    for (const Voice &voice: xenon->voices) {
        if (voice.active && (shown == nullptr || voice.started > shown->started)) {shown = &voice;}
    }
    Voice idle = {};
    idle.note = 60.0;
    double sources[SOURCE_COUNT];
    voice_sources(xenon, shown != nullptr ? *shown : idle, sources);
    for (clap_id id = 0; id < PARAM_COUNT; id++) {xenon->live[id] = static_cast<float>(normalize(id, modulated(xenon, id, sources)));}
    std::memcpy(message + STATUS_HEADER + PARAM_COUNT * 8, xenon->live, sizeof(xenon->live));
    xenon->host_webview->send(xenon->host, message, STATUS_HEADER + PARAM_COUNT * 12 + grains * STATUS_GRAIN_FLOATS * 4);
}

static void send_peaks(Xenon *xenon) {
    static uint8_t message[152 + PEAK_COLUMNS * 2];
    const Sample *sample = xenon->latest;
    std::memset(message, 0, 152);
    message[0] = PLUGIN_PEAKS;
    message[1] = xenon->host_keeps ? 1 : 0; // the page hands its files to the host
    const uint32_t frames = sample != nullptr ? sample->frames : 0;
    const double rate = sample != nullptr ? sample->rate : 0.0;
    const uint32_t columns = sample != nullptr ? PEAK_COLUMNS : 0;
    const uint32_t name_length = sample != nullptr ? static_cast<uint32_t>(std::strlen(sample->name)) : 0;
    std::memcpy(message + 4, &frames, 4);
    std::memcpy(message + 8, &rate, 8);
    std::memcpy(message + 16, &columns, 4);
    std::memcpy(message + 20, &name_length, 4);
    std::memcpy(message + 24, &xenon->sample_generation, 4);
    if (sample != nullptr) {
        std::memcpy(message + 28, sample->name, name_length);
        std::memcpy(message + 152, sample->peaks, PEAK_COLUMNS * 2);
    }
    xenon->host_webview->send(xenon->host, message, 152 + columns * 2);
}

static void send_mods(Xenon *xenon) {
    uint8_t message[16 + sizeof(xenon->depths)];
    std::memset(message, 0, 16);
    message[0] = PLUGIN_MODS;
    const uint32_t header[3] = {SOURCE_COUNT, PARAM_COUNT, xenon->mod_generation};
    std::memcpy(message + 4, header, sizeof(header));
    std::memcpy(message + 16, xenon->depths, sizeof(xenon->depths));
    xenon->host_webview->send(xenon->host, message, sizeof(message));
}

static void mark_dirty(Xenon *xenon) {if (xenon->host_state != nullptr) {xenon->host_state->mark_dirty(xenon->host);}}

static void page_param(Xenon *xenon, uint16_t type, const uint8_t *bytes, uint32_t size) {
    clap_id id;
    if (size < 8) {return;}
    std::memcpy(&id, bytes + 4, 4);
    if (id >= PARAM_COUNT) {return;}
    if (type == CLAP_EVENT_PARAM_VALUE) {
        double value;
        if (size < 16) {return;}
        std::memcpy(&value, bytes + 8, 8);
        set_value(xenon, id, value);
        mark_dirty(xenon);
    }
    push_out_event(xenon, type, id, xenon->values[id]);
    if (xenon->host_params != nullptr) {xenon->host_params->request_flush(xenon->host);}
}

static bool sample_begin(Xenon *xenon, const uint8_t *bytes, uint32_t size) {
    uint32_t frames, name_length;
    double rate;
    if (size < 20) {return false;}
    std::memcpy(&frames, bytes + 4, 4);
    std::memcpy(&rate, bytes + 8, 8);
    std::memcpy(&name_length, bytes + 16, 4);
    if (rate < 1000.0 || rate > 384000.0 || frames == 0 || frames > MAX_SECONDS * rate || size < 20 + name_length) {return false;}
    sample_free(xenon->uploading);
    xenon->uploading = sample_create(frames, rate, reinterpret_cast<const char *>(bytes + 20), name_length);
    return xenon->uploading != nullptr;
}

static bool sample_chunk(Xenon *xenon, const uint8_t *bytes, uint32_t size) {
    uint32_t offset, count;
    Sample *sample = xenon->uploading;
    if (sample == nullptr || size < 12) {return false;}
    std::memcpy(&offset, bytes + 4, 4);
    std::memcpy(&count, bytes + 8, 4);
    if (size < 12 + count * 2 || offset > sample->frames || count > sample->frames - offset) {return false;}
    for (uint32_t index = 0; index < count; index++) {
        int16_t value;
        std::memcpy(&value, bytes + 12 + index * 2, 2);
        sample->mono[offset + index] = value / 32768.0f;
    }
    return true;
}

static bool webview_receive(const clap_plugin_t *plugin, const void *buffer, uint32_t size) {
    Xenon *xenon = xenon_of(plugin);
    const uint8_t *bytes = static_cast<const uint8_t *>(buffer);
    if (size < 1 || xenon->host_webview == nullptr) {return false;}
    collect_retired(xenon);
    switch (bytes[0]) {
        case PAGE_POLL:
            send_status(xenon);
            return true;
        case PAGE_PARAM_BEGIN:
            page_param(xenon, CLAP_EVENT_PARAM_GESTURE_BEGIN, bytes, size);
            return true;
        case PAGE_PARAM_SET:
            page_param(xenon, CLAP_EVENT_PARAM_VALUE, bytes, size);
            return true;
        case PAGE_PARAM_END:
            page_param(xenon, CLAP_EVENT_PARAM_GESTURE_END, bytes, size);
            return true;
        case PAGE_MOD_SET: {
            uint32_t target, source;
            float depth;
            if (size < 16) {return false;}
            std::memcpy(&target, bytes + 4, 4);
            std::memcpy(&source, bytes + 8, 4);
            std::memcpy(&depth, bytes + 12, 4);
            if (target >= PARAM_COUNT || source >= SOURCE_COUNT || !DEFS[target].modulatable) {return false;}
            xenon->depths[target][source] = static_cast<float>(clamp(depth, -1.0, 1.0));
            // byte 1 set: a drag's step, the drag's last (byte 1 clear) tells the host (one undo step)
            if (bytes[1] == 0) {mark_dirty(xenon);}
            return true;
        }
        case PAGE_SAMPLE_BEGIN:
            return sample_begin(xenon, bytes, size);
        case PAGE_SAMPLE_CHUNK:
            return sample_chunk(xenon, bytes, size);
        case PAGE_SAMPLE_COMMIT: {
            Sample *sample = xenon->uploading;
            if (sample == nullptr) {return false;}
            xenon->uploading = nullptr;
            sample_peaks(sample);
            publish(xenon, sample);
            xenon->embedded = true;
            mark_dirty(xenon);
            send_peaks(xenon);
            return true;
        }
        case PAGE_SAMPLE_CLEAR:
            if (!clear_sample(xenon)) {return false;}
            mark_dirty(xenon);
            send_peaks(xenon);
            return true;
        case PAGE_REQUEST_PEAKS:
            send_peaks(xenon);
            return true;
        case PAGE_SAMPLE_NAME: { // the page handed the host a file (opendaw.samples/1): its name, the frames follow
            uint32_t length;
            if (size < 8) {return false;}
            std::memcpy(&length, bytes + 4, 4);
            if (size < 8 + length) {return false;}
            length = length < NAME_CAPACITY ? length : NAME_CAPACITY - 1;
            std::memcpy(xenon->host_name, bytes + 8, length);
            xenon->host_name[length] = '\0';
            return true;
        }
        case PAGE_REQUEST_MODS:
            send_mods(xenon);
            return true;
        case PAGE_HOVER: {
            clap_id id;
            if (size < 8 || xenon->host_hovered == nullptr) {return false;}
            std::memcpy(&id, bytes + 4, 4);
            xenon->host_hovered->update(xenon->host, id < PARAM_COUNT ? id : CLAP_INVALID_ID);
            return true;
        }
        default:
            return false;
    }
}

static const clap_plugin_webview_t webview = {webview_get_uri, webview_get_resource, webview_receive};

// gui: only the webview api, the host owns the window, the panel's 512 x 176 scaled 1 to 3 times
static bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    (void) plugin; (void) is_floating;
    return std::strcmp(api, CLAP_WINDOW_API_WEBVIEW) == 0;
}

static bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
    (void) plugin;
    *api = CLAP_WINDOW_API_WEBVIEW;
    *is_floating = false;
    return true;
}

static bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    return gui_is_api_supported(plugin, api, is_floating);
}

static void gui_destroy(const clap_plugin_t *plugin) {(void) plugin;}

static bool gui_set_scale(const clap_plugin_t *plugin, double scale) {(void) plugin; (void) scale; return false;}

static bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    const Xenon *xenon = xenon_of(plugin);
    *width = xenon->gui_width;
    *height = xenon->gui_height;
    return true;
}

static bool gui_can_resize(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_get_resize_hints(const clap_plugin_t *plugin, clap_gui_resize_hints_t *hints) {
    (void) plugin;
    hints->can_resize_horizontally = true;
    hints->can_resize_vertically = true;
    hints->preserve_aspect_ratio = true;
    hints->aspect_ratio_width = GUI_WIDTH;
    hints->aspect_ratio_height = GUI_HEIGHT;
    return true;
}

static bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    (void) plugin;
    const double wanted = std::fmin(static_cast<double>(*width) / GUI_WIDTH, static_cast<double>(*height) / GUI_HEIGHT);
    const double scale = std::fmin(GUI_MAX_SCALE, std::fmax(GUI_MIN_SCALE, wanted));
    *width = static_cast<uint32_t>(std::lround(GUI_WIDTH * scale));
    *height = static_cast<uint32_t>(std::lround(GUI_HEIGHT * scale));
    return true;
}

static bool gui_set_size(const clap_plugin_t *plugin, uint32_t width, uint32_t height) {
    Xenon *xenon = xenon_of(plugin);
    gui_adjust_size(plugin, &width, &height);
    xenon->gui_width = width;
    xenon->gui_height = height;
    return true;
}

static bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return true;}

static bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return false;}

static void gui_suggest_title(const clap_plugin_t *plugin, const char *title) {(void) plugin; (void) title;}

static bool gui_show(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_hide(const clap_plugin_t *plugin) {(void) plugin; return true;}

static const clap_plugin_gui_t gui = {
    gui_is_api_supported, gui_get_preferred_api, gui_create, gui_destroy, gui_set_scale, gui_get_size, gui_can_resize,
    gui_get_resize_hints, gui_adjust_size, gui_set_size, gui_set_parent, gui_set_transient, gui_suggest_title, gui_show,
    gui_hide
};

// device panel: the window's page, 512 wide at the panel's 176
static bool panel_get_width(const clap_plugin_t *plugin, uint32_t height, uint32_t *width) {
    (void) plugin;
    *width = static_cast<uint32_t>(std::lround(static_cast<double>(height) * GUI_WIDTH / GUI_HEIGHT));
    return true;
}

static const opendaw_plugin_device_panel_t device_panel = {webview_get_uri, panel_get_width};

// ---- openDAW's sample slot 0: the host writes the frames into staging, commit makes them the sample ----

static float *samples_prepare(const clap_plugin_t *plugin, uint32_t key, uint32_t frames, uint32_t channels, double rate) {
    Xenon *xenon = xenon_of(plugin);
    if (key != 0 || frames == 0 || channels == 0 || rate < 1000.0 || rate > 384000.0 || frames > MAX_HOST_SECONDS * rate) {return nullptr;}
    std::free(xenon->staging);
    xenon->staging = static_cast<float *>(std::malloc(static_cast<size_t>(frames) * channels * sizeof(float)));
    xenon->staging_frames = frames;
    xenon->staging_channels = channels;
    xenon->staging_rate = rate;
    return xenon->staging;
}

static void samples_commit(const clap_plugin_t *plugin, uint32_t key) {
    Xenon *xenon = xenon_of(plugin);
    if (key != 0 || xenon->staging == nullptr) {return;}
    const uint32_t frames = xenon->staging_frames, channels = xenon->staging_channels;
    Sample *sample = sample_create(frames, xenon->staging_rate, xenon->host_name, static_cast<uint32_t>(std::strlen(xenon->host_name)));
    if (sample != nullptr) {
        // mixed to mono, as the page does
        for (uint32_t channel = 0; channel < channels; channel++) {
            const float *data = xenon->staging + static_cast<size_t>(channel) * frames;
            for (uint32_t index = 0; index < frames; index++) {sample->mono[index] += data[index] / channels;}
        }
        sample_peaks(sample);
        publish(xenon, sample);
        // a delivery after a project load is no edit: only a state that embedded the sample changes
        if (xenon->embedded) {mark_dirty(xenon);}
        xenon->embedded = false;
        if (xenon->host_webview != nullptr) {send_peaks(xenon);}
    }
    std::free(xenon->staging);
    xenon->staging = nullptr;
}

static void samples_clear(const clap_plugin_t *plugin, uint32_t key) {
    Xenon *xenon = xenon_of(plugin);
    if (key != 0 || xenon->latest == nullptr) {return;}
    if (clear_sample(xenon)) {
        xenon->embedded = false;
        mark_dirty(xenon);
        if (xenon->host_webview != nullptr) {send_peaks(xenon);}
    }
}

static const opendaw_plugin_samples_t plugin_samples = {samples_prepare, samples_commit, samples_clear};

static const void *xenon_get_extension(const clap_plugin_t *plugin, const char *id) {
    (void) plugin;
    if (std::strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {return &audio_ports;}
    if (std::strcmp(id, CLAP_EXT_NOTE_PORTS) == 0) {return &note_ports;}
    if (std::strcmp(id, CLAP_EXT_PARAMS) == 0) {return &params;}
    if (std::strcmp(id, CLAP_EXT_STATE) == 0) {return &state;}
    if (std::strcmp(id, CLAP_EXT_WEBVIEW) == 0) {return &webview;}
    if (std::strcmp(id, CLAP_EXT_GUI) == 0) {return &gui;}
    if (std::strcmp(id, OPENDAW_EXT_DEVICE_PANEL) == 0) {return &device_panel;}
    if (std::strcmp(id, OPENDAW_EXT_SAMPLES) == 0) {return &plugin_samples;}
    return nullptr;
}

static void xenon_on_main_thread(const clap_plugin_t *plugin) {collect_retired(xenon_of(plugin));}

static const clap_plugin_t *create(const clap_plugin_factory_t *factory, const clap_host_t *host, const char *plugin_id) {
    (void) factory;
    if (std::strcmp(plugin_id, descriptor.id) != 0) {return nullptr;}
    void *memory = std::calloc(1, sizeof(Xenon));
    if (memory == nullptr) {return nullptr;}
    Xenon *xenon = new(memory) Xenon();
    xenon->host = host;
    for (clap_id id = 0; id < PARAM_COUNT; id++) {xenon->values[id] = DEFS[id].value;}
    xenon->sample_rate = 48000.0;
    xenon->tempo = 120.0;
    xenon->random = 0x9e3779b9u;
    xenon->gui_width = GUI_WIDTH * 2;
    xenon->gui_height = GUI_HEIGHT * 2;
    xenon->plugin.desc = &descriptor;
    xenon->plugin.plugin_data = xenon;
    xenon->plugin.init = xenon_init;
    xenon->plugin.destroy = xenon_destroy;
    xenon->plugin.activate = xenon_activate;
    xenon->plugin.deactivate = xenon_deactivate;
    xenon->plugin.start_processing = xenon_start_processing;
    xenon->plugin.stop_processing = xenon_stop_processing;
    xenon->plugin.reset = xenon_reset;
    xenon->plugin.process = xenon_process;
    xenon->plugin.get_extension = xenon_get_extension;
    xenon->plugin.on_main_thread = xenon_on_main_thread;
    return &xenon->plugin;
}

static uint32_t plugin_count(const clap_plugin_factory_t *factory) {(void) factory; return 1;}

static const clap_plugin_descriptor_t *plugin_descriptor(const clap_plugin_factory_t *factory, uint32_t index) {
    (void) factory;
    return index == 0 ? &descriptor : nullptr;
}

static const clap_plugin_factory_t factory = {plugin_count, plugin_descriptor, create};

static bool entry_init(const char *path) {(void) path; return true;}

static void entry_deinit(void) {}

static const void *entry_get_factory(const char *id) {
    return std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : nullptr;
}

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entry_init, entry_deinit, entry_get_factory};
