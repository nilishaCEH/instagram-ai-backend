const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const JSZip    = require('jszip');
const FormData = require('form-data');
const jwt      = require('jsonwebtoken');
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
    hf_token:     !!process.env.HF_TOKEN,
    together_key: !!process.env.TOGETHER_API_KEY,
    kling_keys:   !!(process.env.KLING_ACCESS_KEY && process.env.KLING_SECRET_KEY),
    image_gen: process.env.TOGETHER_API_KEY ? 'FLUX Kontext Pro (Together AI) — professional product placement' : process.env.HF_TOKEN ? 'fal-ai FLUX + pollinations fallback' : 'pollinations.ai (free)'
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
    const { image, theme, objects, mood, style, index = 0, prompt_override } = req.body;
    const objText = objects ? ' with ' + objects : '';

    /* ── Tier 1: FLUX Kontext via Together AI (professional product placement) ── */
    /* Sends your actual product image — AI handles lighting, shadows, perspective */
    if (process.env.TOGETHER_API_KEY && image) {
      console.log('[' + (index+1) + '] Trying FLUX Kontext (Together AI)...');
      const result = await tryKontext(image, theme, objects, mood, style, index);
      if (result) return res.json(result);
      console.log('[' + (index+1) + '] Kontext failed, falling back...');
    }

    /* ── Tier 2: Background-only generation + compositing hint ── */
    const prompt = prompt_override || ('Professional commercial product photography background scene: ' + theme + objText + ', ' + mood + ' lighting, ' + style + ', ultra detailed, 8K, photorealistic, no products, no bottles, no text overlays');
    console.log('[' + (index+1) + '] Generating background: ' + prompt.slice(0, 100) + '...');

    /* Try HF fal-ai */
    if (process.env.HF_TOKEN) {
      const result = await tryFalAI(prompt, index);
      if (result) return res.json(result);
    }

    /* Fallback: Pollinations */
    const result = await tryPollinations(prompt, index);
    if (result) return res.json(result);

    res.status(500).json({ error: 'Generation failed. Please try again.' });
  } catch (err) {
    console.error('Edit image error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ── FLUX Kontext via Together AI ── */
/* Takes your product image + prompt → professional placement with correct lighting */
async function tryKontext(imageB64, theme, objects, mood, style, index) {
  try {
    const objText  = objects ? ' surrounded by ' + objects + ',' : '';
    const prompt   = 'Place this exact product' + objText + ' in ' + theme + '. ' + mood + ' lighting matching the environment. ' + style + '. Keep the product label, colors, and branding completely unchanged. Natural shadows and reflections. Photorealistic, commercial product photography quality.';

    /* Upload image to a temp host so Together AI can access it via URL */
    /* Together AI accepts base64 directly in image_url as data URI */
    const r = await fetch('https://api.together.xyz/v1/images/generations', {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.TOGETHER_API_KEY,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:           'black-forest-labs/FLUX.1-kontext-pro',
        prompt,
        image_url:       'data:image/png;base64,' + imageB64,
        width:           1024,
        height:          1024,
        steps:           28,
        n:               1,
        response_format: 'b64_json'
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[' + (index+1) + '] Kontext ' + r.status + ':', e.slice(0, 300));
      return null;
    }

    const data = await r.json();
    const b64  = data?.data?.[0]?.b64_json;
    if (!b64) {
      /* Try URL response format */
      const imgUrl = data?.data?.[0]?.url;
      if (imgUrl) {
        const imgR = await fetch(imgUrl);
        if (!imgR.ok) return null;
        const buf = await imgR.buffer();
        const b64v = buf.toString('base64');
        return { url: 'data:image/jpeg;base64,' + b64v, b64: b64v, index, source: 'kontext' };
      }
      console.error('[' + (index+1) + '] Kontext: no image in response:', JSON.stringify(data).slice(0, 200));
      return null;
    }

    return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'kontext' };
  } catch (err) {
    console.error('[' + (index+1) + '] Kontext error:', err.message);
    return null;
  }
}

/* ── fal-ai FLUX.1-schnell via HF router ── */
async function tryFalAI(prompt, index) {
  try {
    console.log('[' + (index+1) + '] Trying fal-ai via HF router...');
    const r = await fetch('https://router.huggingface.co/fal-ai/fal-ai/flux/schnell', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.HF_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, image_size: { width: 1024, height: 1024 }, num_inference_steps: 4, num_images: 1, enable_safety_checker: false })
    });
    if (!r.ok) { const e = await r.text(); console.error('[' + (index+1) + '] fal-ai ' + r.status + ':', e.slice(0, 200)); return null; }
    const data   = await r.json();
    const imgUrl = data?.images?.[0]?.url;
    if (!imgUrl) return null;
    const imgR = await fetch(imgUrl);
    if (!imgR.ok) return null;
    const buf = await imgR.buffer();
    const b64 = buf.toString('base64');
    return { url: 'data:image/jpeg;base64,' + b64, b64, index, source: 'fal-flux' };
  } catch (err) {
    console.error('[' + (index+1) + '] fal-ai error:', err.message);
    return null;
  }
}

