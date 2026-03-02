const express = require('express');
const path = require('path');
const cors = require('cors');
const https = require('https');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000; 


const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Simple file-based storage
const DB_FILE = 'users.json';
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveUsers(users) { fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2)); }
function getUser(email) {
    return loadUsers()[email] || { email, plan: 'free', credits: 3 };
}
function updateUser(email, data) {
    const users = loadUsers();
    users[email] = { ...getUser(email), ...data };
    saveUsers(users);
    return users[email];
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Call Google Gemini API
function callGemini(prompt) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.GEMINI_API_KEY;
        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 2000, temperature: 0.8 }
        });

        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) return reject(new Error(parsed.error.message));
                    const text = parsed.candidates[0].content.parts[0].text;
                    resolve(text);
                } catch(e) {
                    reject(new Error('Failed to parse Gemini response'));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Generate LinkedIn Post
app.post('/api/generate-linkedin', async (req, res) => {
    try {
        const { topic, format, tone, length, emojis, email } = req.body;

        const user = getUser(email || 'guest');
        if (user.plan === 'free' && user.credits <= 0) {
            return res.json({ success: false, error: 'No credits left. Please upgrade!' });
        }

        const formats = {
            story: 'Write as a personal story with a hook, tension, and lesson.',
            howto: 'Write as a step-by-step how-to guide.',
            list: 'Write as a list of tips or insights.',
            contrarian: 'Write as a contrarian/unpopular opinion that challenges common beliefs.',
            question: 'Write as a thought-provoking question to spark discussion.'
        };
        const lengths = { short: '100-150 words', medium: '150-250 words', long: '250-400 words' };

        const prompt = `You are a viral LinkedIn content expert. Create an engaging LinkedIn post.

TOPIC: ${topic}
FORMAT: ${formats[format] || formats.story}
TONE: ${tone}
LENGTH: ${lengths[length] || lengths.medium}
EMOJIS: ${emojis ? 'Use 2-4 relevant emojis' : 'No emojis'}

RULES:
- Start with a strong hook that stops scrolling
- Short paragraphs (1-2 sentences max)
- Add line breaks for readability
- End with a question or call-to-action
- Be conversational and authentic
- No hashtags unless specifically asked

Generate ONLY the LinkedIn post, nothing else:`;

        const content = await callGemini(prompt);

        if (user.plan === 'free' && email) {
            updateUser(email, { credits: user.credits - 1 });
        }

        res.json({
            success: true,
            content: content.trim(),
            creditsRemaining: user.plan === 'free' ? user.credits - 1 : 999
        });

    } catch (error) {
        console.error('Generation error:', error.message);
        res.status(500).json({ success: false, error: 'AI generation failed: ' + error.message });
    }
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, plan, email } = req.body;
        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: process.env.RAZORPAY_CURRENCY || 'INR',
            receipt: `rcpt_${Date.now()}`,
            notes: { email, plan }
        });
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, email, plan } = req.body;
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign).digest('hex');
        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ success: false, message: 'Invalid signature' });
        }
        const credits = plan === 'starter' ? 50 : 999999;
        updateUser(email, { plan, credits, lastPayment: Date.now() });
        res.json({ success: true, message: 'Payment verified!', plan, credits });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/user/:email', (req, res) => {
    res.json({ success: true, user: getUser(req.params.email) });
});
app.get('/', (req, res) => {
     res.sendFile(path.join(__dirname,'landing.html'));
     });


app.listen(PORT, () => {
    console.log('\n✅ LinkedIn Generator is RUNNING on port ${PORT}');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📝 Landing Page : /landing.html`);
    console.log(`⚡ App          : /app.html`);
    console.log(`💳 Payment Page : /payment.html`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🤖 Using: Google Gemini AI (FREE)');
    console.log('💰 Payments: Razorpay\n');
});
