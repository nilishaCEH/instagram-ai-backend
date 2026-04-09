const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const JSZip    = require('jszip');
const FormData = require('form-data');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN = process.env.HF_TOKEN;
const HF_API   = 'https://api-inference.huggingface.co/models';

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '30mb' }));

/* ── Health ── */
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Instagram AI Backend running — powered by Hugging Face' }));

/* ══════════════════════════════════════════
   INSTAGRAM CONTENT — Claude API
══════════════════════════════════════════ */
app.post('/generate', async (req, res) => {
  try {
    const {
      type_label = 'Instagram feed post',
      topic = 'probiotic fizzy beverages',
      tone = 'fun & energetic',
      hashtag_instruction = '20-25 mixed hashtags',
      images = []
    } = req.body;

    const content = [];
    images.forEach(img => {
      if (img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.mtype || 'image/jpeg', data: img.data } });
    });
    const hasImg = images.length > 0;
    content.push({
      type: 'text',
      text: `${hasImg ? `Analyze the ${images.length} product image(s) (${images.map(i => i.label).join(', ')}). Base content on what you see.\n\n` : ''}Create a ${type_label} about "${topic}". Tone: ${tone}. ${hashtag_instruction}.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."${hasImg ? ',"image_analysis":"..."' : ''}}`
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: 'You are an expert Instagram content creator for a probiotic fizzy beverages brand. Return ONLY valid JSON.', messages: [{ role: 'user', content }] })
    });

    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Claude API error', details: e }); }
    const d = await r.json();
    res.json(JSON.parse(d.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim()));

  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════
   BACKGROUND REMOVAL — briaai/RMBG-1.4
   Free, no card needed on Hugging Face
══════════════════════════════════════════ */
app.post('/remove-bg', async (req, res) => {
  try {
    const { image, mtype = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    if (!HF_TOKEN) return res.json({ image, removed: false, reason: 'No HF_TOKEN set' });

    const imgBuffer = Buffer.from(image, 'base64');

    /* Call RMBG-1.4 — best free background removal model */
    const r = await fetch(`${HF_API}/briaai/RMBG-1.4`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type':  mtype
      },
      body: imgBuffer
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('RMBG error:', errText);
      /* Model may be loading — wait and retry once */
      if (errText.includes('loading')) {
        await sleep(15000);
        const r2 = await fetch(`${HF_API}/briaai/RMBG-1.4`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': mtype },
          body: imgBuffer
        });
        if (r2.ok) {
          const buf2 = await r2.buffer();
          return res.json({ image: buf2.toString('base64'), removed: true });
        }
      }
      return res.json({ image, removed: false });
    }

    const resultBuffer = await r.buffer();
    res.json({ image: resultBuffer.toString('base64'), removed: true });

  } catch (err) {
    console.error('BG removal error:', err);
    res.json({ image: req.body.image, removed: false });
  }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION — FLUX.1-schnell (FREE)
   Generates HD product photography variations
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;
    if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not set in environment variables' });

    const objText = objects ? ` with ${objects}` : '';
    const prompt  = `Professional commercial product photography. A probiotic fizzy beverage bottle/can${objText} placed in ${theme}. ${mood} lighting. ${style}. The beverage product is the hero of the shot, sharp focus, ultra detailed, 8K resolution, Instagram-worthy, no text overlays, photorealistic.`;

    /* Try FLUX.1-schnell first — fastest free model */
    const result = await generateWithModel('black-forest-labs/FLUX.1-schnell', prompt);
    if (result) return res.json({ url: result.url, b64: result.b64, index });

    /* Fallback 1 — FLUX.1-dev (higher quality, slower) */
    console.log('FLUX schnell failed, trying FLUX dev...');
    const result2 = await generateWithModel('black-forest-labs/FLUX.1-dev', prompt);
    if (result2) return res.json({ url: result2.url, b64: result2.b64, index });

    /* Fallback 2 — Stable Diffusion XL */
    console.log('FLUX dev failed, trying SDXL...');
    const result3 = await generateWithModel('stabilityai/stable-diffusion-xl-base-1.0', prompt);
    if (result3) return res.json({ url: result3.url, b64: result3.b64, index });

    res.status(500).json({ error: 'All models failed. The models may be loading — try again in 30 seconds.' });

  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* Helper — call HF inference API and return base64 + data URL */
async function generateWithModel(modelId, prompt, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${HF_API}/${modelId}`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: prompt,
          parameters: { num_inference_steps: 4, guidance_scale: 3.5, width: 1024, height: 1024 }
        })
      });

      if (!r.ok) {
        const errText = await r.text();
        console.error(`${modelId} attempt ${attempt + 1} failed:`, errText);
        /* Model loading — wait and retry */
        if (errText.includes('loading') && attempt < retries) {
          console.log(`Model loading, waiting 20s...`);
          await sleep(20000);
          continue;
        }
        return null;
      }

      const imgBuffer = await r.buffer();
      const b64       = imgBuffer.toString('base64');
      const dataUrl   = `data:image/png;base64,${b64}`;
      return { url: dataUrl, b64 };

    } catch (err) {
      console.error(`${modelId} error:`, err.message);
      if (attempt < retries) await sleep(5000);
    }
  }
  return null;
}

/* ══════════════════════════════════════════
   PROXY IMAGE — for downloading
══════════════════════════════════════════ */
app.post('/proxy-image', async (req, res) => {
  try {
    const { url, b64 } = req.body;

    /* If b64 is provided directly (from HF), use it */
    if (b64) return res.json({ image: b64 });

    /* Otherwise fetch from URL */
    if (!url) return res.status(400).json({ error: 'No URL or b64 provided' });

    /* Handle data URLs */
    if (url.startsWith('data:')) {
      const base64 = url.split(',')[1];
      return res.json({ image: base64 });
    }

    const r = await fetch(url);
    if (!r.ok) return res.status(404).json({ error: 'Image not found or expired' });
    const buf = await r.buffer();
    res.json({ image: buf.toString('base64') });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════
   DOWNLOAD ALL — ZIP bundle
══════════════════════════════════════════ */
app.post('/download-all', async (req, res) => {
  try {
    const { images } = req.body;
    if (!images?.length) return res.status(400).json({ error: 'No images' });

    const zip    = new JSZip();
    const folder = zip.folder('probiotic-fizzy-ai-images');

    await Promise.allSettled(images.map(async (img) => {
      try {
        let buf;
        if (img.b64) {
          buf = Buffer.from(img.b64, 'base64');
        } else if (img.url?.startsWith('data:')) {
          buf = Buffer.from(img.url.split(',')[1], 'base64');
        } else if (img.url) {
          const r = await fetch(img.url);
          if (!r.ok) return;
          buf = await r.buffer();
        }
        if (buf) folder.file(`probiotic-fizzy-hd-${img.index}.png`, buf);
      } catch (e) { console.error('ZIP item error:', e.message); }
    }));

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });

  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── Utility ── */
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
