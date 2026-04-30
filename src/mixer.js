const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER ────────────────────────────────────────────────
// Voz à frente, trilha bem discreta (mais baixa)
const PRESETS = {
  nd_padrao: {
    comp: 0.25, width: 1.35, limit: 0.32, ceiling: -0.3, release: 1.2,
    bgVol: 0.18, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "varejo",
  },
  nd_agressivo: {
    comp: 0.32, width: 1.42, limit: 0.42, ceiling: -0.3, release: 1.0,
    bgVol: 0.20, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "varejo",
  },
  nd_voice: {
    comp: 0.20, width: 1.15, limit: 0.25, ceiling: -0.3, release: 1.4,
    bgVol: 0.00, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
  },
  nd_jingle: {
    comp: 0.34, width: 1.38, limit: 0.44, ceiling: -0.3, release: 1.0,
    bgVol: 0.32, fadeIn: 1.0, fadeOut: 0.6, voicePreset: "jingle",
  },
  nd_institucional: {
    comp: 0.22, width: 1.25, limit: 0.30, ceiling: -0.3, release: 1.3,
    bgVol: 0.15, fadeIn: 1.8, fadeOut: 0.6, voicePreset: "institucional",
  },
};

// Aliases
PRESETS.varejo = PRESETS.nd_padrao;
PRESETS.institucional = PRESETS.nd_institucional;
PRESETS.radio_indoor = PRESETS.nd_padrao;
PRESETS.jingle = PRESETS.nd_jingle;
PRESETS.politica = PRESETS.nd_institucional;

// ─── PRESETS DE VOZ ───────────────────────────────────────────────────
// Voz à frente, com leve compressão para presença consistente
// comp: { threshold (dB), ratio, attack (ms), release (ms), makeup }
const VOICE_PRESETS = {
  varejo: {
    hpf: 75,
    presenceFreq: 3000,
    presenceGain: 1.2,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.2,
    comp: { threshold: -18, ratio: 2.2, attack: 8, release: 180, makeup: 1.05 },
    loudnormI: -19,
    loudnormLRA: 14,
    volume: 0.55,
  },
  institucional: {
    hpf: 75,
    presenceFreq: 2800,
    presenceGain: 0.9,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.0,
    comp: { threshold: -20, ratio: 2.0, attack: 10, release: 220, makeup: 1.04 },
    loudnormI: -19.5,
    loudnormLRA: 15,
    volume: 0.52,
  },
  radio_indoor: {
    hpf: 80,
    presenceFreq: 3200,
    presenceGain: 1.4,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.3,
    comp: { threshold: -18, ratio: 2.4, attack: 8, release: 180, makeup: 1.06 },
    loudnormI: -19,
    loudnormLRA: 14,
    volume: 0.56,
  },
  jingle: {
    hpf: 80,
    presenceFreq: 3000,
    presenceGain: 1.2,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.0,
    comp: { threshold: -17, ratio: 2.5, attack: 8, release: 160, makeup: 1.06 },
    loudnormI: -18.5,
    loudnormLRA: 13,
    volume: 0.58,
  },
};

// ─── Defaults ─────────────────────────────────────────────────────────
// Trilha bem discreta: teto baixo e compressão firme
const DEFAULT_BG_VOLUME_MAX_DB = -12.0;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -16;
const DEFAULT_BG_COMPRESS_RATIO = 1.8;

// Trilha termina JUNTO com a voz (sem gap)
const BG_END_GAP_SEC = 0;

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

// Mantém o volume da trilha fixo pelo preset (sem override por request).
function resolveBgVol(fallbackLinear) {
  return fallbackLinear;
}

// Resolve gap final da trilha (segundos antes do fim da voz)
// Por padrão 0 — trilha termina junto com a voz
function resolveBgEndGap(opts) {
  let gap = BG_END_GAP_SEC;
  if (typeof opts.bgEndOffset === "number") gap = opts.bgEndOffset;
  else if (typeof opts.bg_end_offset === "number") gap = opts.bg_end_offset;
  return Math.max(gap, 0);
}

