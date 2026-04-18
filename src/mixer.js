const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MIX ──────────────────────────────────────────────────
// Padrão extraído do "EDIT_MIX_RADIO_HONDA_HRV": rádio FM brasileira,
// trilha presente equilibrada com voz dominante.
const PRESETS = {
  varejo:        { voiceVol: 1.0, bgVol: 0.32, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "radio_fm_br" },
  institucional: { voiceVol: 1.0, bgVol: 0.30, fadeIn: 2.0, fadeOut: 1.5, voicePreset: "radio_fm_br" },
  radio_indoor:  { voiceVol: 1.0, bgVol: 0.32, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "radio_fm_br" },
  jingle:        { voiceVol: 1.0, bgVol: 0.65, fadeIn: 1.0, fadeOut: 1.2, voicePreset: "radio_fm_br" },
  politica:      { voiceVol: 1.0, bgVol: 0.30, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "radio_fm_br" },
};

const DEFAULT_BG_END_OFFSET_SEC = 0.5;
const DEFAULT_BG_VOLUME_MAX_DB = -7;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -26;
const DEFAULT_BG_COMPRESS_RATIO = 3;

// ─── MASTER PADRÃO RÁDIO FM (extraído do referência Honda HRV) ───────
//   I: -9.8 LUFS | LRA: 1.1 | TP: +0.6 dBFS
// Aplicamos -10 LUFS, LRA 3, TP -0.3 (margem mínima pra não clipar)
const MASTER_RADIO_FM = {
  lufs: -10,
  truePeak: -0.3,
  lra: 3,
  glueThreshold: -18,
  glueRatio: 6,
  glueAttack: 10,
  glueRelease: 80,
  glueMakeup: 2,
};

// ─── TIME STRETCH ────────────────────────────────────────────────────
// IMPORTANTE: só aplica quando áudio EXCEDE o target (ratio > 1).
// Se áudio está dentro ou abaixo do tempo, NÃO mexe.
const TIME_STRETCH_MAX = 1.08;            // máx. +8% (acelera)
const TIME_STRETCH_DEADZONE = 0.02;       // ignora desvios < 2%
const SILENCE_REMOVE_THRESHOLD_DB = -38;
const SILENCE_REMOVE_MIN_DURATION = 0.35;

const TARGET_DURATION_MAP = {
  "15": 15, "15s": 15,
  "20": 20, "20s": 20,
  "30": 30, "30s": 30,
  "45": 45, "45s": 45,
  "60": 60, "60s": 60,
};

