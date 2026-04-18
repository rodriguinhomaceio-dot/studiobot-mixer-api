const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── Presets de mix (volume da trilha + fades + voice preset) ────────
// bgVol em LINEAR. Trilha mais presente — voz continua protagonista, mas trilha "aparece".
//   0.20 ≈ -14.0 dB  |  0.18 ≈ -14.9 dB  |  0.60 ≈ -4.4 dB (jingle)
const PRESETS = {
  varejo:        { voiceVol: 1.0, bgVol: 0.20, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "broadcast_ssl" },
  institucional: { voiceVol: 1.0, bgVol: 0.18, fadeIn: 2.0, fadeOut: 1.5, voicePreset: "broadcast_ssl" },
  radio_indoor:  { voiceVol: 1.0, bgVol: 0.20, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "broadcast_ssl" },
  jingle:        { voiceVol: 1.0, bgVol: 0.60, fadeIn: 1.0, fadeOut: 1.2, voicePreset: "broadcast_ssl" },
  politica:      { voiceVol: 1.0, bgVol: 0.18, fadeIn: 1.5, fadeOut: 1.2, voicePreset: "broadcast_ssl" },
};

// ─── Defaults de segurança da trilha ─────────────────────────────────
// Trilha termina 0.5s ANTES da voz.
const DEFAULT_BG_END_OFFSET_SEC = 0.5;
// Teto absoluto subido: -10dB (era -13dB) — trilha pode chegar mais alto, sem competir com a voz.
const DEFAULT_BG_VOLUME_MAX_DB = -10;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -22;
const DEFAULT_BG_COMPRESS_RATIO = 6;

// ─── PRESETS DE VOZ ──────────────────────────────────────────────────
const VOICE_PRESETS = {
  varejo: {
    highpass: 85,
    body:            { freq: 130,  gain: 1.5 },
    mudCut:          { freq: 320,  gain: -2.5 },
    intelligibility: { freq: 2000, gain: 1.5 },
    presence:        { freq: 4500, gain: 3.5 },
    air: [
      { freq: 10000, gain: 2.5 },
      { freq: 13500, gain: 1.5 },
    ],
    deEsser: [
      { freq: 6800, gain: -3.5 },
      { freq: 7800, gain: -2.5 },
    ],
    compressor: { threshold: -20, ratio: 3, attack: 4, release: 120, makeup: 2 },
    exciter:    { amount: 1.2, drive: 4, blend: 0.3 },
  },

  institucional: {
    highpass: 80,
    body:            { freq: 150,  gain: 2.0 },
    mudCut:          { freq: 350,  gain: -1.8 },
    intelligibility: { freq: 1800, gain: 1.0 },
    presence:        { freq: 4000, gain: 2.0 },
    air: [{ freq: 11000, gain: 1.5 }],
    deEsser: [{ freq: 7000, gain: -3.0 }],
    compressor: { threshold: -22, ratio: 2.5, attack: 8, release: 180, makeup: 1.5 },
    exciter:    { amount: 0.8, drive: 3, blend: 0.2 },
  },

  neutro: {
    highpass: 75,
    body:            { freq: 140,  gain: 1.0 },
    mudCut:          { freq: 300,  gain: -1.5 },
    intelligibility: { freq: 2200, gain: 0.8 },
    presence:        { freq: 4000, gain: 1.5 },
    air: [{ freq: 12000, gain: 1.0 }],
    deEsser: [{ freq: 7200, gain: -2.5 }],
    compressor: { threshold: -24, ratio: 2, attack: 10, release: 200, makeup: 1 },
    exciter:    null,
  },

  punch: {
    highpass: 90,
    body:            { freq: 120,  gain: 2.5 },
    mudCut:          { freq: 350,  gain: -3.5 },
    intelligibility: { freq: 2200, gain: 2.5 },
    presence:        { freq: 5000, gain: 4.5 },
    air: [
      { freq: 10000, gain: 3.0 },
      { freq: 14000, gain: 2.0 },
    ],
    deEsser: [
      { freq: 6500, gain: -4.0 },
      { freq: 7800, gain: -3.0 },
    ],
    compressor: { threshold: -18, ratio: 4, attack: 2, release: 90, makeup: 3 },
    exciter:    { amount: 1.8, drive: 5, blend: 0.4 },
  },

  // BROADCAST SSL — replica SSL E-Channel + NS1 + RVox + RChannel
  broadcast_ssl: {
    gate: { threshold: -55, ratio: 2, attack: 5, release: 250 },
    noiseReduction: { amount: 10, floor: -25 },
    highpass: 70,
    body:            { freq: 200,  gain: 1.0 },
    mudCut:          { freq: 400,  gain: -2.0 },
    intelligibility: { freq: 2500, gain: 2.0 },
    presence:        { freq: 4000, gain: 3.0 },
    air: [
      { freq: 8000,  gain: 2.5 },
      { freq: 12000, gain: 2.0 },
    ],
    deEsser: [
      { freq: 6500, gain: -3.0 },
      { freq: 7800, gain: -2.0 },
    ],
    compressor:  { threshold: -22, ratio: 4,   attack: 5,  release: 174, makeup: 3 },
    compressor2: { threshold: -12, ratio: 2.5, attack: 10, release: 100, makeup: 1.5 },
    exciter:     { amount: 1.5, drive: 4, blend: 0.35 },
  },
};