// Resolve teto absoluto da trilha (dB) — fixo (sem override por request)
function resolveBgVolumeMax() {
  return DEFAULT_BG_VOLUME_MAX_DB;
}

// ─── Limpeza de take ──────────────────────────────────────────────────
async function cleanTake(input, useIsolator = false) {
  const out = tmpFile("mp3");
  let inputFile = input;
  let downloadedInputFile = null;

  if (input && typeof input === "object") {
    if (!input.voiceUrl) {
      throw new Error("cleanTake requires voiceUrl");
    }
    downloadedInputFile = tmpFile("mp3");
    await downloadFile(input.voiceUrl, downloadedInputFile);
    inputFile = downloadedInputFile;
  }

  const filters = [
    "highpass=f=75",
    "afftdn=nf=-18",
    "loudnorm=I=-20:TP=-1.5:LRA=15",
  ];
  runFfmpeg([
    "-i", inputFile,
    "-af", filters.join(","),
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    "-y", out,
  ]);

  if (downloadedInputFile) {
    try {
      fs.unlinkSync(downloadedInputFile);
    } catch {}
  }

  return out;
}

// ─── Cadeia da voz ────────────────────────────────────────────────────
function buildVoiceChain(preset) {
  const v = VOICE_PRESETS[preset] || VOICE_PRESETS.varejo;
  const lra = v.loudnormLRA || 14;
  const c = v.comp || { threshold: -18, ratio: 2.2, attack: 8, release: 180, makeup: 1.05 };
  return [
    `highpass=f=${v.hpf}`,
    `equalizer=f=${v.presenceFreq}:t=q:w=${v.presenceQ}:g=${v.presenceGain}`,
    `equalizer=f=${v.deesserFreq}:t=q:w=2:g=${v.deesserGain}`,
    `acompressor=threshold=${c.threshold}dB:ratio=${c.ratio}:attack=${c.attack}:release=${c.release}:makeup=${c.makeup}`,
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

  // Gap final da trilha (padrão 0 — trilha termina junto com a voz)
  const bgEndGap = resolveBgEndGap(opts);
  const bgEndTime = Math.max(
    p.fadeIn + p.fadeOut + 0.1,
    voiceDur - bgEndGap
  );
  const fadeOutStart = Math.max(p.fadeIn, bgEndTime - p.fadeOut);
  const totalDur = voiceDur + 0.5;

  const bgVol = resolveBgVol(p.bgVol);
  const compThr =
    typeof opts.bgCompressThreshold === "number"
      ? opts.bgCompressThreshold
      : (typeof opts.bg_compress_threshold === "number"
        ? opts.bg_compress_threshold
        : DEFAULT_BG_COMPRESS_THRESHOLD_DB);
  const compRatio =
    typeof opts.bgCompressRatio === "number"
      ? opts.bgCompressRatio
      : (typeof opts.bg_compress_ratio === "number"
        ? opts.bg_compress_ratio
        : DEFAULT_BG_COMPRESS_RATIO);

  const bgMaxDb = resolveBgVolumeMax();
  const bgMaxLin = dbToLinear(bgMaxDb);
  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const bgChain = [
    "highpass=f=35",
    `acompressor=threshold=${compThr}dB:ratio=${compRatio}:attack=20:release=250:makeup=1.0`,
    `volume=${bgVol.toFixed(4)}`,
    `afade=t=in:st=0:d=${p.fadeIn}`,
    `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${p.fadeOut}`,
    `atrim=0:${bgEndTime.toFixed(2)}`,
    `apad=pad_dur=${bgEndGap + 0.5}`,
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
  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);
  const jingleVol = resolveBgVol(p.bgVol);

  const filter = [
    `[0:a]${voiceChain},adelay=${Math.round(jingleVoiceStart * 1000)}|${Math.round(jingleVoiceStart * 1000)}[v]`,
    `[1:a]volume=${jingleVol.toFixed(4)}[j]`,
    `[j][v]sidechaincompress=threshold=0.08:ratio=4:attack=10:release=350[ducked]`,
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
