const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

// Preset configs (voice 1.2, bg 0.3 — broadcast standard)
const PRESETS = {
  varejo:        { voiceVol: 1.2, bgVol: 0.30, fadeIn: 1.5, fadeOut: 1.5 },
  institucional: { voiceVol: 1.2, bgVol: 0.25, fadeIn: 2.0, fadeOut: 2.0 },
  radio_indoor:  { voiceVol: 1.2, bgVol: 0.30, fadeIn: 1.5, fadeOut: 1.5 },
  jingle:        { voiceVol: 1.2, bgVol: 0.35, fadeIn: 1.0, fadeOut: 1.5 },
  politica:      { voiceVol: 1.2, bgVol: 0.25, fadeIn: 1.5, fadeOut: 1.5 },
};

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
    return 30; // fallback
  }
}

function runFfmpeg(args) {
  console.log(`[ffmpeg] ${args.join(" ").substring(0, 200)}...`);
  execFileSync("ffmpeg", args, { stdio: "pipe", timeout: 300000 });
}

/**
 * Voice-only: DSP chain without background
 */
async function processVoiceOnly(opts) {
  const { voiceUrl, preset, qualityMode } = opts;
  const voiceFile = tmpFile(".voice_in");
  const outputFile = tmpFile(".mp3");

  await downloadFile(voiceUrl, voiceFile);

  const isSafe = qualityMode === "safe";
  const sampleRate = isSafe ? 22050 : 44100;
  const bitrate = isSafe ? "128k" : "192k";

  // Professional DSP chain via ffmpeg:
  // highpass 80Hz → presence boost 3kHz → compressor → loudnorm
  runFfmpeg([
    "-i", voiceFile,
    "-af", [
      `highpass=f=80`,
      `equalizer=f=180:t=q:w=0.9:g=-1.5`,
      `equalizer=f=3200:t=q:w=1.0:g=2.0`,
      `equalizer=f=7800:t=q:w=1.2:g=1.2`,
      `acompressor=threshold=-23dB:ratio=2.6:attack=8:release=160`,
      `loudnorm=I=-14:TP=-1:LRA=11`,
    ].join(","),
    "-ar", String(sampleRate),
    "-ac", "2",
    "-b:a", bitrate,
    "-y", outputFile,
  ]);

  fs.unlinkSync(voiceFile);
  return outputFile;
}

/**
 * Jingle mix: place voice into jingle with sidechain ducking
 */
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

  // Voice DSP chain
  const voiceDspFile = tmpFile(".voice_dsp");
  runFfmpeg([
    "-i", voiceFile,
    "-af", [
      `highpass=f=80`,
      `equalizer=f=3000:t=q:w=1.2:g=2.0`,
      `acompressor=threshold=-18dB:ratio=3:attack=3:release=100`,
      `loudnorm=I=-14:TP=-1:LRA=11`,
    ].join(","),
    "-ar", String(sampleRate),
    "-ac", "1",
    "-y", voiceDspFile,
  ]);

  // Build complex filter for sidechain ducking
  const duckRatio = 0.75;
  const voiceVol = config.voiceVol;

  if (hasExplicitEnd) {
    // Jump-cut mode: voice section + tail from jingleEndTime
    const voiceEndSec = startSec + voiceDuration;
    const crossfade = 0.15;

    // Extract jingle head (0 to voiceEnd) and tail (endTime to end)
    const jingleHeadFile = tmpFile(".jhead");
    const jingleTailFile = tmpFile(".jtail");
    runFfmpeg(["-i", jingleFile, "-t", String(voiceEndSec + 1), "-y", jingleHeadFile]);
    runFfmpeg(["-i", jingleFile, "-ss", String(jingleEndTime), "-y", jingleTailFile]);

    // Mix voice into jingle head with sidechain
    const mixedHeadFile = tmpFile(".mhead");
    runFfmpeg([
      "-i", jingleHeadFile,
      "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]sidechaincompress=threshold=0.02:ratio=${1 / (1 - duckRatio)}:attack=5:release=100:level_in=1:level_sc=1[ducked]`,
        `[ducked][voice]amix=inputs=2:duration=longest:dropout_transition=0[out]`,
      ].join(";"),
      "-map", "[out]",
      "-t", String(voiceEndSec),
      "-ar", String(sampleRate),
      "-ac", "1",
      "-y", mixedHeadFile,
    ]);

    // Concatenate head + tail with crossfade
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
    // Auto mode: fade out after voice ends
    const fadeOutStart = startSec + voiceDuration;
    const totalDuration = fadeOutStart + config.fadeOut + 0.5;

    runFfmpeg([
      "-i", jingleFile,
      "-i", voiceDspFile,
      "-filter_complex", [
        `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,atrim=0:${totalDuration},afade=t=out:st=${fadeOutStart}:d=${config.fadeOut}[jingle]`,
        `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,volume=${voiceVol},adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)}[voice]`,
        `[jingle][voice]sidechaincompress=threshold=0.02:ratio=${1 / (1 - duckRatio)}:attack=5:release=100[ducked]`,
        `[ducked][voice]amix=inputs=2:duration=first:dropout_transition=0[mixed]`,
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

/**
 * Standard mix: voice + background track with sidechain ducking
 */
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

  // Professional broadcast chain via ffmpeg complex filter:
  // Voice: highpass → EQ → compression → loudnorm
  // Background: loop → fade in/out → sidechain duck from voice
  // Final: mix → loudnorm -14 LUFS
  runFfmpeg([
    "-i", voiceFile,
    "-stream_loop", "-1", "-i", bgFile,
    "-filter_complex", [
      // Voice chain
      `[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,` +
        `highpass=f=80,` +
        `equalizer=f=250:t=q:w=1.0:g=1.0,` +
        `equalizer=f=3000:t=q:w=1.2:g=2.5,` +
        (sampleRate >= 44100 ? `equalizer=f=8000:t=q:w=1.5:g=2.0,equalizer=f=10000:t=q:w=1.5:g=1.0,` : "") +
        `acompressor=threshold=-18dB:ratio=3:attack=3:release=100,` +
        `volume=${config.voiceVol}[voice]`,
      // Background chain
      `[1:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,` +
        `atrim=0:${totalDuration},` +
        `afade=t=in:d=${config.fadeIn},` +
        `afade=t=out:st=${voiceDuration}:d=${config.fadeOut},` +
        `volume=${config.bgVol}[bg]`,
      // Sidechain ducking
      `[bg][voice]sidechaincompress=threshold=0.015:ratio=8:attack=5:release=100:level_in=1:level_sc=1[ducked]`,
      // Final mix
      `[ducked][voice]amix=inputs=2:duration=first:dropout_transition=0[mixed]`,
      // Loudnorm
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

/**
 * Main entry point — routes to the right processor
 */
async function mixAudio(opts) {
  if (opts.voiceOnly) {
    return processVoiceOnly(opts);
  }
  if (opts.jingleUrl) {
    return processJingleMix(opts);
  }
  return processStandardMix(opts);
}

module.exports = { mixAudio };