function dbToLinear(db) { return Math.pow(10, db / 20); }
function tmpFile(ext = ".mp3") {
  return path.join(os.tmpdir(), `mixer_${uuidv4()}${ext}`);
}

async function downloadFile(url, dest) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return dest;
}

function getAudioDuration(filePath) {
  try {
    const result = execFileSync("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { encoding: "utf8" });
    return parseFloat(result.trim());
  } catch {
    return 30;
  }
}

function runFfmpeg(args) {
  console.log(`[ffmpeg] ${args.join(" ").substring(0, 220)}...`);
  execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 300000 });
}

function buildVoiceFilterChain(sampleRate, voicePresetName = "broadcast_ssl", includeAir = true) {
  const preset = VOICE_PRESETS[voicePresetName] || VOICE_PRESETS.broadcast_ssl;
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

  if (hasHighRate && includeAir && preset.air) {
    for (const band of preset.air) chain.push(`equalizer=f=${band.freq}:t=q:w=1.4:g=${band.gain}`);
  }
  if (preset.deEsser) {
    for (const band of preset.deEsser) chain.push(`equalizer=f=${band.freq}:t=q:w=3.5:g=${band.gain}`);
  }

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
  const targetLufs = typeof opts.masterLufs === "number" ? opts.masterLufs : -14;
  const truePeak = typeof opts.masterTruePeak === "number" ? opts.masterTruePeak : -1;
  const lra = typeof opts.masterLra === "number" ? opts.masterLra : 11;

  const chain = [];
  if (masterEq) chain.push("highpass=f=40");
  if (masterGlue) chain.push("acompressor=threshold=-12dB:ratio=4:attack=30:release=100:makeup=1");
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
  return "broadcast_ssl";
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
  const chain = [
    ...buildVoiceFilterChain(sampleRate, voicePresetName, true),
    "silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB",
    buildMasterChain(opts),
  ].join(",");
  runFfmpeg(["-i", voiceFile, "-af", chain, "-ar", String(sampleRate), "-ac", "2", "-b:a", bitrate, "-y", outputFile]);
  try { fs.unlinkSync(voiceFile); } catch {}
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
  const voiceDuration = getAudioDuration(voiceFile);
  const startSec = typeof jingleVoiceStart === "number" ? jingleVoiceStart : 0;
  const hasExplicitEnd = typeof jingleEndTime === "number" && jingleEndTime > startSec;
  const voicePresetName = resolveVoicePreset(opts, config);
  const voiceDspFile = tmpFile(".wav");
  runFfmpeg(["-i", voiceFile, "-af", buildVoiceFilterChain(sampleRate, voicePresetName, false).join(","), "-ar", String(sampleRate), "-ac", "1", "-y", voiceDspFile]);
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
  }
  return outputFile;
}

// ─── Standard mix (voz + trilha) ─────────────────────────────────────
// AJUSTES desta versão:
//   1. Trilha mais alta: bgVol 0.13→0.20 (varejo/radio_indoor) e 0.12→0.18 (institucional/política)
//   2. Teto absoluto subido: -13dB → -10dB
//   3. Trilha continua terminando 0.5s antes da voz
//   4. Voz continua protagonista, mas trilha "aparece" de verdade
async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const bgFile = tmpFile(".bg_in");
  const outputFile = tmpFile(".mp3");
  await Promise.all([downloadFile(voiceUrl, voiceFile), downloadFile(bgFile, bgFile)].slice(0,1).concat([downloadFile(bgUrl, bgFile)]));
  const config = PRESETS[preset] || PRESETS.varejo;
  const isSafe = qualityMode === "safe";
  const voiceDuration = getAudioDuration(voiceFile);
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
    "-i", voiceFile,
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