function resolveTargetDuration(opts) {
  if (typeof opts.targetDuration === "number" && opts.targetDuration > 0) return opts.targetDuration;
  if (typeof opts.target_duration === "number" && opts.target_duration > 0) return opts.target_duration;
  const dur = opts.duration || opts.audio_duration;
  if (typeof dur === "string") {
    const key = dur.trim().toLowerCase();
    if (TARGET_DURATION_MAP[key]) return TARGET_DURATION_MAP[key];
    const parsed = parseFloat(key);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  if (typeof dur === "number" && dur > 0) return dur;
  return null;
}

// Time stretch SÓ encurta. Nunca estende áudio curto.
function applyTimeStretch(voiceFile, targetDuration, sampleRate, opts = {}) {
  const stretchEnabled = opts.timeStretch !== false;
  if (!stretchEnabled || !targetDuration) return voiceFile;

  const currentDuration = getAudioDuration(voiceFile);
  if (!currentDuration || currentDuration <= 0) return voiceFile;

  const ratio = currentDuration / targetDuration;

  console.log(`[time-stretch] current=${currentDuration.toFixed(2)}s target=${targetDuration}s ratio=${ratio.toFixed(4)}`);

  // Áudio dentro ou ABAIXO do target → não mexe
  if (ratio <= 1 + TIME_STRETCH_DEADZONE) {
    console.log(`[time-stretch] áudio dentro/abaixo do target, sem ajuste`);
    return voiceFile;
  }

  // Áudio EXCEDE target — aplica silenceremove + atempo
  const stretchedFile = tmpFile(".stretched.wav");
  const intermediateFile = tmpFile(".silcut.wav");

  runFfmpeg([
    "-i", voiceFile,
    "-af", `silenceremove=stop_periods=-1:stop_duration=${SILENCE_REMOVE_MIN_DURATION}:stop_threshold=${SILENCE_REMOVE_THRESHOLD_DB}dB:stop_silence=0.25`,
    "-ar", String(sampleRate), "-ac", "1", "-y", intermediateFile,
  ]);
  const newDuration = getAudioDuration(intermediateFile);
  console.log(`[time-stretch] após silenceremove: ${newDuration.toFixed(2)}s`);

  const newRatio = newDuration / targetDuration;

  if (newRatio <= 1 + TIME_STRETCH_DEADZONE) {
    console.log(`[time-stretch] silenceremove resolveu, sem atempo`);
    return intermediateFile;
  }

  const clampedRatio = Math.min(TIME_STRETCH_MAX, newRatio);
  console.log(`[time-stretch] aplicando atempo=${clampedRatio.toFixed(4)} (de ${newRatio.toFixed(4)})`);
  runFfmpeg(["-i", intermediateFile, "-af", `atempo=${clampedRatio.toFixed(4)}`, "-ar", String(sampleRate), "-ac", "1", "-y", stretchedFile]);
  try { fs.unlinkSync(intermediateFile); } catch {}
  return stretchedFile;
}

// ─── PRESETS DE VOZ ──────────────────────────────────────────────────
const VOICE_PRESETS = {
  // NOVO: replica EQ/dinâmica do referência Honda HRV (rádio FM brasileira)
  // Voz na cara, presença forte, ar marcante, body firme, compressão pesada
  radio_fm_br: {
    gate: { threshold: -55, ratio: 2, attack: 5, release: 250 },
    noiseReduction: { amount: 8, floor: -25 },
    highpass: 75,
    body: { freq: 160, gain: 2.0 },              // corpo cheio
    mudCut: { freq: 380, gain: -3.0 },           // tira lama
    intelligibility: { freq: 2200, gain: 2.5 },  // articulação
    presence: { freq: 4500, gain: 4.0 },         // presença marcante
    air: [{ freq: 9000, gain: 3.0 }, { freq: 13000, gain: 2.5 }], // ar/brilho
    deEsser: [{ freq: 6500, gain: -3.5 }, { freq: 7800, gain: -2.5 }],
    compressor: { threshold: -22, ratio: 5, attack: 3, release: 100, makeup: 3 },   // 1ª compressão pesada
    compressor2: { threshold: -10, ratio: 3, attack: 8, release: 80, makeup: 2 },   // glue final
    exciter: { amount: 1.6, drive: 4, blend: 0.4 },
  },
  varejo: {
    highpass: 85, body: { freq: 130, gain: 1.5 }, mudCut: { freq: 320, gain: -2.5 },
    intelligibility: { freq: 2000, gain: 1.5 }, presence: { freq: 4500, gain: 3.5 },
    air: [{ freq: 10000, gain: 2.5 }, { freq: 13500, gain: 1.5 }],
    deEsser: [{ freq: 6800, gain: -3.5 }, { freq: 7800, gain: -2.5 }],
    compressor: { threshold: -20, ratio: 3, attack: 4, release: 120, makeup: 2 },
    exciter: { amount: 1.2, drive: 4, blend: 0.3 },
  },
  institucional: {
    highpass: 80, body: { freq: 150, gain: 2.0 }, mudCut: { freq: 350, gain: -1.8 },
    intelligibility: { freq: 1800, gain: 1.0 }, presence: { freq: 4000, gain: 2.0 },
    air: [{ freq: 11000, gain: 1.5 }], deEsser: [{ freq: 7000, gain: -3.0 }],
    compressor: { threshold: -22, ratio: 2.5, attack: 8, release: 180, makeup: 1.5 },
    exciter: { amount: 0.8, drive: 3, blend: 0.2 },
  },
  neutro: {
    highpass: 75, body: { freq: 140, gain: 1.0 }, mudCut: { freq: 300, gain: -1.5 },
    intelligibility: { freq: 2200, gain: 0.8 }, presence: { freq: 4000, gain: 1.5 },
    air: [{ freq: 12000, gain: 1.0 }], deEsser: [{ freq: 7200, gain: -2.5 }],
    compressor: { threshold: -24, ratio: 2, attack: 10, release: 200, makeup: 1 },
    exciter: null,
  },
  punch: {
    highpass: 90, body: { freq: 120, gain: 2.5 }, mudCut: { freq: 350, gain: -3.5 },
    intelligibility: { freq: 2200, gain: 2.5 }, presence: { freq: 5000, gain: 4.5 },
    air: [{ freq: 10000, gain: 3.0 }, { freq: 14000, gain: 2.0 }],
    deEsser: [{ freq: 6500, gain: -4.0 }, { freq: 7800, gain: -3.0 }],
    compressor: { threshold: -18, ratio: 4, attack: 2, release: 90, makeup: 3 },
    exciter: { amount: 1.8, drive: 5, blend: 0.4 },
  },
  broadcast_ssl: {
    gate: { threshold: -55, ratio: 2, attack: 5, release: 250 },
    noiseReduction: { amount: 10, floor: -25 },
    highpass: 70, body: { freq: 200, gain: 1.0 }, mudCut: { freq: 400, gain: -2.0 },
    intelligibility: { freq: 2500, gain: 2.0 }, presence: { freq: 4000, gain: 3.0 },
    air: [{ freq: 8000, gain: 2.5 }, { freq: 12000, gain: 2.0 }],
    deEsser: [{ freq: 6500, gain: -3.0 }, { freq: 7800, gain: -2.0 }],
    compressor: { threshold: -22, ratio: 4, attack: 5, release: 174, makeup: 3 },
    compressor2: { threshold: -12, ratio: 2.5, attack: 10, release: 100, makeup: 1.5 },
    exciter: { amount: 1.5, drive: 4, blend: 0.35 },
  },
};

function dbToLinear(db) { return Math.pow(10, db / 20); }
function tmpFile(ext = ".mp3") { return path.join(os.tmpdir(), `mixer_${uuidv4()}${ext}`); }

async function downloadFile(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
  fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
  return dest;
}

function getAudioDuration(filePath) {
  try {
    const result = execFileSync("ffprobe", [
      "-v", "quiet", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { encoding: "utf8" });
    return parseFloat(result.trim());
  } catch { return 30; }
}

function runFfmpeg(args) {
  console.log(`[ffmpeg] ${args.join(" ").substring(0, 220)}...`);
  execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 300000 });
}

