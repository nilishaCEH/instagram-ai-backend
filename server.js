const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const JSZip    = require('jszip');
const FormData = require('form-data');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '30mb' }));

/* ── Health ── */
app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Instagram AI Backend running',
  services: {
    claude:    !!process.env.ANTHROPIC_API_KEY,
    removebg:  !!process.env.REMOVEBG_API_KEY,
    hf_token:  !!process.env.HF_TOKEN,
    image_gen: process.env.HF_TOKEN ? 'huggingface + pollinations fallback' : 'pollinations.ai (free)'
  }
}));

/* ══════════════════════════════════════════
   INSTAGRAM CONTENT — Claude API
══════════════════════════════════════════ */
app.post('/generate', async (req, res) => {
  try {
    const { type_label = 'Instagram feed post', topic = 'probiotic fizzy beverages', tone = 'fun & energetic', hashtag_instruction = '20-25 mixed hashtags', images = [] } = req.body;
    const content = [];
    images.forEach(img => {
      if (img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.mtype || 'image/jpeg', data: img.data } });
    });
    const hasImg = images.length > 0;
    content.push({ type: 'text', text: `${hasImg ? `Analyze the ${images.length} product image(s) (${images.map(i => i.label).join(', ')}). Base content on what you see.\n\n` : ''}Create a ${type_label} about "${topic}". Tone: ${tone}. ${hashtag_instruction}.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."${hasImg ? ',"image_analysis":"..."' : ''}}` });
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
   BACKGROUND REMOVAL — Remove.bg
   Free: 50 calls/month — remove.bg/api
══════════════════════════════════════════ */
app.post('/remove-bg', async (req, res) => {
  try {
    const { image, mtype = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    if (!process.env.REMOVEBG_API_KEY) return res.json({ image, removed: false, reason: 'REMOVEBG_API_KEY not set' });

    const form = new FormData();
    form.append('image_file', Buffer.from(image, 'base64'), { filename: 'product.png', contentType: mtype });
    form.append('size', 'auto');

    const r = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY, ...form.getHeaders() },
      body: form
    });

    if (!r.ok) { const e = await r.text(); console.error('Remove.bg error:', e); return res.json({ image, removed: false, reason: e }); }
    res.json({ image: (await r.buffer()).toString('base64'), removed: true });
  } catch (err) { console.error('BG error:', err); res.json({ image: req.body.image, removed: false, reason: err.message }); }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION
   Primary:  Hugging Face FLUX.1-schnell (if HF_TOKEN set)
   Fallback: Pollinations.ai (always free, no key)
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { theme, objects, mood, style, index = 0 } = req.body;
    const objText = objects ? ` with ${objects}` : '';
    const prompt  = `Professional commercial product photography of a probiotic fizzy beverage bottle${objText}, placed in ${theme}, ${mood} lighting, ${style}, ultra detailed, 8K resolution, photorealistic, product perfectly in focus, no text overlays, award winning photography`;

    /* Try Hugging Face first if token is available */
    if (process.env.HF_TOKEN) {
      const hfResult = await tryHuggingFace(prompt, index);
      if (hfResult) return res.json(hfResult);
      console.log(`HF failed for image ${index + 1}, falling back to Pollinations...`);
    }

    /* Fallback / Primary: Pollinations.ai — always free */
    const pollResult = await tryPollinations(prompt, index);
    if (pollResult) return res.json(pollResult);

    res.status(500).json({ error: 'All image generation methods failed. Please try again.' });
  } catch (err) { console.error('Edit image error:', err); res.status(500).json({ error: err.message }); }
});

/* ── Hugging Face FLUX.1-schnell ── */
async function tryHuggingFace(prompt, index) {
  try {
    /* Correct endpoint — simple inputs format, no extra params */
    const r = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell/v1/text-to-image', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({ inputs: prompt, parameters: { width: 1024, height: 1024 } }),
      timeout: 60000
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error(`HF FLUX error (${r.status}):`, errText.slice(0, 200));
      return null;
    }

    const buf = await r.buffer();
    /* Validate we got an image not an error JSON */
    if (buf[0] === 123) { /* '{' — JSON error response */
      console.error('HF returned JSON instead of image:', buf.toString().slice(0, 200));
      return null;
    }

    const b64 = buf.toString('base64');
    return { url: `data:image/jpeg;base64,${b64}`, b64, index, source: 'huggingface' };
  } catch (err) {
    console.error('HF error:', err.message);
    return null;
  }
}

/* ── Pollinations.ai — completely free, no key ── */
async function tryPollinations(prompt, index) {
  try {
    const seed    = Date.now() + index * 1000;
    const encoded = encodeURIComponent(prompt);
    const url     = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true&model=flux`;

    console.log(`Generating image ${index + 1} via Pollinations.ai...`);

    const r = await fetch(url, {
      headers: { 'User-Agent': 'InstagramAI/1.0' },
      timeout: 90000
    });

    if (!r.ok) { console.error('Pollinations error:', r.status); return null; }

    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const buf = await r.buffer();
    const b64 = buf.toString('base64');
    return { url: `data:${contentType};base64,${b64}`, b64, index, source: 'pollinations' };
  } catch (err) {
    console.error('Pollinations error:', err.message);
    return null;
  }
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
    const zip = new JSZip();
    const folder = zip.folder('probiotic-fizzy-ai-images');
    await Promise.allSettled(images.map(async (img) => {
      try {
        let buf;
        if (img.b64) buf = Buffer.from(img.b64, 'base64');
        else if (img.url?.startsWith('data:')) buf = Buffer.from(img.url.split(',')[1], 'base64');
        else if (img.url) { const r = await fetch(img.url); if (r.ok) buf = await r.buffer(); }
        if (buf) folder.file(`probiotic-fizzy-hd-${img.index}.png`, buf);
      } catch (e) { console.error('ZIP item error:', e.message); }
    }));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
