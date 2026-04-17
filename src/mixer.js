const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── Presets ──────────────────────────────────────────────────────────
const PRESETS = {
  varejo:        { voiceVol: 1.0, bgVol: 0.25, fadeIn: 1.5, fadeOut: 1.5 },
  institucional: { voiceVol: 1.0, bgVol: 0.22, fadeIn: 2.0, fadeOut: 2.0 },
  radio_indoor:  { voiceVol: 1.0, bgVol: 0.25, fadeIn: 1.5, fadeOut: 1.5 },
  jingle:        { voiceVol: 1.0, bgVol: 0.55, fadeIn: 1.0, fadeOut: 1.5 },
  politica:      { voiceVol: 1.0, bgVol: 0.22, fadeIn: 1.5, fadeOut: 1.5 },
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

// ─── BROADCAST EQ — Rádio FM moderna ─────────────────────────────────
// Filosofia: presença forte (3-5kHz), ar brilhante (10-14kHz),
// graves controlados, médios limpos, de-esser cirúrgico em 7kHz,
// saturação suave (aexciter) pra cola analógica.
function buildVoiceFilterChain(sampleRate, includeAir = true) {
  const hasHighRate = sampleRate >= 44100;
  const chain = [
    // Limpeza de baixas
    "highpass=f=85",
    // Corpo controlado (peito da voz)
    "equalizer=f=130:t=q:w=1.0:g=1.5",
    // Corta boxiness / lama
    "equalizer=f=320:t=q:w=1.2:g=-2.5",
    // Inteligibilidade (consoantes)
    "equalizer=f=2000:t=q:w=1.0:g=1.5",
    // PRESENÇA FORTE — assinatura FM moderna
    "equalizer=f=4500:t=q:w=1.1:g=3.5",
  ];

  if (hasHighRate && includeAir) {
    // Ar brilhante (alta frequência aberta)
    chain.push("equalizer=f=10000:t=q:w=1.4:g=2.5");
    chain.push("equalizer=f=13500:t=q:w=1.8:g=1.5");
  }

  // De-esser dedicado — corte cirúrgico em sibilância
  chain.push("equalizer=f=6800:t=q:w=3.5:g=-3.5");
  chain.push("equalizer=f=7800:t=q:w=3.5:g=-2.5");

  // Compressor broadcast (controle dinâmico)
  chain.push("acompressor=threshold=-20dB:ratio=3:attack=4:release=120:makeup=2");

  // Saturação suave (calor analógico — aexciter adiciona harmônicos)
  if (hasHighRate) {
    chain.push("aexciter=level_in=1:level_out=1:amount=1.2:drive=4:blend=0.3:freq=7500:ceil=14000:listen=0");
  }

  return chain;
}

function resolveBgVol(opts, presetBgVol) {
  if (typeof opts.bgVolumeDb === "number" && opts.bgVolumeDb !== -1) {
    return dbToLinear(opts.bgVolumeDb);
  }
  return presetBgVol;
}

// ─── Voice only ───────────────────────────────────────────────────────
async function processVoiceOnly(opts) {
  const { voiceUrl, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const outputFile = tmpFile(".mp3");
  await downloadFile(voiceUrl, voiceFile);

  const isSafe = qualityMode === "safe";
  const sampleRate = isSafe ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : "192k";

  const chain = [
    ...buildVoiceFilterChain(sampleRate, true),
    "silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB",
    "loudnorm=I=-14:TP=-1:LRA=11",
  ].join(",");

  runFfmpeg([
    "-i", voiceFile,
    "-af", chain,
    "-ar", String(sampleRate),
    "-ac", "2",
    "-b:a", bitrate,
    "-y", outputFile,
  ]);

  try { fs.unlinkSync(voiceFile); } catch {}
  return outputFile;
}

// ─── Jingle mix (intocado — usa mesma EQ broadcast em mono) ───────────
async function processJingleMix(opts) {
  const { voiceUrl, jingleUrl, preset, jingleVoiceStart, jingleEndTime, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const jingleFile = tmpFile(".jingle_in");
  const outputFile = tmpFile(".mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(jingleUrl, jingleFile),
  ]);

  const config = PRESETS[preset] || PRESETS.jingle;
  const isSafe = qualityMode === "safe";
  const sampleRate = isSafe ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : "192k";

  const voiceDuration = getAudioDuration(voiceFile);
  const startSec = typeof jingleVoiceStart === "number" ? jingleVoiceStart : 0;
  const hasExplicitEnd = typeof jingleEndTime === "number" && jingleEndTime > startSec;

  const voiceDspFile = tmpFile(".wav");
  runFfmpeg([
    "-i", voiceFile,
    "-af", [
      ...buildVoiceFilterChain(sampleRate, false),
      "loudnorm=I=-14:TP=-1:LRA=11",
    ].join(","),
    "-ar", String(sampleRate),
    "-ac", "1",
    "-y", voiceDspFile,
  ]);

  const voiceVol = config.voiceVol;
  const jingleVol = config.bgVol;

  if (hasExplicitEnd) {
    const voiceEndSec = startSec + voiceDuration;
    const crossfade = 0.15;
    const jingleHeadFile = tmpFile(".wav");
    const jingleTailFile = tmpFile(".wav");

    runFfmpeg(["-i", jingleFile, "-t", String(voiceEndSec + 1), "-y", jingleHeadFile]);
    runFfmpeg(["-i", jingleFile, "-ss", String(jingleEndTime), "-y", jingleTailFile]);

    const mixedHeadFile = tmpFile(".wav");
    runFfmpeg([
      "-i", jingleHeadFile,
      "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${jingleVol}[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[out]`,
      ].join(";"),
      "-map", "[out]",
      "-t", String(voiceEndSec),
      "-ar", String(sampleRate),
      "-ac", "1",
      "-y", mixedHeadFile,
    ]);

    runFfmpeg([
      "-i", mixedHeadFile,
      "-i", jingleTailFile,
      "-filter_complex", `[0:a][1:a]acrossfade=d=${crossfade}:c1=tri:c2=tri[out]`,
      "-map", "[out]",
      "-ar", String(sampleRate),
      "-ac", "2",
      "-b:a", bitrate,
      "-y", outputFile,
    ]);

    [voiceFile, jingleFile, voiceDspFile, jingleHeadFile, jingleTailFile, mixedHeadFile].forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
  } else {
    const fadeOutStart = startSec + voiceDuration;
    const totalDuration = fadeOutStart + config.fadeOut + 0.5;

    runFfmpeg([
      "-i", jingleFile,
      "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,atrim=0:${totalDuration},afade=t=out:st=${fadeOutStart}:d=${config.fadeOut},volume=${jingleVol}[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
        `[mixed]loudnorm=I=-14:TP=-1:LRA=11[out]`,
      ].join(";"),
      "-map", "[out]",
      "-ar", String(sampleRate),
      "-ac", "2",
      "-b:a", bitrate,
      "-y", outputFile,
    ]);

    [voiceFile, jingleFile, voiceDspFile].forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
  }

  return outputFile;
}