function buildVoiceFilterChain(sampleRate, voicePresetName = "radio_fm_br", includeAir = true) {
  const preset = VOICE_PRESETS[voicePresetName] || VOICE_PRESETS.radio_fm_br;
  const hasHighRate = sampleRate >= 44100;
  const chain = [];
  if (preset.gate) {
    const g = preset.gate;
    chain.push(`agate=threshold=${dbToLinear(g.threshold).toFixed(5)}:ratio=${g.ratio || 2}:attack=${g.attack || 20}:release=${g.release || 250}`);
  }
  if (preset.noiseReduction) {
    const nr = preset.noiseReduction;
    chain.push(`afftdn=nr=${nr.amount || 12}:nf=${nr.floor || -25}:tn=1`);
  }
  chain.push(`highpass=f=${preset.highpass}`);
  chain.push(`equalizer=f=${preset.body.freq}:t=q:w=1.0:g=${preset.body.gain}`);
  chain.push(`equalizer=f=${preset.mudCut.freq}:t=q:w=1.2:g=${preset.mudCut.gain}`);
  chain.push(`equalizer=f=${preset.intelligibility.freq}:t=q:w=1.0:g=${preset.intelligibility.gain}`);
  chain.push(`equalizer=f=${preset.presence.freq}:t=q:w=1.1:g=${preset.presence.gain}`);
  if (hasHighRate && includeAir && preset.air) for (const b of preset.air) chain.push(`equalizer=f=${b.freq}:t=q:w=1.4:g=${b.gain}`);
  if (preset.deEsser) for (const b of preset.deEsser) chain.push(`equalizer=f=${b.freq}:t=q:w=3.5:g=${b.gain}`);
  const c = preset.compressor;
  chain.push(`acompressor=threshold=${c.threshold}dB:ratio=${c.ratio}:attack=${c.attack}:release=${c.release}:makeup=${c.makeup}`);
  if (preset.compressor2) {
    const c2 = preset.compressor2;
    chain.push(`acompressor=threshold=${c2.threshold}dB:ratio=${c2.ratio}:attack=${c2.attack}:release=${c2.release}:makeup=${c2.makeup}`);
  }
  if (hasHighRate && preset.exciter) {
    const e = preset.exciter;
    chain.push(`aexciter=level_in=1:level_out=1:amount=${e.amount}:drive=${e.drive}:blend=${e.blend}:freq=7500:ceil=14000:listen=0`);
  }
  return chain;
}

