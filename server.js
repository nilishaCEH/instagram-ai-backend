const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

/* ── Middleware ── */
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '20mb' }));

/* ── Health check ── */
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Instagram AI Backend is running' });
});

/* ── Generate content endpoint ── */
app.post('/generate', async (req, res) => {
  try {
    const {
      type_label = 'Instagram feed post',
      topic = 'probiotic fizzy beverages',
      tone = 'fun & energetic',
      hashtag_instruction = '20-25 mixed hashtags',
      images = []
    } = req.body;

    /* Build message content — images first, then text prompt */
    const messageContent = [];

    /* Add real product images if provided */
    images.forEach(img => {
      if (img.data) {
        messageContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mtype || 'image/jpeg',
            data: img.data
          }
        });
      }
    });

    /* Add text prompt */
    const hasImages = images.length > 0;
    messageContent.push({
      type: 'text',
      text: `${hasImages
        ? `Carefully analyze the ${images.length} product image(s) provided (labeled: ${images.map(i => i.label).join(', ')}). Base all content specifically on what you actually see in these photos — packaging colors, bottle/can shape, branding, lifestyle context.\n\n`
        : ''}Create a ${type_label} about: "${topic}". Tone: ${tone}. ${hashtag_instruction}.

Return ONLY a valid JSON object, no markdown, no extra text:
{
  "hook": "scroll-stopping opening line under 10 words",
  "caption": "full Instagram caption with emojis and strong CTA",
  "hashtags": ["array", "of", "hashtags"],
  "visual_tip": "specific tip for shooting this product for Instagram",
  ${hasImages ? '"image_analysis": "2-3 sentences on what you see in the photos",' : ''}
  "cta": "the call-to-action used",
  "best_time": "best time to post this content type"
}`
    });

    /* Call Claude API */
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: 'You are an expert Instagram content creator for a probiotic fizzy beverages brand — healthy, gut-friendly carbonated drinks with live cultures and natural flavors. Audience: health-conscious millennials and Gen Z. Always return ONLY valid JSON with no markdown fences or extra text.',
        messages: [{ role: 'user', content: messageContent }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Claude API error:', errText);
      return res.status(response.status).json({ error: 'Claude API error', details: errText });
    }

    const data = await response.json();
    const rawText = data.content.map(c => c.text || '').join('');
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    res.json(parsed);

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Instagram AI Backend running on port ${PORT}`);
});