// ─── Standard mix (voz + trilha) com stereo widener leve na trilha ───
async function processStandardMix(opts) {
  const { voiceUrl, bgUrl, preset, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const bgFile = tmpFile(".bg_in");
  const outputFile = tmpFile(".mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(bgUrl, bgFile),
  ]);

  const config = PRESETS[preset] || PRESETS.varejo;
  const isSafe = qualityMode === "safe";
  const voiceDuration = getAudioDuration(voiceFile);
  const isLong = voiceDuration > 60;
  const sampleRate = isSafe ? 22050 : isLong ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : isLong ? "128k" : "192k";
  const totalDuration = voiceDuration + config.fadeOut + 0.5;
  const hasHighRate = sampleRate >= 44100;

  const bgVol = resolveBgVol(opts, config.bgVol);

  // Voz: mono → centralizada (pan via aformat stereo padrão = centro)
  const voiceChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=mono`,
    ...buildVoiceFilterChain(sampleRate, hasHighRate),
    `volume=${config.voiceVol}`,
    // Volta pra estéreo centralizado pra somar com a trilha estéreo
    "aformat=channel_layouts=stereo",
  ].join(",");

  // Trilha: estéreo + widener leve (extrastereo ~1.4 = sutil)
  // extrastereo amplifica a diferença L/R; valores 1.0-1.5 são seguros.
  const bgChain = [
    `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`,
    `atrim=0:${totalDuration}`,
    `afade=t=in:d=${config.fadeIn}`,
    `afade=t=out:st=${voiceDuration}:d=${config.fadeOut}`,
    hasHighRate ? "extrastereo=m=1.4:c=disabled" : null,
    `volume=${bgVol}`,
  ].filter(Boolean).join(",");

  runFfmpeg([
    "-i", voiceFile,
    "-stream_loop", "-1", "-i", bgFile,
    "-filter_complex", [
      `[0:a]${voiceChain}[voice]`,
      `[1:a]${bgChain}[bg]`,
      `[bg][voice]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed]`,
      `[mixed]loudnorm=I=-14:TP=-1:LRA=11[out]`,
    ].join(";"),
    "-map", "[out]",
    "-t", String(totalDuration),
    "-ar", String(sampleRate),
    "-ac", "2",
    "-b:a", bitrate,
    "-y", outputFile,
  ]);

  [voiceFile, bgFile].forEach(f => {
    try { fs.unlinkSync(f); } catch {}
  });
  return outputFile;
}

// ─── Clean take (cortes por timestamp) ────────────────────────────────
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
  const sorted = [...cuts]
    .filter(c => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start)
    .sort((a, b) => a.start - b.start);

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

  const parts = keep.map(([s, e], i) =>
    `[0:a]atrim=start=${s.toFixed(3)}:end=${e.toFixed(3)},asetpts=PTS-STARTPTS[seg${i}]`
  );
  const inputs = keep.map((_, i) => `[seg${i}]`).join("");
  const filter = `${parts.join(";")};${inputs}concat=n=${keep.length}:v=0:a=1[out]`;

  runFfmpeg([
    "-i", voiceFile,
    "-filter_complex", filter,
    "-map", "[out]",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-y", outputFile,
  ]);

  try { fs.unlinkSync(voiceFile); } catch {}
  return outputFile;
}

// ─── Entry point ──────────────────────────────────────────────────────
async function mixAudio(opts) {
  if (opts.voiceOnly) return processVoiceOnly(opts);
  if (opts.jingleUrl) return processJingleMix(opts);
  return processStandardMix(opts);
}

module.exports = { mixAudio, cleanTake };
