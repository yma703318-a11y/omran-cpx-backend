const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const path = require('path');

const app = express();

// 🔥 1. مفتاح CPX
const CPX_APP_SECRET = process.env.CPX_APP_SECRET || 'test_secret';

// 🔥 2. تهيئة Firebase
let firestore = null;

function getFirestore() {
  if (!firestore) {
    try {
      if (process.env.FIREBASE_KEY_JSON) {
        // من Environment (Vercel)
        const credentials = JSON.parse(process.env.FIREBASE_KEY_JSON);
        firestore = new Firestore({
          projectId: credentials.project_id,
          credentials
        });
      } else {
        // من ملف محلي (تطوير فقط)
        const keyPath = path.join(__dirname, '..', 'firebase-key.json');
        const credentials = require(keyPath);
        firestore = new Firestore({
          projectId: credentials.project_id,
          credentials
        });
      }
      console.log('✅ Firebase initialized');
    } catch (error) {
      console.error('❌ Firebase init error:', error.message);
    }
  }
  return firestore;
}

// 🔥 3. استقبال Postback من CPX
app.get('/cpx', async (req, res) => {
  console.log('📨 CPX Postback:', req.query);

  try {
    const { status, trans_id } = req.query;
    const receivedHash = req.query.hash || req.query.secure_hash;

    // 🔴 تحقق أساسي
    if (!trans_id || !receivedHash) {
      console.error('❌ Missing parameters', { trans_id, receivedHash });
      return res.status(400).send('Missing parameters');
    }

    if (!CPX_APP_SECRET) {
      return res.status(500).send('Server error');
    }

    // 🔐 حساب الهاش
    const expectedHash = crypto
      .createHash('md5')
      .update(`${trans_id}-${CPX_APP_SECRET}`)
      .digest('hex')
      .toLowerCase();

    if (receivedHash.toLowerCase() !== expectedHash) {
      console.error('❌ Invalid hash', {
        received: receivedHash,
        expected: expectedHash
      });
      return res.status(403).send('Invalid hash');
    }

    console.log('✅ Valid CPX transaction:', trans_id);

    // 💾 حفظ المعاملة
    if (status === '1') {
      const db = getFirestore();
      if (db) {
        await db.collection('cpx_transactions').doc(trans_id).set({
          status: 'completed',
          timestamp: new Date(),
          data: req.query
        }, { merge: true });
      }
    }

    // ⚠️ مهم جدًا: CPX يتطلب OK فقط
    return res.send('OK');

  } catch (error) {
    console.error('🔥 CPX handler error:', error);
    return res.send('OK'); // لا تُرجع خطأ حتى لا يعيد CPX الإرسال
  }
});

// 🔥 4. صفحة رئيسية
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Omran CPX Backend</title></head>
    <body>
      <h1>🚀 Omran CPX Backend is Running!</h1>
      <p>✅ Server is ready to receive CPX postbacks</p>
      <p>📅 ${new Date().toLocaleString()}</p>
      <p>🔗 <a href="/cpx">CPX Endpoint</a></p>
    </body>
    </html>
  `);
});

// 🔥 5. فحص البيئة
app.get('/env-check', (req, res) => {
  res.json({
    status: 'OK',
    environment: {
      CPX_APP_SECRET: process.env.CPX_APP_SECRET ? '✅ Set' : '❌ Missing',
      FIREBASE_KEY_JSON: process.env.FIREBASE_KEY_JSON ? '✅ Set' : '❌ Missing',
      NODE_ENV: process.env.NODE_ENV || 'development'
    }
  });
});

// 🔥 6. تصدير التطبيق لـ Vercel
module.exports = app;