function buildMasterChain(opts = {}) {
  const masterEq = opts.masterEq !== false;
  const masterGlue = opts.masterGlue !== false;
  const masterSat = opts.masterSat !== false;
  const masterAir = opts.masterAir === true;
  const targetLufs = typeof opts.masterLufs === "number" ? opts.masterLufs : MASTER_RADIO_FM.lufs;
  const truePeak = typeof opts.masterTruePeak === "number" ? opts.masterTruePeak : MASTER_RADIO_FM.truePeak;
  const lra = typeof opts.masterLra === "number" ? opts.masterLra : MASTER_RADIO_FM.lra;
  const chain = [];
  if (masterEq) chain.push("highpass=f=40");
  if (masterGlue) {
    const g = MASTER_RADIO_FM;
    chain.push(`acompressor=threshold=${g.glueThreshold}dB:ratio=${g.glueRatio}:attack=${g.glueAttack}:release=${g.glueRelease}:makeup=${g.glueMakeup}`);
  }
  if (masterEq) {
    chain.push("equalizer=f=1800:t=q:w=1.2:g=1.5");
    chain.push("lowpass=f=18000");
    if (masterAir) chain.push("equalizer=f=12000:t=q:w=1.0:g=1.0");
  }
  if (masterSat) chain.push("aexciter=level_in=1:level_out=1:amount=0.6:drive=2:blend=0.15:freq=8000:ceil=14000:listen=0");
  chain.push(`loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}`);
  chain.push(`alimiter=limit=${dbToLinear(truePeak).toFixed(4)}:level=disabled:asc=1`);
  return chain.join(",");
}

function resolveBgVolumeLinear(opts, presetBgVol) {
  let baseLinear;
  if (typeof opts.bgVolumeDb === "number" && opts.bgVolumeDb !== -1) baseLinear = dbToLinear(opts.bgVolumeDb);
  else baseLinear = presetBgVol;
  const maxDb = typeof opts.bgVolumeMaxDb === "number" ? opts.bgVolumeMaxDb : DEFAULT_BG_VOLUME_MAX_DB;
  return Math.min(baseLinear, dbToLinear(maxDb));
}

function resolveVoicePreset(opts, config) {
  if (opts.voicePreset && VOICE_PRESETS[opts.voicePreset]) return opts.voicePreset;
  if (config && config.voicePreset && VOICE_PRESETS[config.voicePreset]) return config.voicePreset;
  return "radio_fm_br";
}

