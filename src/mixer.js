const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER ────────────────────────────────────────────────
// Ajustado: trilha mais presente e limiter mais leve
const PRESETS = {
  nd_padrao: {
    comp: 0.30, width: 1.35, limit: 0.35, ceiling: -0.9, release: 1.2,
    bgVol: 0.56, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_agressivo: {
    comp: 0.42, width: 1.42, limit: 0.50, ceiling: -0.9, release: 1.0,
    bgVol: 0.58, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_voice: {
    comp: 0.25, width: 1.15, limit: 0.30, ceiling: -1.0, release: 1.4,
    bgVol: 0.00, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
  nd_jingle: {
    comp: 0.38, width: 1.38, limit: 0.48, ceiling: -0.9, release: 1.0,
    bgVol: 0.64, fadeIn: 1.0, fadeOut: 1.5, voicePreset: "jingle",
  },
  nd_institucional: {
    comp: 0.28, width: 1.25, limit: 0.32, ceiling: -1.0, release: 1.3,
    bgVol: 0.54, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
};

// aliases
PRESETS.varejo = PRESETS.nd_padrao;
PRESETS.institucional = PRESETS.nd_institucional;
PRESETS.radio_indoor = PRESETS.nd_padrao;
PRESETS.jingle = PRESETS.nd_jingle;
PRESETS.politica = PRESETS.nd_institucional;

// ─── PRESETS DE VOZ ───────────────────────────────────────────────────
// MAIS NATURAL (menos loudness esmagado)
const VOICE_PRESETS = {
  varejo: {
    hpf: 75,
    presenceFreq: 3000, presenceGain: 1.2, presenceQ: 1.0,
    deesserFreq: 6500, deesserGain: -1.5,
    loudnormI: -18.5,
    volume: 0.64,
  },
  institucional: {
    hpf: 75,
    presenceFreq: 2800, presenceGain: 1.0, presenceQ: 1.0,
    deesserFreq: 6500, deesserGain: -1.5,
    loudnormI: -19,
    volume: 0.63,
  },
  radio_indoor: {
    hpf: 80,
    presenceFreq: 3200, presenceGain: 1.5, presenceQ: 1.0,
    deesserFreq: 6500, deesserGain: -2,
    loudnormI: -18.5,
    volume: 0.64,
  },
  jingle: {
    hpf: 80,
    presenceFreq: 3000, presenceGain: 1.2, presenceQ: 1.0,
    deesserFreq: 6500, deesserGain: -1.5,
    loudnormI: -18,
    volume: 0.65,
  },
};

// ─── DEFAULTS ─────────────────────────────────────────────────────────
const DEFAULT_BG_VOLUME_MAX_DB = -3.5;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -18;
const DEFAULT_BG_COMPRESS_RATIO = 2;
const BG_END_GAP_SEC = 1.5;

// ─── UTILS ────────────────────────────────────────────────────────────
function runFfmpeg(args) {
  try {
    execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(err.stderr?.toString() || err.message);
  }
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

async function downloadFile(url, dest) {
  const resp = await fetch(url);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `mix-${uuidv4()}.${ext}`);
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// ─── LIMPEZA VOZ ──────────────────────────────────────────────────────
function cleanTake(inputFile) {
  const out = tmpFile("wav");
  runFfmpeg([
    "-i", inputFile,
    "-af",
    "highpass=f=75,afftdn=nf=-20,loudnorm=I=-18:TP=-1.5:LRA=13",
    "-y", out
  ]);
  return out;
}

// ─── VOZ CHAIN ────────────────────────────────────────────────────────
function buildVoiceChain(preset) {
  const v = VOICE_PRESETS[preset] || VOICE_PRESETS.varejo;
  return [
    `highpass=f=${v.hpf}`,
    `equalizer=f=${v.presenceFreq}:t=q:w=${v.presenceQ}:g=${v.presenceGain}`,
    `equalizer=f=${v.deesserFreq}:t=q:w=2:g=${v.deesserGain}`,
    `loudnorm=I=${v.loudnormI}:TP=-1.5:LRA=13`,
    `volume=${v.volume.toFixed(3)}`
  ].join(",");
}

// ─── MIX PRINCIPAL ────────────────────────────────────────────────────
async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset = "nd_padrao", outputFile = tmpFile("mp3") } = opts;
  const p = PRESETS[preset] || PRESETS.nd_padrao;

  const voiceFile = tmpFile("mp3");
  const bgFile = tmpFile("mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(bgUrl, bgFile)
  ]);

  const voiceDur = ffprobeDuration(voiceFile);

  const bgEndTime = Math.max(p.fadeIn + p.fadeOut, voiceDur - BG_END_GAP_SEC);
  const fadeOutStart = bgEndTime - p.fadeOut;
  const totalDur = voiceDur + 0.5;

  const bgMaxLin = dbToLinear(DEFAULT_BG_VOLUME_MAX_DB);

  const filter = [
    `[0:a]${buildVoiceChain(p.voicePreset)}[v]`,
    `[1:a]highpass=f=40,acompressor=threshold=${DEFAULT_BG_COMPRESS_THRESHOLD_DB}dB:ratio=${DEFAULT_BG_COMPRESS_RATIO}:attack=15:release=200,volume=${p.bgVol},afade=t=in:st=0:d=${p.fadeIn},afade=t=out:st=${fadeOutStart}:d=${p.fadeOut},atrim=0:${bgEndTime},apad=pad_dur=2,alimiter=limit=${bgMaxLin}[b]`,
    `[v][b]amix=inputs=2:duration=first`,
    `[0:a][1:a]anull[out]`
  ].join(";");

  runFfmpeg([
    "-i", voiceFile,
    "-stream_loop", "-1", "-i", bgFile,
    "-filter_complex", filter,
    "-map", "0:a",
    "-t", totalDur,
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-y", outputFile
  ]);

  return outputFile;
}

// ─── VOZ ONLY ─────────────────────────────────────────────────────────
async function processVoiceOnly(opts) {
  const { voiceUrl, preset = "nd_voice", outputFile = tmpFile("mp3") } = opts;

  const voiceFile = tmpFile("mp3");
  await downloadFile(voiceUrl, voiceFile);

  runFfmpeg([
    "-i", voiceFile,
    "-af", buildVoiceChain(PRESETS[preset].voicePreset),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-y", outputFile
  ]);

  return outputFile;
}

// ─── ENTRY ────────────────────────────────────────────────────────────
async function mixAudio(opts) {
  if (opts.voiceOnly) return processVoiceOnly(opts);
  return processStandardMix(opts);
}

module.exports = { mixAudio, cleanTake };
