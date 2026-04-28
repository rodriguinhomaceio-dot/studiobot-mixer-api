const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER ────────────────────────────────────────────────
// Voz mais baixa, trilha mais alta e presente
const PRESETS = {
  nd_padrao: {
    comp: 0.25, width: 1.35, limit: 0.32, ceiling: -0.6, release: 1.2,
    bgVol: 0.92, fadeIn: 1.2, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_agressivo: {
    comp: 0.32, width: 1.42, limit: 0.42, ceiling: -0.6, release: 1.0,
    bgVol: 0.98, fadeIn: 1.2, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_voice: {
    comp: 0.20, width: 1.15, limit: 0.25, ceiling: -1.0, release: 1.4,
    bgVol: 0.00, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
  nd_jingle: {
    comp: 0.34, width: 1.38, limit: 0.44, ceiling: -0.6, release: 1.0,
    bgVol: 1.05, fadeIn: 1.0, fadeOut: 1.5, voicePreset: "jingle",
  },
  nd_institucional: {
    comp: 0.22, width: 1.25, limit: 0.30, ceiling: -0.7, release: 1.3,
    bgVol: 0.88, fadeIn: 1.8, fadeOut: 2.0, voicePreset: "institucional",
  },
};

// Aliases
PRESETS.varejo = PRESETS.nd_padrao;
PRESETS.institucional = PRESETS.nd_institucional;
PRESETS.radio_indoor = PRESETS.nd_padrao;
PRESETS.jingle = PRESETS.nd_jingle;
PRESETS.politica = PRESETS.nd_institucional;

// ─── PRESETS DE VOZ ───────────────────────────────────────────────────
// Voz menor, mais natural, MENOS compressão (LRA maior, target mais baixo)
const VOICE_PRESETS = {
  varejo: {
    hpf: 75,
    presenceFreq: 3000,
    presenceGain: 0.6,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.0,
    loudnormI: -22,
    loudnormLRA: 18,
    volume: 0.42,
  },
  institucional: {
    hpf: 75,
    presenceFreq: 2800,
    presenceGain: 0.5,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.0,
    loudnormI: -22.5,
    loudnormLRA: 18,
    volume: 0.40,
  },
  radio_indoor: {
    hpf: 80,
    presenceFreq: 3200,
    presenceGain: 0.8,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.3,
    loudnormI: -22,
    loudnormLRA: 18,
    volume: 0.42,
  },
  jingle: {
    hpf: 80,
    presenceFreq: 3000,
    presenceGain: 0.6,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.0,
    loudnormI: -21.5,
    loudnormLRA: 18,
    volume: 0.44,
  },
};

// ─── Defaults ─────────────────────────────────────────────────────────
// Trilha com teto mais alto e compressão mais suave
const DEFAULT_BG_VOLUME_MAX_DB = -0.8;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -14;
const DEFAULT_BG_COMPRESS_RATIO = 1.4;
const BG_END_GAP_SEC = 1.5;

// ─── Utilidades ───────────────────────────────────────────────────────
function runFfmpeg(args) {
  try {
    execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : String(err);
    throw new Error(`ffmpeg failed: ${stderr.substring(0, 700)}`);
  }
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]).toString().trim();
    return parseFloat(out) || 0;
  } catch {
    return 0;
  }
}