async function processVoiceOnly(opts) {
  const { voiceUrl, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const outputFile = tmpFile(".mp3");
  await downloadFile(voiceUrl, voiceFile);
  const isSafe = qualityMode === "safe";
  const sampleRate = isSafe ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : "192k";
  const voicePresetName = resolveVoicePreset(opts, null);

  const targetDur = resolveTargetDuration(opts);
  const stretchedVoice = applyTimeStretch(voiceFile, targetDur, sampleRate, opts);

  const chain = [
    ...buildVoiceFilterChain(sampleRate, voicePresetName, true),
    "silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB",
    buildMasterChain(opts),
  ].join(",");
  runFfmpeg(["-i", stretchedVoice, "-af", chain, "-ar", String(sampleRate), "-ac", "2", "-b:a", bitrate, "-y", outputFile]);

  try { fs.unlinkSync(voiceFile); } catch {}
  if (stretchedVoice !== voiceFile) try { fs.unlinkSync(stretchedVoice); } catch {}
  return outputFile;
}

async function processJingleMix(opts) {
  const { voiceUrl, jingleUrl, preset, jingleVoiceStart, jingleEndTime, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const jingleFile = tmpFile(".jingle_in");
  const outputFile = tmpFile(".mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(jingleUrl, jingleFile)]);
  const config = PRESETS[preset] || PRESETS.jingle;
  const isSafe = qualityMode === "safe";
  const sampleRate = isSafe ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : "192k";

  const targetDur = resolveTargetDuration(opts);
  const stretchedVoice = applyTimeStretch(voiceFile, targetDur, sampleRate, opts);

  const voiceDuration = getAudioDuration(stretchedVoice);
  const startSec = typeof jingleVoiceStart === "number" ? jingleVoiceStart : 0;
  const hasExplicitEnd = typeof jingleEndTime === "number" && jingleEndTime > startSec;
  const voicePresetName = resolveVoicePreset(opts, config);
  const voiceDspFile = tmpFile(".wav");
  runFfmpeg(["-i", stretchedVoice, "-af", buildVoiceFilterChain(sampleRate, voicePresetName, false).join(","), "-ar", String(sampleRate), "-ac", "1", "-y", voiceDspFile]);
  const voiceVol = config.voiceVol;
  const jingleVol = config.bgVol;
  const masterChain = buildMasterChain(opts);

  if (hasExplicitEnd) {
    const voiceEndSec = startSec + voiceDuration;
    const crossfade = 0.15;
    const jingleHeadFile = tmpFile(".wav");
    const jingleTailFile = tmpFile(".wav");
    runFfmpeg(["-i", jingleFile, "-t", String(voiceEndSec + 1), "-y", jingleHeadFile]);
    runFfmpeg(["-i", jingleFile, "-ss", String(jingleEndTime), "-y", jingleTailFile]);
    const mixedHeadFile = tmpFile(".wav");
    runFfmpeg([
      "-i", jingleHeadFile, "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${jingleVol}[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[out]`,
      ].join(";"),
      "-map", "[out]", "-t", String(voiceEndSec), "-ar", String(sampleRate), "-ac", "1", "-y", mixedHeadFile,
    ]);
    runFfmpeg([
      "-i", mixedHeadFile, "-i", jingleTailFile,
      "-filter_complex", [
        `[0:a][1:a]acrossfade=d=${crossfade}:c1=tri:c2=tri[joined]`,
        `[joined]${masterChain}[out]`,
      ].join(";"),
      "-map", "[out]", "-ar", String(sampleRate), "-ac", "2", "-b:a", bitrate, "-y", outputFile,
    ]);
    [voiceFile, jingleFile, voiceDspFile, jingleHeadFile, jingleTailFile, mixedHeadFile].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    if (stretchedVoice !== voiceFile) try { fs.unlinkSync(stretchedVoice); } catch {}
  } else {
    const fadeOutStart = startSec + voiceDuration;
    const totalDuration = fadeOutStart + config.fadeOut + 0.5;
    runFfmpeg([
      "-i", jingleFile, "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,atrim=0:${totalDuration},afade=t=out:st=${fadeOutStart}:d=${config.fadeOut},volume=${jingleVol}[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
        `[mixed]${masterChain}[out]`,
      ].join(";"),
      "-map", "[out]", "-ar", String(sampleRate), "-ac", "2", "-b:a", bitrate, "-y", outputFile,
    ]);
    [voiceFile, jingleFile, voiceDspFile].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    if (stretchedVoice !== voiceFile) try { fs.unlinkSync(stretchedVoice); } catch {}
  }
  return outputFile;
}

async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const bgFile = tmpFile(".bg_in");
  const outputFile = tmpFile(".mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(bgUrl, bgFile)]);
  const config = PRESETS[preset] || PRESETS.varejo;
  const isSafe = qualityMode === "safe";

  const tmpRate = isSafe ? 22050 : 44100;
  const stretchedVoice = applyTimeStretch(voiceFile, resolveTargetDuration(opts), tmpRate, opts);

  const voiceDuration = getAudioDuration(stretchedVoice);
  const isLong = voiceDuration > 60;
  const sampleRate = isSafe ? 22050 : isLong ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : isLong ? "128k" : "192k";
  const hasHighRate = sampleRate >= 44100;
  const voicePresetName = resolveVoicePreset(opts, config);

  const bgEndOffset = typeof opts.bgEndOffset === "number" ? opts.bgEndOffset : DEFAULT_BG_END_OFFSET_SEC;
  const bgEffectiveEnd = Math.max(config.fadeIn + 1.0, voiceDuration - bgEndOffset);
  const bgFadeOutStart = Math.max(0, bgEffectiveEnd - config.fadeOut);
  const totalDuration = voiceDuration + 0.5;

  const bgVol = resolveBgVolumeLinear(opts, config.bgVol);
  const bgCompress = opts.bgCompress !== false;
  const compThreshold = typeof opts.bgCompressThresholdDb === "number" ? opts.bgCompressThresholdDb : DEFAULT_BG_COMPRESS_THRESHOLD_DB;
  const compRatio = typeof opts.bgCompressRatio === "number" ? opts.bgCompressRatio : DEFAULT_BG_COMPRESS_RATIO;

  const voiceChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=mono`,
    ...buildVoiceFilterChain(sampleRate, voicePresetName, hasHighRate),
    `volume=${config.voiceVol}`,
    "aformat=channel_layouts=stereo",
  ].join(",");

  const bgChainParts = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    `atrim=0:${bgEffectiveEnd.toFixed(3)}`,
    `afade=t=in:d=${config.fadeIn}`,
    `afade=t=out:st=${bgFadeOutStart.toFixed(3)}:d=${config.fadeOut}`,
  ];
  if (bgCompress) bgChainParts.push(`acompressor=threshold=${compThreshold}dB:ratio=${compRatio}:attack=15:release=200:makeup=1`);
  if (hasHighRate) bgChainParts.push("extrastereo=m=1.4:c=disabled");
  bgChainParts.push(`volume=${bgVol.toFixed(4)}`);
  bgChainParts.push(`alimiter=limit=${bgVol.toFixed(4)}:level=disabled:asc=1`);
  bgChainParts.push(`apad=whole_dur=${totalDuration.toFixed(3)}`);
  const bgChain = bgChainParts.join(",");

  const masterChain = buildMasterChain(opts);

  runFfmpeg([
    "-i", stretchedVoice,
    "-stream_loop", "-1", "-i", bgFile,
    "-filter_complex", [
      `[0:a]${voiceChain}[voice]`,
      `[1:a]${bgChain}[bg]`,
      `[bg][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
      `[mixed]${masterChain}[out]`,
    ].join(";"),
    "-map", "[out]",
    "-t", String(totalDuration),
    "-ar", String(sampleRate),
    "-ac", "2",
    "-b:a", bitrate,
    "-y", outputFile,
  ]);

  [voiceFile, bgFile].forEach(f => { try { fs.unlinkSync(f); } catch {} });
  if (stretchedVoice !== voiceFile) try { fs.unlinkSync(stretchedVoice); } catch {}
  return outputFile;
}

