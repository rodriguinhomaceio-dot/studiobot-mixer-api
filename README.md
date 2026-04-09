# 🎵 StudioBot Mixer API

API profissional de mixagem de áudio com ffmpeg para o StudioBot.

## Deploy no Railway

1. Crie um repositório no GitHub com estes arquivos
2. Acesse [railway.app](https://railway.app) e crie um novo projeto
3. Conecte o repositório GitHub
4. Configure as variáveis de ambiente (veja `.env.example`)
5. Deploy automático!

## Variáveis de Ambiente

| Variável | Descrição |
|----------|-----------|
| `SUPABASE_URL` | URL do seu projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key do Supabase |
| `API_SECRET` | Secret para autenticar requests |
| `ELEVENLABS_API_KEY` | (Opcional) Para voice isolation |
| `PORT` | Porta do servidor (padrão: 3000) |

## Endpoints

### `GET /health`
Health check — retorna `{ status: "ok" }`

### `POST /mix`
Mixagem de áudio. Headers: `X-Api-Secret: <API_SECRET>`

**Body (JSON):**
```json
{
  "voice_url": "https://...",
  "bg_url": "https://...",
  "preset": "varejo",
  "order_id": "uuid",
  "voice_only": false,
  "jingle_url": null,
  "jingle_voice_start": null,
  "jingle_end_time": null,
  "quality_mode": null
}
```

**Presets:** `varejo`, `institucional`, `radio_indoor`, `jingle`, `politica`

## Processamento

- **Voice DSP:** High-pass 80Hz → EQ → Compressor → Loudnorm (-14 LUFS)
- **Background:** Loop → Fade in/out → Sidechain ducking
- **Output:** 44.1kHz Stereo, 192kbps MP3
- **Normalização:** Integrated Loudness -14 LUFS, True Peak -1 dB
