const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const JSZip    = require('jszip');
const FormData = require('form-data');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const HF_TOKEN    = process.env.HF_TOKEN;
const REMOVEBG_KEY = process.env.REMOVEBG_API_KEY;
const HF_API      = 'https://api-inference.huggingface.co/models';

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '30mb' }));

/* ── Health ── */
app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Instagram AI Backend running',
  services: {
    claude:   !!process.env.ANTHROPIC_API_KEY,
    removebg: !!REMOVEBG_KEY,
    huggingface: !!HF_TOKEN
  }
}));

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
      if (img.data) content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mtype || 'image/jpeg', data: img.data }
      });
    });
    const hasImg = images.length > 0;
    content.push({
      type: 'text',
      text: `${hasImg ? `Analyze the ${images.length} product image(s) (${images.map(i=>i.label).join(', ')}). Base content on what you see.\n\n` : ''}Create a ${type_label} about "${topic}". Tone: ${tone}. ${hashtag_instruction}.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."${hasImg?',"image_analysis":"..."':''}}`
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: 'You are an expert Instagram content creator for a probiotic fizzy beverages brand. Return ONLY valid JSON.', messages: [{ role: 'user', content }] })
    });
    if (!r.ok) { const e = await r.text(); return res.status(r.status).json({ error: 'Claude API error', details: e }); }
    const d = await r.json();
    res.json(JSON.parse(d.content.map(c => c.text||'').join('').replace(/```json|```/g,'').trim()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════
   BACKGROUND REMOVAL — Remove.bg API
   Free: 50 calls/month, no credit card
   Sign up: remove.bg/api
══════════════════════════════════════════ */
app.post('/remove-bg', async (req, res) => {
  try {
    const { image, mtype = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    if (!REMOVEBG_KEY) {
      console.log('No REMOVEBG_API_KEY — returning original');
      return res.json({ image, removed: false, reason: 'REMOVEBG_API_KEY not set' });
    }

    const imgBuffer = Buffer.from(image, 'base64');
    const form      = new FormData();
    form.append('image_file', imgBuffer, { filename: 'product.png', contentType: mtype });
    form.append('size', 'auto');
    form.append('format', 'png');

    const r = await fetch('https://api.remove.bg/v1.0/removebg', {
      method:  'POST',
      headers: { 'X-Api-Key': REMOVEBG_KEY, ...form.getHeaders() },
      body:    form
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('Remove.bg error:', errText);
      return res.json({ image, removed: false, reason: errText });
    }

    const resultBuffer = await r.buffer();
    const b64          = resultBuffer.toString('base64');
    res.json({ image: b64, removed: true });

  } catch (err) {
    console.error('BG removal error:', err);
    res.json({ image: req.body.image, removed: false, reason: err.message });
  }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION — FLUX.1 via Hugging Face
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;
    if (!HF_TOKEN) return res.status(500).json({ error: 'HF_TOKEN not set in environment variables' });

    const objText = objects ? ` with ${objects}` : '';
    const prompt  = `Professional commercial product photography. A probiotic fizzy beverage bottle/can${objText} placed in ${theme}. ${mood} lighting. ${style}. Product is sharp, prominent, ultra detailed, 8K resolution, photorealistic, no text overlays.`;

    /* Try FLUX.1-schnell first */
    const r1 = await callHF('black-forest-labs/FLUX.1-schnell', prompt);
    if (r1) return res.json({ url: r1.url, b64: r1.b64, index });

    /* Fallback — SDXL */
    console.log('FLUX failed, trying SDXL...');
    const r2 = await callHF('stabilityai/stable-diffusion-xl-base-1.0', prompt);
    if (r2) return res.json({ url: r2.url, b64: r2.b64, index });

    res.status(500).json({ error: 'Generation failed. Models may be loading — try again in 30 seconds.' });

  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function callHF(modelId, prompt, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${HF_API}/${modelId}`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: prompt, parameters: { num_inference_steps: 4, guidance_scale: 3.5, width: 1024, height: 1024 } })
      });

      if (!r.ok) {
        const errText = await r.text();
        if (errText.includes('loading') && attempt < retries) {
          console.log(`${modelId} loading, waiting 20s...`);
          await sleep(20000);
          continue;
        }
        console.error(`${modelId} failed:`, errText);
        return null;
      }

      const buf = await r.buffer();
      const b64 = buf.toString('base64');
      return { url: `data:image/png;base64,${b64}`, b64 };

    } catch (err) {
      console.error(`${modelId} error:`, err.message);
      if (attempt < retries) await sleep(5000);
    }
  }
  return null;
}

/* ══════════════════════════════════════════
   PROXY IMAGE
══════════════════════════════════════════ */
app.post('/proxy-image', async (req, res) => {
  try {
    const { url, b64 } = req.body;
    if (b64) return res.json({ image: b64 });
    if (!url) return res.status(400).json({ error: 'No URL or b64' });
    if (url.startsWith('data:')) return res.json({ image: url.split(',')[1] });
    const r = await fetch(url);
    if (!r.ok) return res.status(404).json({ error: 'Image not found' });
    res.json({ image: (await r.buffer()).toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════
   DOWNLOAD ALL — ZIP
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
        if (img.b64)                     buf = Buffer.from(img.b64, 'base64');
        else if (img.url?.startsWith('data:')) buf = Buffer.from(img.url.split(',')[1], 'base64');
        else if (img.url)                { const r = await fetch(img.url); if (r.ok) buf = await r.buffer(); }
        if (buf) folder.file(`probiotic-fizzy-hd-${img.index}.png`, buf);
      } catch (e) { console.error('ZIP item error:', e.message); }
    }));

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
