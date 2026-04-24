const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── Presets de mix ──────────────────────────────────────────────────
// TRILHA MAIS PRESENTE — voz natural, pouca compressão.
//   0.45 ≈ -6.9 dB  | 0.40 ≈ -8.0 dB  | 0.50 ≈ -6.0 dB  | 0.55 ≈ -5.2 dB
const PRESETS = {
  varejo:        { bgVol: 0.45, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "varejo" },
  institucional: { bgVol: 0.40, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional" },
  radio_indoor:  { bgVol: 0.45, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "radio_indoor" },
  jingle:        { bgVol: 0.55, fadeIn: 1.0, fadeOut: 1.5, voicePreset: "jingle" },
  politica:      { bgVol: 0.40, fadeIn: 1.5, fadeOut: 1.5, voicePreset: "institucional" },
};

// ─── Presets de voz ──────────────────────────────────────────────────
// Compressão LEVE — preserva dinâmica natural da voz, sem som "esmagado".
// HPF 80Hz remove rumble | Presence boost 3kHz +2dB para clareza.
// Compressor ratio 2:1 threshold -20dB (suave) | makeup mínimo.
const VOICE_PRESETS = {
  varejo: {
    hpf: 80,
    presenceFreq: 3000,
    presenceGain: 2,
    presenceQ: 1.0,
    compThreshold: -20,
    compRatio: 2,
    compAttack: 8,
    compRelease: 180,
    compMakeup: 1.5,
    deesserFreq: 6500,
    deesserGain: -2,
  },
  institucional: {
    hpf: 80,
    presenceFreq: 2800,
    presenceGain: 1.5,
    presenceQ: 1.0,
    compThreshold: -22,
    compRatio: 2,
    compAttack: 10,
    compRelease: 200,
    compMakeup: 1.5,
    deesserFreq: 6500,
    deesserGain: -2,
  },
  radio_indoor: {
    hpf: 90,
    presenceFreq: 3200,
    presenceGain: 2.5,
    presenceQ: 1.0,
    compThreshold: -20,
    compRatio: 2.5,
    compAttack: 6,
    compRelease: 150,
    compMakeup: 2,
    deesserFreq: 6500,
    deesserGain: -2.5,
  },
  jingle: {
    hpf: 85,
    presenceFreq: 3000,
    presenceGain: 2,
    presenceQ: 1.0,
    compThreshold: -20,
    compRatio: 2,
    compAttack: 8,
    compRelease: 180,
    compMakeup: 1.5,
    deesserFreq: 6500,
    deesserGain: -2,
  },
};

// ─── Defaults ────────────────────────────────────────────────────────
const DEFAULT_BG_VOLUME_MAX_DB = -6;        // teto do limiter da trilha (era -10)
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -22; // compressor único, mais suave
const DEFAULT_BG_COMPRESS_RATIO = 3;          // antes era 6 (muito agressivo)

// ─── Utilidades ──────────────────────────────────────────────────────
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

// ─── Limpeza de take (voice isolator opcional) ───────────────────────
function cleanTake(inputFile, useIsolator = false) {
  const out = tmpFile("wav");
  const filters = ["highpass=f=80", "afftdn=nf=-25", "loudnorm=I=-16:TP=-1.5:LRA=11"];
  runFfmpeg(["-i", inputFile, "-af", filters.join(","), "-y", out]);
  return out;
}

// ─── Cadeia da voz ───────────────────────────────────────────────────
function buildVoiceChain(preset) {
  const v = VOICE_PRESETS[preset] || VOICE_PRESETS.varejo;
  return [
    `highpass=f=${v.hpf}`,
    `equalizer=f=${v.presenceFreq}:t=q:w=${v.presenceQ}:g=${v.presenceGain}`,
    `equalizer=f=${v.deesserFreq}:t=q:w=2:g=${v.deesserGain}`,
    `acompressor=threshold=${v.compThreshold}dB:ratio=${v.compRatio}:attack=${v.compAttack}:release=${v.compRelease}:makeup=${v.compMakeup}`,
    `loudnorm=I=-14:TP=-1:LRA=11`,
  ].join(",");
}

// ─── MIX padrão (voz + trilha) ───────────────────────────────────────
async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset = "varejo", outputFile = tmpFile("mp3") } = opts;
  const p = PRESETS[preset] || PRESETS.varejo;

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

  // Trilha: HPF leve → compressor único suave → volume → limiter teto
  const bgChain = [
    "highpass=f=40",
    `acompressor=threshold=${compThr}dB:ratio=${compRatio}:attack=15:release=200:makeup=1`,
    `volume=${bgVol.toFixed(4)}`,
    `afade=t=in:st=0:d=${p.fadeIn}`,
    `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${p.fadeOut}`,
    `alimiter=limit=${bgMaxLin.toFixed(4)}:level=disabled:asc=1`,
  ].join(",");

  const filter = [
    `[0:a]${voiceChain}[v]`,
    `[1:a]${bgChain}[b]`,
    `[v][b]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=0.95:level=disabled:asc=1[out]`,
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

// ─── MIX com jingle (sidechain ducking) ──────────────────────────────
async function processJingleMix(opts) {
  const {
    voiceUrl, jingleUrl, preset = "varejo",
    jingleVoiceStart = 3, jingleEndTime,
    outputFile = tmpFile("mp3"),
  } = opts;
  const p = PRESETS[preset] || PRESETS.varejo;

  const voiceFile = tmpFile("mp3");
  const jingleFile = tmpFile("mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(jingleUrl, jingleFile)]);

  const voiceDur = ffprobeDuration(voiceFile);
  const jingleDur = ffprobeDuration(jingleFile);
  const endTime = jingleEndTime || (jingleVoiceStart + voiceDur + 2);
  const totalDur = Math.max(jingleDur, endTime + 1);

  const voiceChain = buildVoiceChain(p.voicePreset);

  const filter = [
    `[0:a]${voiceChain},adelay=${Math.round(jingleVoiceStart * 1000)}|${Math.round(jingleVoiceStart * 1000)}[v]`,
    `[1:a]volume=0.85[j]`,
    `[j][v]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=300[ducked]`,
    `[ducked][v]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    `[mix]alimiter=limit=0.95:level=disabled:asc=1[out]`,
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

// ─── Voz solo (sem trilha) ───────────────────────────────────────────
async function processVoiceOnly(opts) {
  const { voiceUrl, preset = "varejo", outputFile = tmpFile("mp3") } = opts;
  const p = PRESETS[preset] || PRESETS.varejo;

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
