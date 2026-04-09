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
    image_gen: process.env.HF_TOKEN ? 'hf img2img + pollinations fallback' : 'pollinations.ai'
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
      text: `${hasImg ? `Analyze the ${images.length} product image(s) (${images.map(i => i.label).join(', ')}). Base content on what you see.\n\n` : ''}Create a ${type_label} about "${topic}". Tone: ${tone}. ${hashtag_instruction}.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."${hasImg ? ',"image_analysis":"..."' : ''}}`
    });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: 'You are an expert Instagram content creator for a probiotic fizzy beverages brand. Return ONLY valid JSON.',
        messages: [{ role: 'user', content }]
      })
    });

    if (!r.ok) {
      const e = await r.text();
      return res.status(r.status).json({ error: 'Claude API error', details: e });
    }
    const d = await r.json();
    res.json(JSON.parse(d.content.map(c => c.text || '').join('').replace(/```json|```/g, '').trim()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   BACKGROUND REMOVAL — Remove.bg
   Free: 50 calls/month at remove.bg/api
══════════════════════════════════════════ */
app.post('/remove-bg', async (req, res) => {
  try {
    const { image, mtype = 'image/jpeg' } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    if (!process.env.REMOVEBG_API_KEY) {
      return res.json({ image, removed: false, reason: 'REMOVEBG_API_KEY not set. Get free key at remove.bg/api' });
    }

    const form = new FormData();
    form.append('image_file', Buffer.from(image, 'base64'), {
      filename: 'product.png',
      contentType: mtype
    });
    form.append('size', 'auto');

    const r = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY, ...form.getHeaders() },
      body: form
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('Remove.bg error:', e);
      return res.json({ image, removed: false, reason: e });
    }

    const buf = await r.buffer();
    res.json({ image: buf.toString('base64'), removed: true });
  } catch (err) {
    console.error('BG removal error:', err);
    res.json({ image: req.body.image, removed: false, reason: err.message });
  }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION — 3-tier approach:
   1. HF fal-ai img2img  (uses YOUR product image)
   2. HF FLUX text2img   (HF credits, no image input)
   3. Pollinations.ai    (always free, always works)
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;

    const objText     = objects ? ` with ${objects}` : '';
    const productDesc = image
      ? 'the exact probiotic fizzy beverage product from the reference image — keep bottle/can shape, label colors and branding identical'
      : 'a probiotic fizzy beverage bottle';

    const prompt = `${productDesc}${objText}, placed in ${theme}, ${mood} lighting, ${style}, ultra detailed, 8K resolution, photorealistic, product perfectly in focus, no text overlays, award winning commercial product photography`;

    /* Tier 1: HF img2img — actually uses your uploaded product image */
    if (process.env.HF_TOKEN && image) {
      console.log(`[${index+1}] Trying HF img2img...`);
      const result = await hfImg2Img(prompt, image, index);
      if (result) return res.json(result);
      console.log(`[${index+1}] HF img2img failed, trying HF text2img...`);
    }

    /* Tier 2: HF text2img — uses credits, good quality */
    if (process.env.HF_TOKEN) {
      console.log(`[${index+1}] Trying HF text2img...`);
      const result = await hfText2Img(prompt, index);
      if (result) return res.json(result);
      console.log(`[${index+1}] HF text2img failed, falling back to Pollinations...`);
    }

    /* Tier 3: Pollinations.ai — always free, always works */
    console.log(`[${index+1}] Trying Pollinations.ai...`);
    const result = await pollinations(prompt, index);
    if (result) return res.json(result);

    res.status(500).json({ error: 'All generation methods failed. Please try again in a few seconds.' });
  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── Tier 1: fal-ai img2img via HF router (uses product image) ── */
async function hfImg2Img(prompt, imageB64, index) {
  try {
    const r = await fetch('https://router.huggingface.co/fal-ai/flux/dev/image-to-image', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image_url:           `data:image/png;base64,${imageB64}`,
        prompt:              prompt,
        strength:            0.80,
        num_inference_steps: 28,
        guidance_scale:      3.5,
        image_size:          { width: 1024, height: 1024 }
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error(`HF img2img ${r.status}:`, e.slice(0, 300));
      return null;
    }

    const data   = await r.json();
    const imgUrl = data?.images?.[0]?.url || data?.image?.url;
    if (!imgUrl) {
      console.error('HF img2img: no URL in response:', JSON.stringify(data).slice(0, 200));
      return null;
    }

    /* Fetch image bytes from the returned URL */
    const imgR = await fetch(imgUrl);
    if (!imgR.ok) return null;
    const buf = await imgR.buffer();
    const b64 = buf.toString('base64');
    return { url: `data:image/jpeg;base64,${b64}`, b64, index, source: 'hf-img2img' };
  } catch (err) {
    console.error('HF img2img error:', err.message);
    return null;
  }
}

/* ── Tier 2: FLUX.1-schnell text2img via HF router ── */
async function hfText2Img(prompt, index) {
  try {
    const r = await fetch('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell/v1/text-to-image', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { width: 1024, height: 1024 }
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error(`HF text2img ${r.status}:`, e.slice(0, 200));
      return null;
    }

    const buf = await r.buffer();
    if (buf[0] === 123) {
      console.error('HF text2img returned JSON error:', buf.toString().slice(0, 200));
      return null;
    }

    const b64 = buf.toString('base64');
    return { url: `data:image/jpeg;base64,${b64}`, b64, index, source: 'hf-text2img' };
  } catch (err) {
    console.error('HF text2img error:', err.message);
    return null;
  }
}

/* ── Tier 3: Pollinations.ai — no key, always free ── */
async function pollinations(prompt, index) {
  try {
    const seed    = Date.now() + index * 1337;
    const encoded = encodeURIComponent(prompt);
    const url     = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true&model=flux`;

    const r = await fetch(url, { headers: { 'User-Agent': 'InstagramAI/1.0' } });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        if (img.b64)                       buf = Buffer.from(img.b64, 'base64');
        else if (img.url?.startsWith('data:')) buf = Buffer.from(img.url.split(',')[1], 'base64');
        else if (img.url) {
          const r = await fetch(img.url);
          if (r.ok) buf = await r.buffer();
        }
        if (buf) folder.file(`probiotic-fizzy-hd-${img.index}.png`, buf);
      } catch (e) {
        console.error('ZIP item error:', e.message);
      }
    }));

    const zipBuf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