async function downloadFile(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`download failed ${resp.status}: ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `mix-${uuidv4()}.${ext}`);
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// Resolve volume (linear) com prioridade: bgVolumeDb > bgVolume > default
function resolveBgVol(opts, fallbackLinear) {
  if (typeof opts.bgVolumeDb === "number") return dbToLinear(opts.bgVolumeDb);
  if (typeof opts.bgVolume === "number") return opts.bgVolume;
  return fallbackLinear;
}

// ─── Limpeza de take ──────────────────────────────────────────────────
// Mais natural, sem loudness agressivo, menos compressão
function cleanTake(inputFile, useIsolator = false) {
  const out = tmpFile("wav");
  const filters = [
    "highpass=f=75",
    "afftdn=nf=-18",
    "loudnorm=I=-22:TP=-1.5:LRA=18",
  ];
  runFfmpeg([
    "-i", inputFile,
    "-af", filters.join(","),
    "-y", out,
  ]);
  return out;
}

// ─── Cadeia da voz ────────────────────────────────────────────────────
// Voz mais baixa e MENOS comprimida (LRA aumentado)
function buildVoiceChain(preset) {
  const v = VOICE_PRESETS[preset] || VOICE_PRESETS.varejo;
  const lra = v.loudnormLRA || 18;
  return [
    `highpass=f=${v.hpf}`,
    `equalizer=f=${v.presenceFreq}:t=q:w=${v.presenceQ}:g=${v.presenceGain}`,
    `equalizer=f=${v.deesserFreq}:t=q:w=2:g=${v.deesserGain}`,
    `loudnorm=I=${v.loudnormI}:TP=-1.5:LRA=${lra}`,
    `volume=${v.volume.toFixed(3)}`,
  ].join(",");
}

// ─── MIX padrão voz + trilha ──────────────────────────────────────────
async function processStandardMix(opts) {
  const {
    voiceUrl,
    bgUrl,
    preset = "nd_padrao",
    outputFile = tmpFile("mp3"),
  } = opts;

  const p = PRESETS[preset] || PRESETS.nd_padrao;
  const voiceFile = tmpFile("mp3");
  const bgFile = tmpFile("mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(bgUrl, bgFile),
  ]);

  const voiceDur = ffprobeDuration(voiceFile);
  const bgEndTime = Math.max(
    p.fadeIn + p.fadeOut + 0.1,
    voiceDur - BG_END_GAP_SEC
  );
  const fadeOutStart = Math.max(p.fadeIn, bgEndTime - p.fadeOut);
  const totalDur = voiceDur + 0.5;

  // Volume da trilha: bgVolumeDb (dB) > bgVolume (linear) > preset default
  const bgVol = resolveBgVol(opts, p.bgVol);

  const compThr =
    typeof opts.bgCompressThreshold === "number"
      ? opts.bgCompressThreshold
      : DEFAULT_BG_COMPRESS_THRESHOLD_DB;
  const compRatio =
    typeof opts.bgCompressRatio === "number"
      ? opts.bgCompressRatio
      : DEFAULT_BG_COMPRESS_RATIO;
  const bgMaxDb =
    typeof opts.bgVolumeMax === "number"
      ? opts.bgVolumeMax
      : DEFAULT_BG_VOLUME_MAX_DB;
  const bgMaxLin = dbToLinear(bgMaxDb);

  const masterCeiling = dbToLinear(p.ceiling ?? -0.6);
  const voiceChain = buildVoiceChain(p.voicePreset);

  const bgChain = [
    "highpass=f=35",
    `acompressor=threshold=${compThr}dB:ratio=${compRatio}:attack=20:release=250:makeup=1.05`,
    `volume=${bgVol.toFixed(4)}`,
    `afade=t=in:st=0:d=${p.fadeIn}`,
    `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${p.fadeOut}`,
    `atrim=0:${bgEndTime.toFixed(2)}`,
    `apad=pad_dur=${BG_END_GAP_SEC + 0.5}`,
    `alimiter=limit=${bgMaxLin.toFixed(4)}:level=disabled:asc=1`,
  ].join(",");

  const filter = [
    `[0:a]${voiceChain}[v]`,
    `[1:a]${bgChain}[b]`,
    `[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
  ].join(";");

  runFfmpeg([
    "-i", voiceFile,
    "-stream_loop", "-1",
    "-i", bgFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", totalDur.toFixed(2),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-y", outputFile,
  ]);

  try {
    fs.unlinkSync(voiceFile);
    fs.unlinkSync(bgFile);
  } catch {}

  return outputFile;
}

// ─── MIX com jingle ───────────────────────────────────────────────────
// Sidechain mais suave para o jingle "respirar" mais
async function processJingleMix(opts) {
  const {
    voiceUrl,
    jingleUrl,
    preset = "nd_jingle",
    jingleVoiceStart = 3,
    jingleEndTime,
    outputFile = tmpFile("mp3"),
  } = opts;

  const p = PRESETS[preset] || PRESETS.nd_jingle;
  const voiceFile = tmpFile("mp3");
  const jingleFile = tmpFile("mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(jingleUrl, jingleFile),
  ]);

  const voiceDur = ffprobeDuration(voiceFile);
  const jingleDur = ffprobeDuration(jingleFile);
  const endTime = jingleEndTime || jingleVoiceStart + voiceDur + 2;
  const totalDur = Math.max(jingleDur, endTime + 1);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const masterCeiling = dbToLinear(p.ceiling ?? -0.6);

  // Volume do jingle: bgVolumeDb (dB) > bgVolume (linear) > preset default
  const jingleVol = resolveBgVol(opts, p.bgVol);

  const filter = [
    `[0:a]${voiceChain},adelay=${Math.round(jingleVoiceStart * 1000)}|${Math.round(jingleVoiceStart * 1000)}[v]`,
    `[1:a]volume=${jingleVol.toFixed(4)}[j]`,
    `[j][v]sidechaincompress=threshold=0.12:ratio=2.8:attack=15:release=400[ducked]`,
    `[ducked][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
  ].join(";");

  runFfmpeg([
    "-i", voiceFile,
    "-i", jingleFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", totalDur.toFixed(2),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-y", outputFile,
  ]);

  try {
    fs.unlinkSync(voiceFile);
    fs.unlinkSync(jingleFile);
  } catch {}

  return outputFile;
}

// ─── Voz solo ─────────────────────────────────────────────────────────
async function processVoiceOnly(opts) {
  const {
    voiceUrl,
    preset = "nd_voice",
    outputFile = tmpFile("mp3"),
  } = opts;

  const p = PRESETS[preset] || PRESETS.nd_voice;
  const voiceFile = tmpFile("mp3");
  await downloadFile(voiceUrl, voiceFile);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const filter = `[0:a]${voiceChain}[out]`;

  runFfmpeg([
    "-i", voiceFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-y", outputFile,
  ]);

  try {
    fs.unlinkSync(voiceFile);
  } catch {}

  return outputFile;
}

// ─── Entrada principal ────────────────────────────────────────────────
async function mixAudio(opts) {
  if (opts.voiceOnly) return processVoiceOnly(opts);
  if (opts.jingleUrl) return processJingleMix(opts);
  return processStandardMix(opts);
}

module.exports = {
  mixAudio,
  cleanTake,
  VOICE_PRESETS,
  PRESETS,
};
