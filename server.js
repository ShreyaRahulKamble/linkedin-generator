const express = require('express');
const path = require('path');
const cors = require('cors');
const https = require('https');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Initialize Firebase Admin
// You'll need to download service account key from Firebase Console
// Settings -> Service Accounts -> Generate New Private Key
let firebaseInitialized = false;
try {
    const serviceAccount = require('./firebase-admin-key.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
    console.error('❌ Firebase Admin initialization failed:', error.message);
    console.log('Make sure firebase-admin-key.json exists in the project root');
    console.log('To get it: Firebase Console → Project Settings → Service Accounts → Generate New Private Key');
}

const db = admin.firestore();

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Helper function to get user data
async function getUserData(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return null;
        }
        const data = userDoc.data();
        // Ensure plan has a default value
        if (!data.plan) {
            console.log(`⚠️ User ${userId} has no plan field. Defaulting to 'free'`);
            data.plan = 'free';
        }
        return data;
    } catch (error) {
        console.error('Error getting user data:', error);
        return null;
    }
}

// Helper function to update user credits
async function updateUserCredits(userId, credits) {
    try {
        await db.collection('users').doc(userId).update({ credits });
        console.log(`✅ Credits updated for user ${userId}: ${credits}`);
        return true;
    } catch (error) {
        console.error('❌ Error updating credits:', error);
        throw error; // Throw so endpoint knows it failed
    }
}

