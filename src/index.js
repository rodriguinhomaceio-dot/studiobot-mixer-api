const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { mixAudio, cleanTake } = require("./mixer");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Auth middleware ─────────────────────────────────────────────────
function authenticate(req, res, next) {
  if (API_SECRET) {
    const token = req.headers["x-api-secret"];
    if (token !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
}

// ─── Helper: upload local file to storage and return public URL ──────
async function uploadToStorage(localPath, { orderId, suffix = "mixed" }) {
  const buffer = fs.readFileSync(localPath);
  const fileKey = orderId || uuidv4();
  const versionToken = `${Date.now()}_${uuidv4().slice(0, 8)}`;
  const fileName = `locutions/${fileKey}_${versionToken}_${suffix}.mp3`;

  const { error } = await supabase.storage
    .from("order-files")
    .upload(fileName, buffer, { contentType: "audio/mpeg", upsert: true });

  try { fs.unlinkSync(localPath); } catch {}

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data: urlData } = supabase.storage.from("order-files").getPublicUrl(fileName);
  return urlData.publicUrl;
}

// ─── Health ──────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.1.0" });
});

// ─── Main mix endpoint ───────────────────────────────────────────────
app.post("/mix", authenticate, async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      voice_url,
      bg_url,
      preset = "varejo",
      order_id,
      voice_only = false,
      jingle_url,
      jingle_voice_start,
      jingle_end_time,
      quality_mode,
      use_isolator = false,
      exclude_track_url,
      force_track_url,
      bg_volume, // ← novo: override de volume da trilha em dB
    } = req.body;

    if (!voice_url) {
      return res.status(400).json({ error: "voice_url is required" });
    }

    console.log(
      `[mix] Starting: preset=${preset}, voice_only=${voice_only}, jingle=${!!jingle_url}, order=${order_id || "none"}, bg_volume=${bg_volume ?? "default"}`
    );

    // Selecionar trilha aleatória se necessário
    let backgroundUrl = bg_url || force_track_url;
    let bgTrackName = "Custom";

    if (!voice_only && !jingle_url && !backgroundUrl) {
      const category = preset || "varejo";
      const { data: tracks } = await supabase
        .from("background_tracks")
        .select("id, name, file_url")
        .eq("category", category);

      if (!tracks || tracks.length === 0) {
        return res.json({
          mixed_audio_url: voice_url,
          success: true,
          note: "No background tracks available",
        });
      }

      let available = tracks;
      if (exclude_track_url && tracks.length > 1) {
        const filtered = tracks.filter((t) => t.file_url !== exclude_track_url);
        if (filtered.length > 0) available = filtered;
      }
      const chosen = available[Math.floor(Math.random() * available.length)];
      backgroundUrl = chosen.file_url;
      bgTrackName = chosen.name;
      console.log(`[mix] Selected track: ${bgTrackName}`);
    }

    // Run ffmpeg mix
    const outputPath = await mixAudio({
      voiceUrl: voice_url,
      bgUrl: backgroundUrl,
      jingleUrl: jingle_url,
      preset,
      voiceOnly: voice_only,
      jingleVoiceStart: jingle_voice_start,
      jingleEndTime: jingle_end_time,
      qualityMode: quality_mode,
      useIsolator: use_isolator,
      bgVolumeDb: bg_volume, // ← passa override pro mixer
    });

    const suffix = voice_only ? "treated" : jingle_url ? "jingle" : "mixed";
    const publicUrl = await uploadToStorage(outputPath, { orderId: order_id, suffix });

    // Atualiza ordem se houver
    if (order_id) {
      const updateData = {
        mixed_audio_url: publicUrl,
        mix_preset: preset,
      };
      if (!voice_only && !jingle_url && backgroundUrl) {
        updateData.bg_track_url = backgroundUrl;
      }
      await supabase.from("locution_orders").update(updateData).eq("id", order_id);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[mix] Complete in ${elapsed}s: ${publicUrl}`);

    res.json({
      mixed_audio_url: publicUrl,
      bg_track_name: bgTrackName,
      category: preset,
      voice_only,
      jingle_mix: !!jingle_url,
      success: true,
      processing_time_sec: parseFloat(elapsed),
    });
  } catch (err) {
    console.error("[mix] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ─── NEW: Clean take endpoint ────────────────────────────────────────
// Recebe URL de áudio + lista de cuts [{start,end}] e devolve URL limpa.
app.post("/clean-take", authenticate, async (req, res) => {
  const startTime = Date.now();
  try {
    const { voice_url, cuts, order_id } = req.body;

    if (!voice_url) {
      return res.status(400).json({ error: "voice_url is required" });
    }

    const cutsArr = Array.isArray(cuts) ? cuts : [];
    console.log(`[clean-take] Starting: order=${order_id || "none"}, cuts=${cutsArr.length}`);

    const outputPath = await cleanTake({
      voiceUrl: voice_url,
      cuts: cutsArr,
    });

    const cleanedUrl = await uploadToStorage(outputPath, {
      orderId: order_id,
      suffix: "cleaned",
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[clean-take] Complete in ${elapsed}s: ${cleanedUrl} (${cutsArr.length} cuts)`);

    res.json({
      cleaned_url: cleanedUrl,
      cuts_applied: cutsArr.length,
      success: true,
      processing_time_sec: parseFloat(elapsed),
    });
  } catch (err) {
    console.error("[clean-take] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🎵 studiobot-mixer-api running on port ${PORT}`);
});