async function cleanTake({ voiceUrl, cuts }) {
  const voiceFile = tmpFile(".voice_in");
  const outputFile = tmpFile(".mp3");
  await downloadFile(voiceUrl, voiceFile);
  if (!Array.isArray(cuts) || cuts.length === 0) {
    runFfmpeg(["-i", voiceFile, "-c:a", "libmp3lame", "-b:a", "192k", "-y", outputFile]);
    try { fs.unlinkSync(voiceFile); } catch {}
    return outputFile;
  }
  const totalDuration = getAudioDuration(voiceFile);
  const sorted = [...cuts].filter(c => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start).sort((a, b) => a.start - b.start);
  const keep = [];
  let cursor = 0;
  for (const c of sorted) {
    const cutStart = Math.max(0, c.start - 0.04);
    const cutEnd = Math.min(totalDuration, c.end + 0.04);
    if (cutStart > cursor) keep.push([cursor, cutStart]);
    cursor = cutEnd;
  }
  if (cursor < totalDuration) keep.push([cursor, totalDuration]);
  if (keep.length === 0) throw new Error("cleanTake: all audio would be cut");
  const parts = keep.map(([s, e], i) => `[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[seg${i}]`);
  const inputs = keep.map((_, i) => `[seg${i}]`).join("");
  const filter = `${parts.join(";")};${inputs}concat=n=${keep.length}:v=0:a=1[out]`;
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