// Call Google Gemini API with retry logic
async function callGemini(prompt, retries = 3, delay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
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
                            if (parsed.error) {
                                const errorMsg = parsed.error.message;
                                // Check if it's a rate limit or high demand error
                                if ((res.statusCode === 429 || errorMsg.includes('high demand') || errorMsg.includes('overloaded')) && attempt < retries) {
                                    reject(new Error(`RETRY:${errorMsg}`));
                                } else {
                                    reject(new Error(errorMsg));
                                }
                                return;
                            }
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
        } catch (error) {
            const isRetryable = error.message.startsWith('RETRY:');
            if (isRetryable && attempt < retries) {
                console.log(`Attempt ${attempt} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
                continue;
            }
            throw error;
        }
    }
}

// Generate LinkedIn Post
app.post('/api/generate-linkedin', async (req, res) => {
    console.log('\n📝 [GENERATE POST] Request received');
    console.log('   Firebase initialized:', firebaseInitialized);

    try {
        if (!firebaseInitialized) {
            console.log('❌ Firebase not initialized - request rejected');
            return res.status(500).json({
                success: false,
                error: 'Server error: Firebase not initialized. Check firebase-admin-key.json'
            });
        }

        const { topic, format, tone, length, emojis, userId } = req.body;
        console.log('📝 User ID:', userId);

        if (!userId) {
            console.log('❌ No userId provided');
            return res.json({ success: false, error: 'User ID required' });
        }

        // Get user data from Firebase
        console.log('🔍 Fetching user data from Firebase...');
        const userData = await getUserData(userId);
        if (!userData) {
            console.log('❌ User not found in database');
            return res.json({ success: false, error: 'User not found' });
        }

        console.log(`👤 User found. Plan: ${userData.plan}, Credits: ${userData.credits}`);

        // Check credits
        if (userData.plan === 'free' && userData.credits <= 0) {
            console.log('❌ User has no credits left');
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

        // Extract personalization data
        const { industry, role, niche, stylePreference } = userData;

        const prompt = `You are a viral LinkedIn content expert. Create an engaging LinkedIn post tailored for the user's profile.

USER PROFILE:
- Industry: ${industry || 'General/Diverse'}
- Role/Position: ${role || 'Professional'}
- Expertise/Niche: ${niche || 'General'}
- Preferred Style: ${stylePreference || 'Storytelling'}

TOPIC: ${topic}
FORMAT: ${formats[format] || formats.story}
TONE: ${tone}
LENGTH: ${lengths[length] || lengths.medium}
EMOJIS: ${emojis ? 'Use 2-4 relevant emojis' : 'No emojis'}

RULES:
- Create content that resonates with their industry and expertise
- Use language and examples relevant to their niche
- Maintain their preferred style throughout the post
- Start with a strong hook that stops scrolling
- Short paragraphs (1-2 sentences max)
- Add line breaks for readability
- End with a question or call-to-action
- Be conversational and authentic
- No hashtags unless specifically asked

Generate ONLY the LinkedIn post, nothing else:`;

        console.log('🤖 Calling Gemini API to generate post...');
        const content = await callGemini(prompt);
        console.log('✅ Post generated successfully');

        // Update credits based on plan - THIS MUST SUCCEED
        let updatedCredits = userData.credits;
        if (userData.plan === 'free' || userData.plan === 'starter' || userData.plan === 'pro') {
            updatedCredits = userData.credits - 1;
            try {
                console.log(`💾 Updating database: ${userData.plan} user credits ${userData.credits} → ${updatedCredits}`);
                await updateUserCredits(userId, updatedCredits);
                console.log(`✅ SUCCESS: Decremented ${userData.plan} user credits from ${userData.credits} to ${updatedCredits}`);
            } catch (error) {
                console.error(`❌ CRITICAL: Failed to decrement credits:`, error.message);
                // Return error - don't let request succeed if we can't update database
                return res.status(500).json({
                    success: false,
                    error: 'Failed to update credits in database. Please try again.'
                });
            }
        }

        console.log('📤 Sending response to client...');
        res.json({
            success: true,
            content: content.trim(),
            creditsRemaining: updatedCredits
        });
        console.log(`✅ [COMPLETE] Post generated and credits updated. New balance: ${updatedCredits}\n`);

    } catch (error) {
        console.error(`❌ [ERROR] Generation error:`, error.message);
        console.error(error);
        res.status(500).json({ success: false, error: 'AI generation failed: ' + error.message });
    }
});

// Update User Profile (Personalization)
app.post('/api/update-profile', async (req, res) => {
    try {
        const { userId, industry, role, niche, stylePreference } = req.body;

        if (!userId) {
            return res.json({ success: false, error: 'User ID required' });
        }

        // Update user profile in Firestore
        const profileData = {
            industry: industry || null,
            role: role || null,
            niche: niche || null,
            stylePreference: stylePreference || null
        };

        await db.collection('users').doc(userId).update(profileData);

        res.json({
            success: true,
            message: 'Profile updated successfully',
            data: profileData
        });
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ success: false, error: 'Failed to update profile: ' + error.message });
    }
});


// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { amount, plan, userId } = req.body;

        // Check if Razorpay credentials are configured
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            console.error('❌ Razorpay credentials not configured');
            return res.status(500).json({
                success: false,
                error: 'Payment gateway not configured. Please contact support.'
            });
        }

        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: process.env.RAZORPAY_CURRENCY || 'INR',
            receipt: `rcpt_${Date.now()}`,
            notes: { userId, plan }
        });
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        console.error('❌ Error creating order:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to initiate payment. ' + error.message
        });
    }
});

// Verify Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, plan } = req.body;
        const sign = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSign = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(sign).digest('hex');
        
        if (razorpay_signature !== expectedSign) {
            return res.status(400).json({ success: false, message: 'Invalid signature' });
        }
        
        // Update user plan in Firebase
        let credits;
        if (plan === 'starter') {
            credits = 50;
        } else if (plan === 'pro') {
            credits = 999;
        } else {
            credits = 3; // fallback to free
        }

        await db.collection('users').doc(userId).update({
            plan: plan,
            credits: credits,
            lastPayment: new Date().toISOString()
        });

        res.json({ success: true, message: 'Payment verified!', plan, credits });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
app.get('/api/user/:email', (req, res) => {
    res.json({ success: true, user: getUser(req.params.email) });
});

// Debug endpoint to check Firebase health
app.get('/api/health', async (req, res) => {
    if (!firebaseInitialized) {
        return res.status(500).json({
            status: 'error',
            firebase: 'NOT_INITIALIZED',
            message: 'Firebase Admin not initialized - firebase-admin-key.json missing or invalid',
            solution: 'Upload firebase-admin-key.json file and restart server'
        });
    }

    try {
        // Try to read a test document
        const usersRef = db.collection('users');
        const snapshot = await usersRef.limit(1).get();

        return res.json({
            status: 'ok',
            firebase: 'CONNECTED',
            message: 'Firebase is working correctly',
            users_in_database: snapshot.size > 0 ? 'yes' : 'no'
        });
    } catch (error) {
        return res.status(500).json({
            status: 'error',
            firebase: 'CONNECTION_FAILED',
            message: error.message,
            solution: 'Check firebase-admin-key.json credentials'
        });
    }
});

// Debug endpoint to test credit update
app.get('/api/test-credits/:userId', async (req, res) => {
    if (!firebaseInitialized) {
        return res.status(500).json({
            status: 'error',
            message: 'Firebase not initialized'
        });
    }

    try {
        const userData = await getUserData(req.params.userId);
        if (!userData) {
            return res.json({
                status: 'error',
                message: 'User not found'
            });
        }

        const currentCredits = userData.credits;
        const testCredits = currentCredits - 1;

        // Try to update to test value
        await updateUserCredits(req.params.userId, testCredits);

        // Verify it was updated
        const updated = await getUserData(req.params.userId);

        res.json({
            status: 'ok',
            original_credits: currentCredits,
            test_update: testCredits,
            verified_in_database: updated.credits,
            update_successful: updated.credits === testCredits
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
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
    console.log('💰 Payments: Razorpay');
    console.log('🔥 Database: Firebase Firestore\n');
});