/* ── Pollinations.ai — free, with retry on 429 ── */
async function tryPollinations(prompt, index) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const stagger = index * 3000 + attempt * 8000;
      if (stagger > 0) { await sleep(stagger); }
      const seed    = Date.now() + index * 1337 + attempt * 999;
      const encoded = encodeURIComponent(prompt);
      const url     = 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=1024&seed=' + seed + '&nologo=true&model=flux';
      const r = await fetch(url, { headers: { 'User-Agent': 'InstagramAI/1.0' } });
      if (r.status === 429) { await sleep(15000); continue; }
      if (!r.ok) { return null; }
      const ct  = r.headers.get('content-type') || 'image/jpeg';
      const buf = await r.buffer();
      if (buf[0] === 60 || buf[0] === 123) { await sleep(5000); continue; }
      const b64 = buf.toString('base64');
      return { url: 'data:' + ct + ';base64,' + b64, b64, index, source: 'pollinations' };
    } catch (err) {
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


/* ══════════════════════════════════════════
   KLING AI — JWT Helper
══════════════════════════════════════════ */
function makeKlingToken() {
  const ak = process.env.KLING_ACCESS_KEY;
  const sk = process.env.KLING_SECRET_KEY;
  if (!ak || !sk) return null;
  const now = Math.floor(Date.now() / 1000);
  /* Kling requires iss, iat, exp AND nbf — all must be integers */
  const payload = {
    iss: ak,
    iat: now,
    exp: now + 1800,
    nbf: now - 5   /* valid from 5 seconds ago to handle clock skew */
  };
  return jwt.sign(payload, sk, { algorithm: 'HS256' });
}

/* ══════════════════════════════════════════
   KLING IMAGE GENERATION
   POST /kling-image
══════════════════════════════════════════ */
app.post('/kling-image', async (req, res) => {
  try {
    const token = makeKlingToken();
    if (!token) return res.status(400).json({ error: 'KLING_ACCESS_KEY and KLING_SECRET_KEY not set in Render environment' });

    const { prompt, negative_prompt = 'text, watermark, blurry, low quality', aspect_ratio = '1:1', n = 1, index = 0 } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    console.log('[Kling Img] Submitting: ' + prompt.slice(0, 80));

    const createR = await fetch('https://api.klingai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kling-v1', prompt, negative_prompt, n, aspect_ratio })
    });

    if (!createR.ok) {
      const e = await createR.text();
      console.error('[Kling Img] Create ' + createR.status + ':', e.slice(0, 300));
      return res.status(createR.status).json({ error: 'Kling image creation failed', details: e.slice(0, 200) });
    }

    const cd     = await createR.json();
    const taskId = cd?.data?.task_id;
    if (!taskId) return res.status(500).json({ error: 'No task_id', raw: cd });
    console.log('[Kling Img] Task:', taskId);

    /* Poll up to 120s */
    const result = await pollKlingImageTask(taskId, 120);
    if (!result) return res.status(504).json({ error: 'Kling timed out. Try again.' });
    if (result.error) return res.status(500).json({ error: result.error });

    const images = result.images || [];
    if (!images.length) return res.status(500).json({ error: 'No images returned' });

    const outputs = await Promise.all(images.map(async (img, i) => {
      try {
        const r   = await fetch(img.url);
        const buf = await r.buffer();
        const b64 = buf.toString('base64');
        return { url: 'data:image/jpeg;base64,' + b64, b64, index: index + i, source: 'kling-image' };
      } catch (e) { return { url: img.url, b64: null, index: index + i, source: 'kling-image' }; }
    }));

    res.json({ images: outputs, task_id: taskId });
  } catch (err) {
    console.error('[Kling Img] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════
   KLING VIDEO GENERATION
   POST /kling-video  — returns task_id immediately
   GET  /kling-video-status/:taskId — poll status
══════════════════════════════════════════ */
app.post('/kling-video', async (req, res) => {
  try {
    const token = makeKlingToken();
    if (!token) return res.status(400).json({ error: 'KLING_ACCESS_KEY and KLING_SECRET_KEY not set' });

    const {
      prompt,
      image,            /* base64 for image-to-video */
      duration    = '5',
      aspect_ratio = '9:16',
      mode        = 'std',
      negative_prompt = 'text, watermark, logo, blur, distorted, artifacts',
      cfg_scale   = 0.5
    } = req.body;

    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const isI2V    = !!image;
    const endpoint = isI2V
      ? 'https://api.klingai.com/v1/videos/image2video'
      : 'https://api.klingai.com/v1/videos/text2video';

    const payload = isI2V
      ? { model: 'kling-v1', image, prompt, negative_prompt, cfg_scale, mode, duration }
      : { model: 'kling-v1', prompt, negative_prompt, cfg_scale, mode, duration, aspect_ratio };

    console.log('[Kling Video] Submitting ' + (isI2V ? 'i2v' : 't2v') + ' task...');

    const createR = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!createR.ok) {
      const e = await createR.text();
      console.error('[Kling Video] Create ' + createR.status + ':', e.slice(0, 300));
      return res.status(createR.status).json({ error: 'Kling video creation failed', details: e.slice(0, 200) });
    }

    const cd     = await createR.json();
    const taskId = cd?.data?.task_id;
    if (!taskId) return res.status(500).json({ error: 'No task_id', raw: cd });

    console.log('[Kling Video] Task:', taskId, '| type:', isI2V ? 'i2v' : 't2v');
    res.json({ task_id: taskId, status: 'submitted', type: isI2V ? 'i2v' : 't2v' });

  } catch (err) {
    console.error('[Kling Video] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Video status polling endpoint ── */
app.get('/kling-video-status/:taskId', async (req, res) => {
  try {
    const token  = makeKlingToken();
    if (!token) return res.status(400).json({ error: 'Kling keys not configured' });
    const taskId = req.params.taskId;

    /* Try both endpoints — we don't know which type was used */
    let data = null;
    for (const ep of ['text2video', 'image2video']) {
      try {
        const r = await fetch('https://api.klingai.com/v1/videos/' + ep + '/' + taskId, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (r.ok) { data = await r.json(); break; }
      } catch (e) {}
    }

    if (!data) return res.status(404).json({ error: 'Task not found' });

    const task    = data?.data;
    const status  = task?.task_status;
    const videos  = task?.task_result?.videos || [];
    const video   = videos[0];

    const normalized = {
      task_id:   task?.task_id,
      status:    status === 'succeed' ? 'succeeded' : status === 'failed' ? 'failed' : 'processing',
      kling_status: status,
      video_url: video?.url || null,
      cover_url: video?.cover_image_url || null,
      duration:  video?.duration || null,
      error:     task?.task_status_msg || null
    };

    /* If succeeded, fetch video bytes and return b64 for reliable download */
    if (normalized.status === 'succeeded' && normalized.video_url) {
      try {
        const vr  = await fetch(normalized.video_url);
        const buf = await vr.buffer();
        normalized.video_b64 = buf.toString('base64');
      } catch (e) { /* URL download only as fallback */ }
    }

    res.json(normalized);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Image task poller ── */
async function pollKlingImageTask(taskId, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    try {
      const token = makeKlingToken();
      const r     = await fetch('https://api.klingai.com/v1/images/generations/' + taskId, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) continue;
      const data   = await r.json();
      const task   = data?.data;
      const status = task?.task_status;
      console.log('[Kling Poll] ' + taskId + ' -> ' + status);
      if (status === 'succeed') return { images: task?.task_result?.images || [] };
      if (status === 'failed')  return { error: task?.task_status_msg || 'Failed' };
    } catch (e) { console.error('[Kling Poll]', e.message); }
  }
  return null;
}


app.listen(PORT, () => console.log('Backend running on port ' + PORT));

/* Append placeholder so the file is valid until we rewrite */
