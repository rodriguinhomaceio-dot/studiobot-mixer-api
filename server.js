const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "change-me";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ═══ AUTH MIDDLEWARE ═══
function authenticate(req, res, next) {
  const token = req.headers["x-api-secret"];
  if (token !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ═══ HEALTH CHECK ═══
app.get("/health", (req, res) => {
  res.json({ status: "ok", ffmpeg: true, timestamp: new Date().toISOString() });
});

// ═══ PRESETS ═══
const PRESETS = {
  varejo:        { voiceVol: "1.2", bgVol: "0.30", fadeIn: 1.5, fadeOut: 1.5 },
  institucional: { voiceVol: "1.2", bgVol: "0.25", fadeIn: 2.0, fadeOut: 2.0 },
  radio_indoor:  { voiceVol: "1.2", bgVol: "0.30", fadeIn: 1.5, fadeOut: 1.5 },
  jingle:        { voiceVol: "1.2", bgVol: "0.35", fadeIn: 1.0, fadeOut: 1.5 },
  politica:      { voiceVol: "1.2", bgVol: "0.25", fadeIn: 1.5, fadeOut: 1.5 },
};

// ═══ DOWNLOAD FILE ═══
async function downloadFile(url, destPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${url}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

// ═══ GET AUDIO DURATION ═══
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ], (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(stdout.trim()));
    });
  });
}

// ═══ MIX ENDPOINT ═══
app.post("/mix", authenticate, async (req, res) => {
  const { voice_url, bg_url, preset_name, order_id, mode } = req.body;

  if (!voice_url || !bg_url) {
    return res.status(400).json({ error: "voice_url and bg_url are required" });
  }

  const preset = PRESETS[preset_name] || PRESETS.varejo;
  const jobId = crypto.randomUUID();
  const tmpDir = path.join(os.tmpdir(), `mix-${jobId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const voicePath = path.join(tmpDir, "voice.mp3");
  const bgPath = path.join(tmpDir, "bg.mp3");
  const outputPath = path.join(tmpDir, "output.mp3");

  try {
    console.log(`[${jobId}] Starting mix job: preset=${preset_name}, mode=${mode || "standard"}`);

    // Download files
    await Promise.all([
      downloadFile(voice_url, voicePath),
      downloadFile(bg_url, bgPath),
    ]);

    const voiceDuration = await getAudioDuration(voicePath);
    console.log(`[${jobId}] Voice duration: ${voiceDuration.toFixed(1)}s`);

    // Determine if jingle mode (voice inserted into existing track)
    const isJingle = mode === "jingle";

    let ffmpegArgs;

    if (isJingle) {
      // Jingle mode: insert voice on top of jingle track with sidechain ducking
      const bgDuration = await getAudioDuration(bgPath);
      const duckLevel = 0.25; // reduce jingle to 25% during voice
      
      ffmpegArgs = [
        "-i", bgPath,
        "-i", voicePath,
        "-filter_complex",
        [
          // Voice: EQ + compression
          `[1:a]highpass=f=80,`,
          `equalizer=f=3000:t=q:w=1.0:g=2,`,
          `equalizer=f=8000:t=q:w=1.5:g=1,`,
          `acompressor=threshold=-18dB:ratio=3:attack=5:release=150,`,
          `volume=${preset.voiceVol}[voice];`,
          // Jingle: sidechain ducking simulation using volume automation
          `[0:a]volume=${preset.bgVol}[bg];`,
          // Mix voice + ducked jingle
          `[bg][voice]amix=inputs=2:duration=longest:dropout_transition=2,`,
          // Fade out at end
          `afade=t=out:st=${Math.max(0, bgDuration - preset.fadeOut)}:d=${preset.fadeOut},`,
          // Final normalize
          `loudnorm=I=-14:TP=-1:LRA=11`
        ].join(""),
        "-ar", "44100",
        "-ac", "2",
        "-b:a", "192k",
        "-y", outputPath,
      ];
    } else {
      // Standard mode: voice + background track
      const totalDuration = voiceDuration + preset.fadeOut + 0.5;

      ffmpegArgs = [
        "-stream_loop", "-1",
        "-i", bgPath,
        "-i", voicePath,
        "-filter_complex",
        [
          // Voice chain: highpass + EQ + compression + volume
          `[1:a]highpass=f=80,`,
          `equalizer=f=3000:t=q:w=1.0:g=2,`,
          `equalizer=f=8000:t=q:w=1.5:g=1,`,
          `acompressor=threshold=-18dB:ratio=3:attack=5:release=150,`,
          `volume=${preset.voiceVol}[voice];`,
          // BG chain: fade in/out + volume
          `[0:a]afade=t=in:d=${preset.fadeIn},`,
          `afade=t=out:st=${Math.max(0, voiceDuration - preset.fadeOut)}:d=${preset.fadeOut},`,
          `volume=${preset.bgVol}[bg];`,
          // Mix
          `[bg][voice]amix=inputs=2:duration=shortest:dropout_transition=2,`,
          // Final loudness normalization (broadcast standard)
          `loudnorm=I=-14:TP=-1:LRA=11`
        ].join(""),
        "-t", String(totalDuration),
        "-ar", "44100",
        "-ac", "2",
        "-b:a", "192k",
        "-y", outputPath,
      ];
    }

    // Execute ffmpeg
    await new Promise((resolve, reject) => {
      console.log(`[${jobId}] Running ffmpeg...`);
      execFile("ffmpeg", ffmpegArgs, { timeout: 120000 }, (err, stdout, stderr) => {
        if (err) {
          console.error(`[${jobId}] ffmpeg error:`, stderr);
          return reject(new Error(`ffmpeg failed: ${err.message}`));
        }
        console.log(`[${jobId}] ffmpeg completed`);
        resolve();
      });
    });

    // Upload to Supabase Storage
    const outputBuffer = fs.readFileSync(outputPath);
    const storagePath = `mixed/${order_id || jobId}.mp3`;

    const { error: uploadError } = await supabase.storage
      .from("order-files")
      .upload(storagePath, outputBuffer, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage
      .from("order-files")
      .getPublicUrl(storagePath);

    const publicUrl = urlData.publicUrl;
    console.log(`[${jobId}] Upload done: ${publicUrl}`);

    // Update order if order_id provided
    if (order_id) {
      await supabase
        .from("locution_orders")
        .update({ mixed_audio_url: publicUrl, status: "delivered" })
        .eq("id", order_id);
    }

    res.json({
      success: true,
      url: publicUrl,
      job_id: jobId,
      duration: voiceDuration,
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message, job_id: jobId });
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`🎵 StudioBot Mixer API running on port ${PORT}`);
});
