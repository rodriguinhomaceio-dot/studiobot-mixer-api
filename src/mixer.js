const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER (novos) ────────────────────────────────────────
// comp = CLA-3A (compressão moderada) | width = estéreo | limit = atuação L2
// ceiling = teto em dB | release = soltura do limiter
// + campos legados (bgVol, fadeIn, fadeOut, voicePreset) usados pela mixagem
const PRESETS = {
  nd_padrao: {
    comp: 0.45, width: 1.43, limit: 0.45, ceiling: -0.8, release: 1.0,
    bgVol: 0.40, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_agressivo: {
    comp: 0.60, width: 1.50, limit: 0.70, ceiling: -0.8, release: 0.7,
    bgVol: 0.42, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "varejo",
  },
  nd_voice: {
    comp: 0.35, width: 1.20, limit: 0.35, ceiling: -1.0, release: 1.2,
    bgVol: 0.35, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
  nd_jingle: {
    comp: 0.55, width: 1.45, limit: 0.65, ceiling: -0.8, release: 0.8,
    bgVol: 0.50, fadeIn: 1.0, fadeOut: 1.5, voicePreset: "jingle",
  },
  nd_institucional: {
    comp: 0.40, width: 1.30, limit: 0.40, ceiling: -0.9, release: 1.1,
    bgVol: 0.38, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
};

// Aliases pra compatibilidade com chamadas antigas (varejo, institucional, etc.)
PRESETS.varejo        = PRESETS.nd_padrao;
PRESETS.institucional = PRESETS.nd_institucional;
PRESETS.radio_indoor  = PRESETS.nd_padrao;
PRESETS.jingle        = PRESETS.nd_jingle;
PRESETS.politica      = PRESETS.nd_institucional;

// ─── PRESETS DE VOZ ───────────────────────────────────────────────────
// SEM compressão. Apenas HPF, presence boost suave, de-esser e loudnorm.
// Volume final reduzido em ~1.7 dB (volume=0.82) para a voz não estourar a trilha.
const VOICE_PRESETS = {
  varejo: {
    hpf: 80,
    presenceFreq: 3000, presenceGain: 2,   presenceQ: 1.0,
    deesserFreq: 6500,  deesserGain: -2,
    volume: 0.82,
  },
  institucional: {
    hpf: 80,
    presenceFreq: 2800, presenceGain: 1.5, presenceQ: 1.0,
    deesserFreq: 6500,  deesserGain: -2,
    volume: 0.82,
  },
  radio_indoor: {
    hpf: 90,
    presenceFreq: 3200, presenceGain: 2.5, presenceQ: 1.0,
    deesserFreq: 6500,  deesserGain: -2.5,
    volume: 0.82,
  },
  jingle: {
    hpf: 85,
    presenceFreq: 3000, presenceGain: 2,   presenceQ: 1.0,
    deesserFreq: 6500,  deesserGain: -2,
    volume: 0.82,
  },
};

// ─── Defaults ─────────────────────────────────────────────────────────
const DEFAULT_BG_VOLUME_MAX_DB = -6;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -22;
const DEFAULT_BG_COMPRESS_RATIO = 3;

// ─── Utilidades ───────────────────────────────────────────────────────
function runFfmpeg(args) {
  try {
    execFileSync("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : String(err);
    throw new Error(`ffmpeg failed: ${stderr.substring(0, 500)}`);
  }
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]).toString().trim();
    return parseFloat(out) || 0;
  } catch { return 0; }
}

async function downloadFile(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed ${resp.status}: ${url}`);
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

// ─── Limpeza de take (voice isolator opcional) ────────────────────────
function cleanTake(inputFile, useIsolator = false) {
  const out = tmpFile("wav");
  const filters = ["highpass=f=80", "afftdn=nf=-25", "loudnorm=I=-16:TP=-1.5:LRA=11"];
  runFfmpeg(["-i", inputFile, "-af", filters.join(","), "-y", out]);
  return out;
}

// ─── Cadeia da voz (SEM COMPRESSÃO + volume reduzido) ─────────────────
function buildVoiceChain(preset) {
  const v = VOICE_PRESETS[preset] || VOICE_PRESETS.varejo;
  return [
    `highpass=f=${v.hpf}`,
    `equalizer=f=${v.presenceFreq}:t=q:w=${v.presenceQ}:g=${v.presenceGain}`,
    `equalizer=f=${v.deesserFreq}:t=q:w=2:g=${v.deesserGain}`,
    `loudnorm=I=-15:TP=-1.5:LRA=11`,
    `volume=${(v.volume ?? 0.82).toFixed(3)}`,
  ].join(",");
}

// ─── MIX padrão (voz + trilha) ────────────────────────────────────────
async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset = "nd_padrao", outputFile = tmpFile("mp3") } = opts;
  const p = PRESETS[preset] || PRESETS.nd_padrao;

  const voiceFile = tmpFile("mp3");
  const bgFile = tmpFile("mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(bgUrl, bgFile)]);

  const voiceDur = ffprobeDuration(voiceFile);
  const totalDur = voiceDur + p.fadeOut + 0.5;
  const bgVol = typeof opts.bgVolume === "number" ? opts.bgVolume : p.bgVol;
  const fadeOutStart = Math.max(p.fadeIn, voiceDur - p.fadeOut);
  const compThr = typeof opts.bgCompressThreshold === "number" ? opts.bgCompressThreshold : DEFAULT_BG_COMPRESS_THRESHOLD_DB;
  const compRatio = typeof opts.bgCompressRatio === "number" ? opts.bgCompressRatio : DEFAULT_BG_COMPRESS_RATIO;
  const bgMaxDb = typeof opts.bgVolumeMax === "number" ? opts.bgVolumeMax : DEFAULT_BG_VOLUME_MAX_DB;
  const bgMaxLin = Math.min(dbToLinear(bgMaxDb), bgVol);

  const voiceChain = buildVoiceChain(p.voicePreset);

  const bgChain = [
    "highpass=f=40",
    `acompressor=threshold=${compThr}dB:ratio=${compRatio}:attack=15:release=200:makeup=1`,
    `volume=${bgVol.toFixed(4)}`,
    `afade=t=in:st=0:d=${p.fadeIn}`,
    `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${p.fadeOut}`,
    `alimiter=limit=${bgMaxLin.toFixed(4)}:level=disabled:asc=1`,
  ].join(",");

  // Master final: limiter usando ceiling do preset (convertido de dB para linear)
  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);

  const filter = [
    `[0:a]${voiceChain}[v]`,
    `[1:a]${bgChain}[b]`,
    `[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
  ].join(";");

  runFfmpeg([
    "-i", voiceFile,
    "-stream_loop", "-1", "-i", bgFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", totalDur.toFixed(2),
    "-c:a", "libmp3lame", "-b:a", "192k",
    "-ar", "44100", "-ac", "2",
    "-y", outputFile,
  ]);

  try { fs.unlinkSync(voiceFile); fs.unlinkSync(bgFile); } catch {}
  return outputFile;
}

// ─── MIX com jingle (sidechain ducking) ───────────────────────────────
async function processJingleMix(opts) {
  const {
    voiceUrl, jingleUrl, preset = "nd_jingle",
    jingleVoiceStart = 3, jingleEndTime,
    outputFile = tmpFile("mp3"),
  } = opts;
  const p = PRESETS[preset] || PRESETS.nd_jingle;

  const voiceFile = tmpFile("mp3");
  const jingleFile = tmpFile("mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(jingleUrl, jingleFile)]);

  const voiceDur = ffprobeDuration(voiceFile);
  const jingleDur = ffprobeDuration(jingleFile);
  const endTime = jingleEndTime || (jingleVoiceStart + voiceDur + 2);
  const totalDur = Math.max(jingleDur, endTime + 1);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);

  const filter = [
    `[0:a]${voiceChain},adelay=${Math.round(jingleVoiceStart * 1000)}|${Math.round(jingleVoiceStart * 1000)}[v]`,
    `[1:a]volume=0.85[j]`,
    `[j][v]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[ducked]`,
    `[ducked][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
  ].join(";");

  runFfmpeg([
    "-i", voiceFile, "-i", jingleFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-t", totalDur.toFixed(2),
    "-c:a", "libmp3lame", "-b:a", "192k",
    "-ar", "44100", "-ac", "2",
    "-y", outputFile,
  ]);

  try { fs.unlinkSync(voiceFile); fs.unlinkSync(jingleFile); } catch {}
  return outputFile;
}

// ─── Voz solo (sem trilha) ────────────────────────────────────────────
async function processVoiceOnly(opts) {
  const { voiceUrl, preset = "nd_voice", outputFile = tmpFile("mp3") } = opts;
  const p = PRESETS[preset] || PRESETS.nd_voice;

  const voiceFile = tmpFile("mp3");
  await downloadFile(voiceUrl, voiceFile);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const filter = `[0:a]${voiceChain}[out]`;

  runFfmpeg(["-i", voiceFile, "-filter_complex", filter, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "192k", "-y", outputFile]);

  try { fs.unlinkSync(voiceFile); } catch {}
  return outputFile;
}

async function mixAudio(opts) {
  if (opts.voiceOnly) return processVoiceOnly(opts);
  if (opts.jingleUrl) return processJingleMix(opts);
  return processStandardMix(opts);
}

module.exports = { mixAudio, cleanTake, VOICE_PRESETS, PRESETS };
