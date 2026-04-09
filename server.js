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
    image_gen: process.env.HF_TOKEN ? 'hf FLUX + pollinations fallback' : 'pollinations.ai (free)'
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
  } catch (err) { console.error('BG error:', err); res.json({ image: req.body.image, removed: false, reason: err.message }); }
});

/* ══════════════════════════════════════════
   IMAGE GENERATION
   Tier 1 — HF FLUX.1-schnell (correct router URL)
   Tier 2 — Pollinations.ai  (free, with retry)
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;
    const objText = objects ? ', ' + objects + ' nearby' : '';

    /* Use Claude to describe the product so FLUX recreates it accurately */
    let productDesc = 'a probiotic fizzy beverage bottle with colorful label and branding';
    if (image && process.env.ANTHROPIC_API_KEY) {
      try {
        const dr = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 120,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
                { type: 'text', text: 'Describe this beverage product in one sentence for a photography prompt. Include: bottle/can shape, label colors, branding details. Be specific and visual. No intro, just the description.' }
              ]
            }]
          })
        });
        if (dr.ok) {
          const dd = await dr.json();
          const desc = dd.content[0]?.text?.trim();
          if (desc) { productDesc = desc; console.log('[' + (index+1) + '] Product: ' + productDesc.slice(0, 80)); }
        }
      } catch (e) { console.log('[' + (index+1) + '] Product description failed, using generic'); }
    }

    const prompt = 'Professional commercial product photography: ' + productDesc + objText + ', placed in ' + theme + ', ' + mood + ' lighting, ' + style + ', ultra detailed, 8K, photorealistic, product in sharp focus, no text overlays, award winning photography';

    /* Tier 1: HF FLUX.1-schnell — correct URL */
    if (process.env.HF_TOKEN) {
      const hfResult = await tryHF(prompt, index);
      if (hfResult) return res.json(hfResult);
    }

    /* Tier 2: Pollinations with retry on 429 */
    const pollResult = await tryPollinations(prompt, index);
    if (pollResult) return res.json(pollResult);

    res.status(500).json({ error: 'Generation failed. Please try again in a few seconds.' });
  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── HF FLUX.1-schnell — correct router URL ── */
async function tryHF(prompt, index) {
  /* Two URL formats to try — HF keeps changing these */
  const urls = [
    'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell/v1/text-to-image',
    'https://router.huggingface.co/nebius/v1/images/generations'
  ];

  for (const url of urls) {
    try {
      console.log('[' + (index+1) + '] Trying HF: ' + url.split('/').slice(-3).join('/'));

      /* Different body format for each endpoint */
      const isNebius = url.includes('nebius');
      const body = isNebius
        ? JSON.stringify({ model: 'black-forest-labs/FLUX.1-schnell', prompt, width: 1024, height: 1024, num_inference_steps: 4, response_format: 'b64_json' })
        : JSON.stringify({ inputs: prompt, parameters: { width: 1024, height: 1024 } });

      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.HF_TOKEN, 'Content-Type': 'application/json' },
        body
      });

      if (!r.ok) {
        const e = await r.text();
        console.error('[' + (index+1) + '] HF ' + r.status + ' at ' + url.split('/').slice(-2).join('/') + ':', e.slice(0, 200));
        continue;
      }

      /* Nebius returns JSON with b64, HF returns raw image bytes */
      if (isNebius) {
        const data = await r.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) { console.error('[' + (index+1) + '] Nebius: no b64 in response'); continue; }
        return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'hf-nebius' };
      } else {
        const buf = await r.buffer();
        if (buf[0] === 123) { console.error('[' + (index+1) + '] HF returned JSON error:', buf.toString().slice(0, 150)); continue; }
        const b64 = buf.toString('base64');
        return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'hf-flux' };
      }
    } catch (err) {
      console.error('[' + (index+1) + '] HF error:', err.message);
    }
  }
  console.log('[' + (index+1) + '] All HF endpoints failed, using Pollinations...');
  return null;
}

/* ── Pollinations.ai — free, handles 429 with retry ── */
async function tryPollinations(prompt, index) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      /* Stagger requests to avoid 429 — wait longer for later images */
      const delay = index * 2000 + attempt * 5000;
      if (delay > 0) {
        console.log('[' + (index+1) + '] Waiting ' + (delay/1000) + 's before Pollinations...');
        await sleep(delay);
      }

      const seed    = Date.now() + index * 1337 + attempt * 777;
      const encoded = encodeURIComponent(prompt);
      const url     = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=1024&seed=' + seed + '&nologo=true&model=flux';

      console.log('[' + (index+1) + '] Pollinations attempt ' + (attempt+1) + '...');
      const r = await fetch(url, { headers: { 'User-Agent': 'InstagramAI/1.0' } });

      if (r.status === 429) {
        console.log('[' + (index+1) + '] Pollinations 429, retrying after 10s...');
        await sleep(10000);
        continue;
      }

      if (!r.ok) { console.error('[' + (index+1) + '] Pollinations error:', r.status); return null; }

      const ct  = r.headers.get('content-type') || 'image/jpeg';
      const buf = await r.buffer();

      /* Make sure we got an image not an error page */
      if (buf[0] === 60 || buf[0] === 123) { /* '<' HTML or '{' JSON */
        console.error('[' + (index+1) + '] Pollinations returned non-image response');
        await sleep(5000);
        continue;
      }

      const b64 = buf.toString('base64');
      return { url: 'data:' + ct + ';base64,' + b64, b64, index, source: 'pollinations' };

    } catch (err) {
      console.error('[' + (index+1) + '] Pollinations error:', err.message);
      if (attempt < maxRetries - 1) await sleep(5000);
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
      } catch (e) { console.error('ZIP item error:', e.message); }
    }));
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log('Backend running on port ' + PORT));
