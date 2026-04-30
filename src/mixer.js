 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/src/mixer.js b/src/mixer.js
index ec4f1478b28b32494838e778626f101b0e06bf22..1c6319acca827646670664ee27f814b3167ca213 100644
--- a/src/mixer.js
+++ b/src/mixer.js
@@ -1,52 +1,52 @@
 const { execFileSync } = require("child_process");
 const fs = require("fs");
 const path = require("path");
 const os = require("os");
 const { v4: uuidv4 } = require("uuid");
 
 // ─── PRESETS DE MASTER ────────────────────────────────────────────────
 // Voz à frente, trilha bem discreta (mais baixa)
 const PRESETS = {
   nd_padrao: {
-    comp: 0.25, width: 1.35, limit: 0.32, ceiling: -0.3, release: 1.2,
+    comp: 0.25, width: 1.35, limit: 0.32, ceiling: -1.0, release: 1.2,
     bgVol: 0.18, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "varejo",
   },
   nd_agressivo: {
-    comp: 0.32, width: 1.42, limit: 0.42, ceiling: -0.3, release: 1.0,
+    comp: 0.32, width: 1.42, limit: 0.42, ceiling: -1.0, release: 1.0,
     bgVol: 0.20, fadeIn: 1.2, fadeOut: 0.6, voicePreset: "varejo",
   },
   nd_voice: {
-    comp: 0.20, width: 1.15, limit: 0.25, ceiling: -0.3, release: 1.4,
+    comp: 0.20, width: 1.15, limit: 0.25, ceiling: -1.0, release: 1.4,
     bgVol: 0.00, fadeIn: 2.0, fadeOut: 2.0, voicePreset: "institucional",
   },
   nd_jingle: {
-    comp: 0.34, width: 1.38, limit: 0.44, ceiling: -0.3, release: 1.0,
+    comp: 0.34, width: 1.38, limit: 0.44, ceiling: -1.0, release: 1.0,
     bgVol: 0.32, fadeIn: 1.0, fadeOut: 0.6, voicePreset: "jingle",
   },
   nd_institucional: {
-    comp: 0.22, width: 1.25, limit: 0.30, ceiling: -0.3, release: 1.3,
+    comp: 0.22, width: 1.25, limit: 0.30, ceiling: -1.0, release: 1.3,
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
@@ -214,51 +214,51 @@ async function processStandardMix(opts) {
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
-  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);
+  const masterCeiling = dbToLinear(p.ceiling ?? -1.0);
 
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
@@ -283,51 +283,51 @@ async function processStandardMix(opts) {
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
-  const masterCeiling = dbToLinear(p.ceiling ?? -0.8);
+  const masterCeiling = dbToLinear(p.ceiling ?? -1.0);
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
 
EOF
)
