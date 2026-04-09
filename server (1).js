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
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Instagram AI Backend running' }));

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
    content.push({ type: 'text', text: `${hasImg ? `Analyze the ${images.length} product image(s) (${images.map(i=>i.label).join(', ')}). Base content on what you see.\n\n` : ''}Create a ${type_label} about "${topic}". Tone: ${tone}. ${hashtag_instruction}.\nReturn ONLY valid JSON: {"hook":"...","caption":"...","hashtags":["..."],"visual_tip":"...","cta":"...","best_time":"..."${hasImg?',"image_analysis":"..."':''}}` });

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
   BACKGROUND REMOVAL
══════════════════════════════════════════ */
app.post('/remove-bg', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    if (!process.env.OPENAI_API_KEY) return res.json({ image, removed: false });

    const imgBuffer  = Buffer.from(image, 'base64');
    /* White mask — tells DALL-E to edit the entire image */
    const maskBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAABAAAAAQACAIAAADwf7zUAAAAKklEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAeAMBxAABIABHAAAAAElFTkSuQmCC',
      'base64'
    );

    const form = new FormData();
    form.append('image', imgBuffer, { filename: 'product.png', contentType: 'image/png' });
    form.append('mask',  maskBuffer, { filename: 'mask.png',   contentType: 'image/png' });
    form.append('prompt', 'Remove background completely. Product only on transparent background with clean edges.');
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('response_format', 'b64_json');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form
    });

    if (!r.ok) { console.error('BG removal failed:', await r.text()); return res.json({ image, removed: false }); }
    const d = await r.json();
    res.json({ image: d.data[0].b64_json, removed: true });
  } catch (err) { console.error(err); res.json({ image: req.body.image, removed: false }); }
});

/* ══════════════════════════════════════════
   IMAGE EDITING — HD variations
══════════════════════════════════════════ */
app.post('/edit-image', async (req, res) => {
  try {
    const { image, theme, objects, mood, style, index = 0 } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set in environment variables' });

    const objText  = objects ? ` Include: ${objects}.` : '';
    const prompt   = `Ultra high quality commercial product photography. A probiotic fizzy beverage placed in ${theme}. ${mood}.${objText} Style: ${style}. Product sharp, prominent, professional lighting. 8K resolution, no text overlays.`;

    /* Try image editing first (uses uploaded product) */
    const form = new FormData();
    form.append('image', Buffer.from(image, 'base64'), { filename: 'product.png', contentType: 'image/png' });
    form.append('prompt', prompt);
    form.append('n', '1');
    form.append('size', '1024x1024');
    form.append('response_format', 'url');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      body: form
    });

    if (r.ok) {
      const d = await r.json();
      return res.json({ url: d.data[0].url, index });
    }

    /* Fallback — DALL-E 3 generation (HD quality) */
    console.log('Image edit failed, using DALL-E 3 generation...');
    const r2 = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', quality: 'hd', response_format: 'url' })
    });
    if (!r2.ok) { const e = await r2.text(); return res.status(500).json({ error: 'Generation failed', details: e }); }
    const d2 = await r2.json();
    res.json({ url: d2.data[0].url, index, fallback: true });

  } catch (err) { console.error('Edit error:', err); res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════
   PROXY IMAGE — for downloading DALL-E URLs
══════════════════════════════════════════ */
app.post('/proxy-image', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const r = await fetch(url);
    if (!r.ok) return res.status(404).json({ error: 'Image expired or not found' });
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
      const r = await fetch(img.url);
      if (!r.ok) return;
      const buf = await r.buffer();
      folder.file(`probiotic-fizzy-hd-${img.index}.png`, buf);
    }));

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    res.json({ zip: zipBuf.toString('base64') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
