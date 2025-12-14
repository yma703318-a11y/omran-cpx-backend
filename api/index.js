const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const path = require('path');

const app = express();

// 🔥 1. مفتاح CPX من Environment
const CPX_APP_SECRET = process.env.CPX_APP_SECRET;
if (!CPX_APP_SECRET) {
    console.error('❌ CPX_APP_SECRET missing in environment variables');
}

// 🔥 2. تهيئة Firebase مع cache
let firestore = null;
let firebaseInitialized = false;

function getFirestore() {
    if (!firebaseInitialized && !firestore) {
        try {
            if (process.env.FIREBASE_KEY_JSON) {
                const credentials = JSON.parse(process.env.FIREBASE_KEY_JSON);
                firestore = new Firestore({
                    projectId: credentials.project_id,
                    credentials
                });
                firebaseInitialized = true;
                console.log('✅ Firebase initialized from environment');
            } else {
                console.warn('⚠️ FIREBASE_KEY_JSON missing, Firebase disabled');
            }
        } catch (error) {
            console.error('❌ Firebase init error:', error.message);
        }
    }
    return firestore;
}

// 🔥 3. استقبال Postback من CPX - نسخة إنتاجية كاملة
app.get('/cpx', async (req, res) => {
    const startTime = Date.now();
    console.log('📨 CPX Postback received at:', new Date().toISOString());
    
    // 🛡️ Log آمن (بدون بيانات حساسة)
    const safeLog = { ...req.query };
    if (safeLog.hash) safeLog.hash = '***HIDDEN***';
    if (safeLog.secure_hash) safeLog.secure_hash = '***HIDDEN***';
    console.log('🔍 Safe query log:', safeLog);
    
    try {
        // 📥 استخراج البيانات
        const { 
            status, 
            trans_id, 
            user_id, 
            amount_local,
            subid_1,
            type,
            offer_id 
        } = req.query;
        
        // ⚠️ يقبل كلا الاسمين (hash للاختبار، secure_hash للإنتاج)
        const receivedHash = req.query.hash || req.query.secure_hash;
        
        // 🔴 1. تحقق أساسي
        if (!trans_id || !receivedHash) {
            console.error('❌ Missing required parameters:', {
                hasTransId: !!trans_id,
                hasHash: !!receivedHash,
                allParams: Object.keys(req.query)
            });
            return res.status(400).send('Missing required parameters');
        }
        
        if (!user_id) {
            console.warn('⚠️ Missing user_id, but continuing');
        }
        
        // 🔐 2. التحقق من الـ Hash
        if (!CPX_APP_SECRET) {
            console.error('❌ CRITICAL: CPX_APP_SECRET missing in environment');
            return res.status(500).send('Server configuration error');
        }
        
        const expectedHash = crypto
            .createHash('md5')
            .update(`${trans_id}-${CPX_APP_SECRET}`)
            .digest('hex')
            .toLowerCase();
        
        if (receivedHash.toLowerCase() !== expectedHash) {
            console.error('❌ SECURITY: Invalid hash detected', {
                transactionId: trans_id,
                receivedHash: receivedHash.substring(0, 8) + '...',
                expectedHash: expectedHash.substring(0, 8) + '...',
                ip: req.ip
            });
            return res.status(403).send('Invalid hash');
        }
        
        console.log('✅ Security check passed for transaction:', trans_id);
        
        // 🔥 3. معالجة Firebase
        const db = getFirestore();
        let firebaseSuccess = false;
        
        if (db) {
            try {
                // 🔒 3.1 منع المعاملات المكررة (ضروري للإنتاج)
                const transactionRef = db.collection('cpx_transactions').doc(trans_id);
                const existingTransaction = await transactionRef.get();
                
                if (existingTransaction.exists) {
                    const existingData = existingTransaction.data();
                    console.log('⚠️ Duplicate transaction detected:', {
                        transactionId: trans_id,
                        existingStatus: existingData.status,
                        existingTime: existingData.timestamp?.toDate?.() || 'N/A'
                    });
                    return res.send('OK'); // ⚠️ مهم: لا ترجع خطأ
                }
                
                // 📊 3.2 حساب النقاط
                let pointsEarned = 0;
                if (status === '1' && amount_local) {
                    const dollars = parseFloat(amount_local) || 0;
                    pointsEarned = Math.floor(dollars * 70000); // 1$ = 75 نقطة
                    
                    console.log('💰 Points calculation:', {
                        dollars: dollars,
                        points: pointsEarned,
                        rate: '70000 points per $1'
                    });
                }
                
                // 💾 3.3 حفظ المعاملة
                const transactionData = {
                    userId: user_id || 'unknown',
                    status: status === '1' ? 'completed' : 
                           status === '2' ? 'reversed' : 'pending',
                    amountLocal: parseFloat(amount_local) || 0,
                    pointsEarned: pointsEarned,
                    subId1: subid_1 || '',
                    taskType: type || 'unknown',
                    offerId: offer_id || '',
                    timestamp: new Date(),
                    cpxData: safeLog, // بيانات آمنة
                    processedAt: new Date(),
                    serverVersion: '1.0.0'
                };
                
                await transactionRef.set(transactionData);
                console.log('💾 Transaction saved to Firebase:', trans_id);
                
                // 👤 3.4 تحديث نقاط المستخدم (إذا اكتملت)
                if (status === '1' && pointsEarned > 0 && user_id) {
                    const userRef = db.collection('users').doc(user_id);
                    
                    try {
                        await userRef.set({
                            points: Firestore.FieldValue.increment(pointsEarned),
                            totalPointsEarned: Firestore.FieldValue.increment(pointsEarned),
                            lastCpxActivity: new Date(),
                            lastUpdated: new Date()
                        }, { merge: true });
                        
                        console.log('🎉 Points added to user:', {
                            userId: user_id,
                            pointsAdded: pointsEarned,
                            transactionId: trans_id
                        });
                        
                    } catch (userError) {
                        console.error('⚠️ User update failed:', userError.message);
                        // نستمر حتى لو فشل تحديث المستخدم
                    }
                }
                
                // ⚠️ 3.5 معالجة الإلغاء (status=2)
                if (status === '2') {
                    console.log('🔄 Processing reversal for transaction:', trans_id);
                    
                    // هنا يمكنك خصم النقاط إذا أردت
                    // await reversePoints(user_id, trans_id, pointsEarned);
                }
                
                firebaseSuccess = true;
                
            } catch (firebaseError) {
                console.error('🔥 Firebase operation failed:', firebaseError.message);
                // نستمر في الإجابة بـ OK حتى لو فشل Firebase
            }
        } else {
            console.warn('⚠️ Firebase not available, transaction logged only');
        }
        
        // 📈 4. إحصائيات الأداء
        const processingTime = Date.now() - startTime;
        console.log('📊 Performance stats:', {
            transactionId: trans_id,
            processingTime: `${processingTime}ms`,
            firebaseSuccess: firebaseSuccess,
            status: status
        });
        
        // ✅ 5. الرد النهائي (مهم جداً لـ CPX)
        return res.send('OK');
        
    } catch (error) {
        console.error('🔥 Unexpected error in CPX handler:', {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        
        // ⚠️ مهم جداً: دائماً نرجع OK حتى في حالة الخطأ
        // لأن CPX إذا لم يتلقى OK سيعيد المحاولة
        return res.send('OK');
    }
});

// 🔥 4. صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Omran CPX Backend</title>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
                       margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                       color: white; min-height: 100vh; }
                .container { max-width: 800px; margin: 0 auto; background: rgba(255,255,255,0.1); 
                            padding: 40px; border-radius: 20px; backdrop-filter: blur(10px); }
                h1 { font-size: 2.5em; margin-bottom: 20px; }
                .status { background: rgba(76, 175, 80, 0.2); padding: 15px; border-radius: 10px; margin: 20px 0; }
                .endpoints { margin-top: 30px; }
                .endpoint { background: rgba(255,255,255,0.1); padding: 15px; margin: 10px 0; border-radius: 10px; }
                code { background: rgba(0,0,0,0.3); padding: 5px 10px; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 Omran CPX Backend</h1>
                <div class="status">
                    <p>✅ <strong>Status:</strong> Running in ${process.env.NODE_ENV || 'development'} mode</p>
                    <p>🕐 <strong>Time:</strong> ${new Date().toLocaleString('ar-SA')}</p>
                    <p>🌐 <strong>Environment:</strong> ${process.env.VERCEL_ENV || 'production'}</p>
                </div>
                
                <div class="endpoints">
                    <h3>📡 Available Endpoints:</h3>
                    <div class="endpoint">
                        <strong>CPX Postback:</strong> <code>GET /cpx</code>
                        <p>Accepts: status, trans_id, user_id, amount_local, hash/secure_hash</p>
                    </div>
                    <div class="endpoint">
                        <strong>Health Check:</strong> <code>GET /health</code>
                        <p>Server status and environment info</p>
                    </div>
                    <div class="endpoint">
                        <strong>Environment:</strong> <code>GET /env-check</code>
                        <p>Check environment variables</p>
                    </div>
                </div>
                
                <div style="margin-top: 40px; font-size: 0.9em; opacity: 0.8;">
                    <p>🔒 <strong>Security:</strong> All CPX requests are validated with MD5 hash</p>
                    <p>⚡ <strong>Performance:</strong> Serverless function on Vercel</p>
                    <p>📊 <strong>Database:</strong> Google Cloud Firestore</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// 🔥 5. فحص البيئة المحسّن
app.get('/env-check', (req, res) => {
    const env = {
        CPX_APP_SECRET: process.env.CPX_APP_SECRET ? 
            `✅ Set (${process.env.CPX_APP_SECRET.length} chars)` : '❌ Missing',
        FIREBASE_KEY_JSON: process.env.FIREBASE_KEY_JSON ? 
            '✅ Set' : '❌ Missing',
        NODE_ENV: process.env.NODE_ENV || 'development',
        VERCEL_ENV: process.env.VERCEL_ENV || 'Not set',
        VERCEL_REGION: process.env.VERCEL_REGION || 'Unknown',
        PORT: process.env.PORT || '3000',
        TIMESTAMP: new Date().toISOString()
    };
    
    res.json({
        status: 'healthy',
        environment: env,
        system: {
            nodeVersion: process.version,
            platform: process.platform,
            uptime: process.uptime(),
            memory: process.memoryUsage()
        },
        endpoints: {
            cpx: '/cpx',
            home: '/',
            health: '/health',
            env: '/env-check'
        }
    });
});

// 🔥 6. Health check مبسّط
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'omran-cpx-backend',
        version: '1.0.0',
        uptime: process.uptime()
    });
});

// 🔥 7. 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Endpoint ${req.path} not found`,
        availableEndpoints: ['/', '/cpx', '/health', '/env-check']
    });
});

// 🔥 8. Error handler عام
app.use((err, req, res, next) => {
    console.error('🔥 Global error handler:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString()
    });
});

// 🔥 9. تصدير التطبيق لـ Vercel
module.exports = app;