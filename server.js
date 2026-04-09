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

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Health ── */
app.get('/', (req, res) => res.json({
  status: 'ok',
  message: 'Instagram AI Backend running',
  services: {
    claude:   !!process.env.ANTHROPIC_API_KEY,
    removebg: !!process.env.REMOVEBG_API_KEY,
    hf_token: !!process.env.HF_TOKEN,
    image_gen: process.env.HF_TOKEN ? 'fal-ai FLUX via HF router + pollinations fallback' : 'pollinations.ai (free)'
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
    content.push({ type: 'text', text: (hasImg ? 'Analyze the ' + images.length + ' product image(s) (' + images.map(i => i.label).join(', ') + '). Base content on what you see.\n\n' : '') + 'Create a ' + type_label + ' about "' + topic + '". Tone: ' + tone + '. ' + hashtag_instruction + '.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."' + (hasImg ? ',"image_analysis":"..."' : '') + '}' });
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
      method: 'POST', headers: { 'X-Api-Key': process.env.REMOVEBG_API_KEY, ...form.getHeaders() }, body: form
    });
    if (!r.ok) { const e = await r.text(); console.error('Remove.bg:', e); return res.json({ image, removed: false, reason: e }); }
    res.json({ image: (await r.buffer()).toString('base64'), removed: true });
  } catch (err) { res.json({ image: req.body.image, removed: false, reason: err.message }); }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION — single image
   Tier 1: fal-ai/flux/schnell via HF router
   Tier 2: Pollinations.ai (free fallback)
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;
    const objText = objects ? ', ' + objects + ' nearby' : '';

    /* Use Claude to describe product so FLUX can recreate it */
    let productDesc = 'a probiotic fizzy beverage bottle with colorful label';
    if (image && process.env.ANTHROPIC_API_KEY) {
      try {
        const dr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{ role: 'user', content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
              { type: 'text', text: 'Describe this beverage product in one sentence for a photography prompt. Include bottle/can shape, label colors, branding. Be specific. No intro text.' }
            ]}]
          })
        });
        if (dr.ok) {
          const dd = await dr.json();
          const desc = dd.content[0]?.text?.trim();
          if (desc) productDesc = desc;
        }
      } catch (e) { /* use generic description */ }
    }

    const prompt = 'Professional commercial product photography: ' + productDesc + objText + ', placed in ' + theme + ', ' + mood + ' lighting, ' + style + ', ultra detailed, 8K, photorealistic, product in sharp focus, no text overlays, award winning photography';

    console.log('[' + (index+1) + '] Generating: ' + prompt.slice(0, 100) + '...');

    /* Tier 1: fal-ai FLUX.1-schnell via HF router — correct URL */
    if (process.env.HF_TOKEN) {
      const result = await tryFalAI(prompt, index);
      if (result) return res.json(result);
    }

    /* Tier 2: Pollinations.ai */
    const result = await tryPollinations(prompt, index);
    if (result) return res.json(result);

    res.status(500).json({ error: 'Generation failed. Please try again.' });
  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── fal-ai FLUX.1-schnell via HF router (correct URL) ── */
async function tryFalAI(prompt, index) {
  /* Correct URL format for fal-ai via HF router */
  const url = 'https://router.huggingface.co/fal-ai/fal-ai/flux/schnell';
  try {
    console.log('[' + (index+1) + '] Trying fal-ai FLUX via HF router...');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.HF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        image_size:          { width: 1024, height: 1024 },
        num_inference_steps: 4,
        num_images:          1,
        enable_safety_checker: false
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[' + (index+1) + '] fal-ai ' + r.status + ':', e.slice(0, 300));
      /* Try alternative fal-ai URL format */
      return await tryFalAIAlt(prompt, index);
    }

    const data = await r.json();
    /* fal-ai returns { images: [{ url, content_type }] } */
    const imgUrl = data?.images?.[0]?.url;
    if (!imgUrl) {
      console.error('[' + (index+1) + '] fal-ai: no image URL:', JSON.stringify(data).slice(0, 200));
      return await tryFalAIAlt(prompt, index);
    }

    /* Fetch the image from the returned URL */
    const imgR = await fetch(imgUrl);
    if (!imgR.ok) return null;
    const buf = await imgR.buffer();
    const b64 = buf.toString('base64');
    return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'fal-flux-schnell' };

  } catch (err) {
    console.error('[' + (index+1) + '] fal-ai error:', err.message);
    return await tryFalAIAlt(prompt, index);
  }
}

/* ── Alternative fal-ai URL format ── */
async function tryFalAIAlt(prompt, index) {
  const url = 'https://router.huggingface.co/fal-ai/fal-ai/flux/dev';
  try {
    console.log('[' + (index+1) + '] Trying fal-ai FLUX.dev alt...');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.HF_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        image_size:          { width: 1024, height: 1024 },
        num_inference_steps: 28,
        guidance_scale:      3.5,
        num_images:          1,
        enable_safety_checker: false
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[' + (index+1) + '] fal-ai dev ' + r.status + ':', e.slice(0, 300));
      return null;
    }

    const data   = await r.json();
    const imgUrl = data?.images?.[0]?.url;
    if (!imgUrl) return null;

    const imgR = await fetch(imgUrl);
    if (!imgR.ok) return null;
    const buf = await imgR.buffer();
    const b64 = buf.toString('base64');
    return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'fal-flux-dev' };
  } catch (err) {
    console.error('[' + (index+1) + '] fal-ai dev error:', err.message);
    return null;
  }
}

/* ── Pollinations.ai — free, with retry on 429 ── */
async function tryPollinations(prompt, index) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      /* Stagger requests: image 1 = 0s wait, image 2 = 3s, image 3 = 6s etc */
      const stagger = index * 3000 + attempt * 8000;
      if (stagger > 0) { console.log('[' + (index+1) + '] Waiting ' + (stagger/1000) + 's...'); await sleep(stagger); }

      const seed    = Date.now() + index * 1337 + attempt * 999;
      const encoded = encodeURIComponent(prompt);
      const url     = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=1024&seed=' + seed + '&nologo=true&model=flux';

      console.log('[' + (index+1) + '] Pollinations attempt ' + (attempt+1) + '...');
      const r = await fetch(url, { headers: { 'User-Agent': 'InstagramAI/1.0' } });

      if (r.status === 429) { console.log('[' + (index+1) + '] 429, waiting 15s...'); await sleep(15000); continue; }
      if (!r.ok) { console.error('[' + (index+1) + '] Pollinations:', r.status); return null; }

      const ct  = r.headers.get('content-type') || 'image/jpeg';
      const buf = await r.buffer();
      if (buf[0] === 60 || buf[0] === 123) { await sleep(5000); continue; }

      const b64 = buf.toString('base64');
      return { url: 'data:' + ct + ';base64,' + b64, b64, index, source: 'pollinations' };
    } catch (err) {
      console.error('[' + (index+1) + '] Pollinations error:', err.message);
      if (attempt < 2) await sleep(5000);
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
        if (img.b64)                           buf = Buffer.from(img.b64, 'base64');
        else if (img.url?.startsWith('data:')) buf = Buffer.from(img.url.split(',')[1], 'base64');
        else if (img.url)                      { const r = await fetch(img.url); if (r.ok) buf = await r.buffer(); }
        if (buf) folder.file('probiotic-fizzy-hd-' + img.index + '.png', buf);
      } catch (e) { console.error('ZIP error:', e.message); }
    }));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log('Backend running on port ' + PORT));
