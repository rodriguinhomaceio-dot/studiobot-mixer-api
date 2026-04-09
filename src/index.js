const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { mixAudio } = require("./mixer");
const { v4: uuidv4 } = require("uuid");

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

// Auth middleware
function authenticate(req, res, next) {
  if (API_SECRET) {
    const token = req.headers["x-api-secret"];
    if (token !== API_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// Main mix endpoint
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
    } = req.body;

    if (!voice_url) {
      return res.status(400).json({ error: "voice_url is required" });
    }

    console.log(`[mix] Starting: preset=${preset}, voice_only=${voice_only}, jingle=${!!jingle_url}, order=${order_id || "none"}`);

    // If no bg_url and not voice_only and not jingle, pick a track from DB
    let backgroundUrl = bg_url || force_track_url;
    let bgTrackName = "Custom";

    if (!voice_only && !jingle_url && !backgroundUrl) {
      const category = preset || "varejo";
      let query = supabase.from("background_tracks").select("id, name, file_url").eq("category", category);
      const { data: tracks } = await query;

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
    });

    // Upload to Supabase Storage
    const fs = require("fs");
    const fileBuffer = fs.readFileSync(outputPath);
    const fileKey = order_id || uuidv4();
    const versionToken = `${Date.now()}_${uuidv4().slice(0, 8)}`;
    const suffix = voice_only ? "treated" : jingle_url ? "jingle" : "mixed";
    const fileName = `locutions/${fileKey}_${versionToken}_${suffix}.mp3`;

    const { error: uploadError } = await supabase.storage
      .from("order-files")
      .upload(fileName, fileBuffer, { contentType: "audio/mpeg", upsert: true });

    // Clean up temp file
    fs.unlinkSync(outputPath);

    if (uploadError) {
      console.error("[mix] Upload error:", uploadError);
      return res.status(500).json({ error: "Failed to upload mixed audio" });
    }

    const { data: urlData } = supabase.storage.from("order-files").getPublicUrl(fileName);

    // Update order if provided
    if (order_id) {
      const updateData = {
        mixed_audio_url: urlData.publicUrl,
        mix_preset: preset,
      };
      if (!voice_only && !jingle_url && backgroundUrl) {
        updateData.bg_track_url = backgroundUrl;
      }
      await supabase.from("locution_orders").update(updateData).eq("id", order_id);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[mix] Complete in ${elapsed}s: ${urlData.publicUrl}`);

    res.json({
      mixed_audio_url: urlData.publicUrl,
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

app.listen(PORT, () => {
  console.log(`🎵 studiobot-mixer-api running on port ${PORT}`);
});
