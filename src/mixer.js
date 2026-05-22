const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// ─── PRESETS DE MASTER ────────────────────────────────────────────────
const PRESETS = {
  nd_padrao: {
    comp: 0.25,
    width: 1.35,
    limit: 0.32,
    ceiling: -0.3,
    release: 1.2,
    bgVol: 0.18,
    fadeIn: 1.2,
    fadeOut: 0.6,
    voicePreset: "varejo",
  },

  nd_agressivo: {
    comp: 0.32,
    width: 1.42,
    limit: 0.42,
    ceiling: -0.3,
    release: 1.0,
    bgVol: 0.20,
    fadeIn: 1.2,
    fadeOut: 0.6,
    voicePreset: "varejo",
  },

  nd_voice: {
    comp: 0.20,
    width: 1.15,
    limit: 0.25,
    ceiling: -0.3,
    release: 1.4,
    bgVol: 0.00,
    fadeIn: 2.0,
    fadeOut: 2.0,
    voicePreset: "institucional",
  },

  nd_jingle: {
    comp: 0.34,
    width: 1.38,
    limit: 0.44,
    ceiling: -0.3,
    release: 1.0,
    bgVol: 0.32,
    fadeIn: 1.0,
    fadeOut: 0.6,
    voicePreset: "jingle",
  },

  nd_institucional: {
    comp: 0.22,
    width: 1.25,
    limit: 0.30,
    ceiling: -0.3,
    release: 1.3,
    bgVol: 0.15,
    fadeIn: 1.8,
    fadeOut: 0.6,
    voicePreset: "institucional",
  },
};

PRESETS.varejo = PRESETS.nd_padrao;
PRESETS.institucional = PRESETS.nd_institucional;
PRESETS.radio_indoor = PRESETS.nd_padrao;
PRESETS.jingle = PRESETS.nd_jingle;
PRESETS.politica = PRESETS.nd_institucional;

// ─── PRESETS DE VOZ ───────────────────────────────────────────────────
const VOICE_PRESETS = {
  varejo: {
    hpf: 75,
    presenceFreq: 3000,
    presenceGain: 1.2,
    presenceQ: 1.0,
    deesserFreq: 6500,
    deesserGain: -1.2,
    comp: {
      threshold: -18,
      ratio: 2.2,
      attack: 8,
      release: 180,
      makeup: 1.05,
    },
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
    comp: {
      threshold: -20,
      ratio: 2.0,
      attack: 10,
      release: 220,
      makeup: 1.04,
    },
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
    comp: {
      threshold: -18,
      ratio: 2.4,
      attack: 8,
      release: 180,
      makeup: 1.06,
    },
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
    comp: {
      threshold: -17,
      ratio: 2.5,
      attack: 8,
      release: 160,
      makeup: 1.06,
    },
    loudnormI: -18.5,
    loudnormLRA: 13,
    volume: 0.58,
  },
};

// ─── Defaults ─────────────────────────────────────────────────────────
const DEFAULT_BG_VOLUME_MAX_DB = -12.0;
const DEFAULT_BG_COMPRESS_THRESHOLD_DB = -16;
const DEFAULT_BG_COMPRESS_RATIO = 1.8;
const DEFAULT_FINAL_GAIN_DB = 7.0;
const BG_END_GAP_SEC = 0;

