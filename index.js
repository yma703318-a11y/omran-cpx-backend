const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// 🔥 1. مفتاح CPX من Environment Variable
const CPX_APP_SECRET = process.env.CPX_APP_SECRET;

// 🔥 2. تهيئة Firebase من Environment Variable (مهم!)
let firestore = null;

function getFirestore() {
  if (!firestore) {
    try {
      // قراءة Firebase Key من ملف
      const keyPath = path.join(__dirname, 'firebase-key.json');
      const credentials = require(keyPath);
      
      firestore = new Firestore({
        projectId: credentials.project_id,
        credentials: credentials
      });
      
      console.log('✅ Firebase initialized successfully');
    } catch (error) {
      console.error('❌ Firebase initialization error:', error.message);
      // استمر حتى بدون Firebase
    }
  }
  return firestore;
}

// 🔥 3. معالجة طلبات CPX
app.get('/cpx', async (req, res) => {
  console.log('📨 استلام Postback من CPX:', req.query);
  
  try {
    // استقبال جميع المعاملات (CPX يرسل أكثر من هذه)
    const { 
      status, 
      trans_id, 
      user_id, 
      amount_local, 
      secure_hash,
      subid_1,
      subid_2,
      type 
    } = req.query;
    
    // التحقق من البيانات الأساسية
    if (!trans_id || !secure_hash) {
      console.error('❌ بيانات ناقصة:', { trans_id, user_id, secure_hash });
      return res.status(400).send('Missing required parameters');
    }
    
    // التحقق من الـ Hash
    const expectedHash = crypto
      .createHash('md5')
      .update(`${trans_id}-${CPX_APP_SECRET}`)
      .digest('hex');
    
    if (secure_hash !== expectedHash) {
      console.error('❌ هاش غير صحيح', {
        received: secure_hash,
        expected: expectedHash,
        trans_id: trans_id
      });
      return res.status(403).send('Invalid hash');
    }
    
    console.log('✅ هاش صحيح - المعاملة:', trans_id);
    
    // إذا اكتملت المهمة
    if (status === "1") {
      const dollars = parseFloat(amount_local) || 0;
      const points = Math.floor(dollars * 75);
      
      console.log(`💰 ${dollars}$ = ${points} نقطة للمستخدم: ${user_id}`);
      
      try {
        // الحصول على Firestore
        const db = getFirestore();
        
        // التحقق من عدم تكرار المعاملة
        const txRef = db.collection('cpx_transactions').doc(trans_id);
        const exists = await txRef.get();
        
        if (exists.exists) {
          console.log('⚠️ معاملة مكررة:', trans_id);
          return res.send('OK');
        }
        
        // تحديث نقاط المستخدم
        const userRef = db.collection('users').doc(user_id);
        await userRef.set({
          points: Firestore.FieldValue.increment(points),
          lastActive: new Date(),
          totalEarned: Firestore.FieldValue.increment(points)
        }, { merge: true });
        
        // حفظ المعاملة
        await txRef.set({
          userId: user_id,
          dollars: dollars,
          points: points,
          status: 'completed',
          taskId: subid_1 || '',
          type: type || 'complete',
          timestamp: new Date(),
          cpxData: req.query // حفظ كل البيانات للإرجاع
        });
        
        console.log(`✅ تم إضافة ${points} نقطة للمستخدم ${user_id}`);
        
      } catch (firebaseError) {
        console.error('🔥 خطأ في Firebase:', firebaseError.message);
        // نرسل OK حتى لو فشل Firebase، CPX لن يعيد المحاولة
      }
    } 
    // إذا ألغيت المهمة (احتيال)
    else if (status === "2") {
      console.log('❌ معاملة ملغية (احتيال):', trans_id);
      
      try {
        const db = getFirestore();
        await db.collection('cpx_transactions').doc(trans_id).set({
          status: 'fraud',
          timestamp: new Date(),
          markedFraudAt: new Date()
        }, { merge: true });
      } catch (error) {
        console.error('Error marking fraud:', error);
      }
    }
    
    // الرد لـ CPX (مهم جداً)
    res.send('OK');
    
  } catch (error) {
    console.error('🔥 خطأ عام في معالجة Postback:', error);
    // ❗ مهم: نرسل OK دائماً حتى لو كان هناك خطأ
    // لأن CPX إذا لم يتلقى OK سيعتبر المحاولة فاشلة
    res.send('OK');
  }
});

// 🔥 4. صفحة الرئيسية للتحقق
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Omran CPX Backend</title>
      <style>
        body { font-family: Arial; padding: 40px; text-align: center; }
        .success { color: green; font-size: 24px; }
        .info { color: #666; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="success">🚀 Omran CPX Backend is Running!</div>
      <div class="info">
        <p>✅ Server is ready to receive CPX postbacks</p>
        <p>📅 ${new Date().toLocaleString()}</p>
        <p>🔗 Endpoint: /cpx</p>
      </div>
    </body>
    </html>
  `);
});

// 🔥 5. صفحة للتحقق من البيئة
app.get('/env-check', (req, res) => {
  const hasCpxSecret = !!process.env.CPX_APP_SECRET;
  const hasFirebaseKey = !!process.env.FIREBASE_KEY_JSON;
  
  res.json({
    status: 'OK',
    timestamp: new Date(),
    environment: {
      CPX_APP_SECRET: hasCpxSecret ? '✅ Set' : '❌ Missing',
      FIREBASE_KEY_JSON: hasFirebaseKey ? '✅ Set' : '❌ Missing',
      PORT: process.env.PORT || '3000 (default)'
    },
    endpoints: {
      home: '/',
      cpx: '/cpx',
      health: '/env-check'
    }
  });
});

// 🔥 6. تشغيل السيرفر
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
  console.log(`✅ Environment check: http://localhost:${port}/env-check`);
});