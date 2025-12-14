const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// 🔥 1. مفتاح CPX
const CPX_APP_SECRET = process.env.CPX_APP_SECRET || 'test_secret';

// 🔥 2. تهيئة Firebase
let firestore = null;

function getFirestore() {
  if (!firestore) {
    try {
      // محاولة قراءة من Environment
      if (process.env.FIREBASE_KEY_JSON) {
        const credentials = JSON.parse(process.env.FIREBASE_KEY_JSON);
        firestore = new Firestore({
          projectId: credentials.project_id,
          credentials: credentials
        });
      } else {
        // قراءة من ملف محلي
        const keyPath = path.join(__dirname, '..', 'firebase-key.json');
        const credentials = require(keyPath);
        firestore = new Firestore({
          projectId: credentials.project_id,
          credentials: credentials
        });
      }
      console.log('✅ Firebase initialized');
    } catch (error) {
      console.error('❌ Firebase error:', error.message);
    }
  }
  return firestore;
}

// 🔥 3. معالجة CPX
app.get('/cpx', async (req, res) => {
  console.log('📨 CPX Postback:', req.query);
  
  try {
    const { status, trans_id, secure_hash } = req.query;
    
    if (!trans_id || !secure_hash) {
      return res.status(400).send('Missing parameters');
    }
    
    if (!CPX_APP_SECRET) {
      return res.status(500).send('Server error');
    }
    
    // التحقق من Hash
    const expectedHash = crypto
      .createHash('md5')
      .update(`${trans_id}-${CPX_APP_SECRET}`)
      .digest('hex');
    
    if (secure_hash !== expectedHash) {
      console.error('❌ Invalid hash');
      return res.status(403).send('Invalid hash');
    }
    
    console.log('✅ Valid hash - Transaction:', trans_id);
    
    if (status === "1") {
      // حفظ في Firebase
      const db = getFirestore();
      if (db) {
        await db.collection('cpx_transactions').doc(trans_id).set({
          status: 'completed',
          timestamp: new Date(),
          data: req.query
        });
      }
    }
    
    res.send('OK');
  } catch (error) {
    console.error('🔥 Error:', error);
    res.send('OK');
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

// 🔥 5. تحقق البيئة
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

// 🔥 6. تصدير للسيرفر
module.exports = app;