// ─── Utilidades ───────────────────────────────────────────────────────
function runFfmpeg(args) {
  try {
    execFileSync("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : String(err);
    const tail = stderr.length > 3000 ? stderr.slice(-3000) : stderr;
    throw new Error(`ffmpeg failed:\n${tail}`);
  }
}

function ffprobeDuration(file) {
  try {
    const out = execFileSync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ])
      .toString()
      .trim();

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

function resolveBgVol(fallbackLinear) {
  return fallbackLinear;
}

function resolveBgEndGap(opts) {
  let gap = BG_END_GAP_SEC;

  if (typeof opts.bgEndOffset === "number") {
    gap = opts.bgEndOffset;
  } else if (typeof opts.bg_end_offset === "number") {
    gap = opts.bg_end_offset;
  }

  return Math.max(gap, 0);
}

function resolveBgVolumeMax() {
  return DEFAULT_BG_VOLUME_MAX_DB;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Limpeza de take ──────────────────────────────────────────────────
async function cleanTake(input, useIsolator = false) {
  const out = tmpFile("mp3");

  let inputFile = input;
  let downloadedInputFile = null;

  if (input && typeof input === "object") {
    if (!input.voiceUrl && !input.voice_url) {
      throw new Error("cleanTake requires voiceUrl");
    }

    downloadedInputFile = tmpFile("mp3");
    await downloadFile(input.voiceUrl || input.voice_url, downloadedInputFile);
    inputFile = downloadedInputFile;
  }

  const filters = [
    "highpass=f=75",
    "afftdn=nf=-18",
    "loudnorm=I=-20:TP=-1.5:LRA=15",
  ];

  runFfmpeg([
    "-i",
    inputFile,
    "-af",
    filters.join(","),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-y",
    out,
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

  const c = v.comp || {
    threshold: -18,
    ratio: 2.2,
    attack: 8,
    release: 180,
    makeup: 1.05,
  };

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
    voice_url,
    bgUrl,
    bg_url,
    preset = "nd_padrao",
    outputFile,
    output_file,
  } = opts;

  const finalVoiceUrl = voiceUrl || voice_url;
  const finalBgUrl = bgUrl || bg_url;
  const finalOutputFile = outputFile || output_file || tmpFile("mp3");

  if (!finalVoiceUrl) throw new Error("processStandardMix requires voiceUrl");
  if (!finalBgUrl) throw new Error("processStandardMix requires bgUrl");

  const p = PRESETS[preset] || PRESETS.nd_padrao;

  const voiceFile = tmpFile("mp3");
  const bgFile = tmpFile("mp3");

  await Promise.all([
    downloadFile(finalVoiceUrl, voiceFile),
    downloadFile(finalBgUrl, bgFile),
  ]);

  const voiceDur = ffprobeDuration(voiceFile);

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
      : typeof opts.bg_compress_threshold === "number"
        ? opts.bg_compress_threshold
        : DEFAULT_BG_COMPRESS_THRESHOLD_DB;

  const compRatio =
    typeof opts.bgCompressRatio === "number"
      ? opts.bgCompressRatio
      : typeof opts.bg_compress_ratio === "number"
        ? opts.bg_compress_ratio
        : DEFAULT_BG_COMPRESS_RATIO;

  const bgMaxDb = resolveBgVolumeMax();
  const bgMaxLin = dbToLinear(bgMaxDb);
  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);

  const finalGainDb =
    typeof opts.finalGainDb === "number"
      ? opts.finalGainDb
      : typeof opts.final_gain_db === "number"
        ? opts.final_gain_db
        : DEFAULT_FINAL_GAIN_DB;

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
    `[mix]volume=${finalGainDb}dB,alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
  ].join(";");

  runFfmpeg([
    "-i",
    voiceFile,
    "-stream_loop",
    "-1",
    "-i",
    bgFile,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-t",
    totalDur.toFixed(2),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-y",
    finalOutputFile,
  ]);

  try {
    fs.unlinkSync(voiceFile);
    fs.unlinkSync(bgFile);
  } catch {}

  return finalOutputFile;
}

// ─── MIX com jingle — CORRIGIDO ───────────────────────────────────────
// Regra:
// 1. Toca o jingle do início.
// 2. A voz entra em jingleVoiceStart / jingle_voice_start.
// 3. Quando a voz termina, o áudio pula para jingleEndTime / jingle_end_time.
// 4. Daí toca o final do jingle até acabar.
// 5. Sem append manual fora do Railway.
async function processJingleMix(opts) {
  const voiceUrl = opts.voiceUrl || opts.voice_url;
  const jingleUrl = opts.jingleUrl || opts.jingle_url;

  if (!voiceUrl) throw new Error("processJingleMix requires voiceUrl");
  if (!jingleUrl) throw new Error("processJingleMix requires jingleUrl");

  const preset = opts.preset || "nd_jingle";
  const outputFile = opts.outputFile || opts.output_file || tmpFile("mp3");

  const rawVoiceStart =
    opts.jingleVoiceStart ??
    opts.jingle_voice_start ??
    3;

  const rawEndTime =
    opts.jingleEndTime ??
    opts.jingle_end_time;

  const p = PRESETS[preset] || PRESETS.nd_jingle;

  const voiceFile = tmpFile("mp3");
  const jingleFile = tmpFile("mp3");

  await Promise.all([
    downloadFile(voiceUrl, voiceFile),
    downloadFile(jingleUrl, jingleFile),
  ]);

  const voiceDur = ffprobeDuration(voiceFile);
  const jingleDur = ffprobeDuration(jingleFile);

  if (!voiceDur || voiceDur <= 0) {
    throw new Error("Could not read voice duration");
  }

  if (!jingleDur || jingleDur <= 0) {
    throw new Error("Could not read jingle duration");
  }

  const jingleVoiceStart = Math.max(0, Number(rawVoiceStart) || 0);
  const jingleEndTime = numberOrNull(rawEndTime);

  const voiceEndInTimeline = jingleVoiceStart + voiceDur;

  // A cabeça precisa ir até o fim real da voz.
  // Exemplo do cliente:
  // jingleVoiceStart = 2
  // voz dura 20s
  // head toca de 0 até 22s
  // depois pula para jingleEndTime = 36s
  const headDur = Math.max(0.25, voiceEndInTimeline);

  // Só existe tail se o tempo configurado no painel estiver dentro do jingle.
  const hasTail =
    jingleEndTime !== null &&
    jingleEndTime >= 0 &&
    jingleEndTime < jingleDur - 0.25;

  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);

  const finalGainDb =
    typeof opts.finalGainDb === "number"
      ? opts.finalGainDb
      : typeof opts.final_gain_db === "number"
        ? opts.final_gain_db
        : DEFAULT_FINAL_GAIN_DB;

  const voiceChain = buildVoiceChain(p.voicePreset);
  const jingleVol = resolveBgVol(p.bgVol);
  const delayMs = Math.round(jingleVoiceStart * 1000);

  let filter;
  let totalDur;

  if (hasTail) {
    const tailStart = Math.max(0, Math.min(jingleEndTime, jingleDur - 0.25));
    const tailDur = Math.max(0.25, jingleDur - tailStart);

    const tailFadeIn = Math.min(0.25, Math.max(0.06, tailDur / 5));
    const tailFadeOut = Math.min(0.9, Math.max(0.2, tailDur / 4));
    const tailFadeOutStart = Math.max(0, tailDur - tailFadeOut);

    totalDur = headDur + tailDur;

    console.log(
      `[processJingleMix] voiceDur=${voiceDur.toFixed(3)}s ` +
      `jingleDur=${jingleDur.toFixed(3)}s ` +
      `voiceStart=${jingleVoiceStart.toFixed(3)}s ` +
      `voiceEnd=${voiceEndInTimeline.toFixed(3)}s ` +
      `tailStart=${tailStart.toFixed(3)}s ` +
      `tailDur=${tailDur.toFixed(3)}s`
    );

    filter = [
      // Voz tratada, atrasada para entrar no tempo configurado no painel.
      // asplit porque a voz é usada duas vezes:
      // uma para acionar o ducking e outra para entrar no mix.
      `[0:a]${voiceChain},adelay=${delayMs}|${delayMs},apad=pad_dur=0.1,atrim=0:${headDur.toFixed(3)},asetpts=PTS-STARTPTS,asplit=2[vduck][voice]`,

      // Parte inicial do jingle: do início até o fim da voz.
      `[1:a]atrim=0:${headDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${jingleVol.toFixed(4)},aformat=sample_rates=44100:channel_layouts=stereo[jhead]`,

      // Ducking do jingle enquanto a voz fala.
      `[jhead][vduck]sidechaincompress=threshold=0.06:ratio=8:attack=5:release=250[ducked]`,

      // Mix cabeça = jingle duckado + voz.
      `[ducked][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=0:${headDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[head]`,

      // Tail = trecho do jingle a partir do end_time configurado no painel até o fim.
      // Aqui está a correção principal.
      `[1:a]atrim=${tailStart.toFixed(3)}:${jingleDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=${jingleVol.toFixed(4)},afade=t=in:st=0:d=${tailFadeIn.toFixed(3)},afade=t=out:st=${tailFadeOutStart.toFixed(3)}:d=${tailFadeOut.toFixed(3)},aformat=sample_rates=44100:channel_layouts=stereo[tail]`,

      // Concatena: fim da voz -> pula para o tail configurado -> toca até acabar.
      `[head][tail]concat=n=2:v=0:a=1[mix]`,

      // Master final.
      `[mix]volume=${finalGainDb}dB,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
    ].join(";");
  } else {
    // Fallback seguro se não vier jingle_end_time ou se vier inválido.
    // Mantém o comportamento antigo, mas com fade-out e sem corte seco.
    totalDur = Math.max(jingleDur, voiceEndInTimeline) + 0.5;
    const fadeOutStart = Math.max(0, totalDur - 0.9);

    console.log(
      `[processJingleMix] fallback without valid tail. ` +
      `voiceDur=${voiceDur.toFixed(3)}s ` +
      `jingleDur=${jingleDur.toFixed(3)}s ` +
      `voiceStart=${jingleVoiceStart.toFixed(3)}s ` +
      `jingleEndTime=${rawEndTime}`
    );

    filter = [
      `[0:a]${voiceChain},adelay=${delayMs}|${delayMs},apad=pad_dur=0.5,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS,asplit=2[vduck][voice]`,
      `[1:a]volume=${jingleVol.toFixed(4)},apad=pad_dur=0.5,atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[j]`,
      `[j][vduck]sidechaincompress=threshold=0.06:ratio=8:attack=5:release=250[ducked]`,
      `[ducked][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,atrim=0:${totalDur.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.9[mix]`,
      `[mix]volume=${finalGainDb}dB,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=${masterCeiling.toFixed(4)}:level=disabled:asc=1[out]`,
    ].join(";");
  }

  runFfmpeg([
    "-i",
    voiceFile,
    "-i",
    jingleFile,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-t",
    totalDur.toFixed(2),
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-y",
    outputFile,
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
    voice_url,
    preset = "nd_voice",
    outputFile,
    output_file,
  } = opts;

  const finalVoiceUrl = voiceUrl || voice_url;
  const finalOutputFile = outputFile || output_file || tmpFile("mp3");

  if (!finalVoiceUrl) throw new Error("processVoiceOnly requires voiceUrl");

  const p = PRESETS[preset] || PRESETS.nd_voice;

  const voiceFile = tmpFile("mp3");
  await downloadFile(finalVoiceUrl, voiceFile);

  const voiceChain = buildVoiceChain(p.voicePreset);
  const filter = `[0:a]${voiceChain}[out]`;

  runFfmpeg([
    "-i",
    voiceFile,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-y",
    finalOutputFile,
  ]);

  try {
    fs.unlinkSync(voiceFile);
  } catch {}

  return finalOutputFile;
}

// ─── Entrada principal ────────────────────────────────────────────────
async function mixAudio(opts) {
  if (opts.voiceOnly || opts.voice_only) {
    return processVoiceOnly(opts);
  }

  if (opts.jingleUrl || opts.jingle_url) {
    return processJingleMix(opts);
  }

  return processStandardMix(opts);
}

module.exports = {
  mixAudio,
  cleanTake,
  VOICE_PRESETS,
  PRESETS,
};
