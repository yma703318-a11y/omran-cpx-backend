const express = require('express');
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// 🔥 1. إعداد Firebase
const firestore = new Firestore({
  projectId: 'omran-app-123',
  credentials: require('./firebase-key.json') // سننشئ هذا الملف
});

// 🔥 2. مفتاح CPX السري (خذته من Dashboard)
const CPX_APP_SECRET = "IW8ZVWr7kcUsMhGYOyBPjZERNwqcWtHw"; // ⚠️ غير هذا!

// 🔥 3. معالجة طلبات CPX
app.get('/cpx', async (req, res) => {
  try {
    console.log('📨 استلام طلب من CPX:', req.query);
    
    const { status, trans_id, user_id, amount_local, secure_hash } = req.query;
    
    // التحقق من البيانات الأساسية
    if (!trans_id || !user_id || !secure_hash) {
      console.error('❌ بيانات ناقصة');
      return res.status(400).send('Missing parameters');
    }
    
    // التحقق من الهاش
    const expectedHash = crypto
      .createHash('md5')
      .update(`${trans_id}-${CPX_APP_SECRET}`)
      .digest('hex');
    
    if (secure_hash !== expectedHash) {
      console.error('❌ هاش غير صحيح');
      return res.status(403).send('Invalid hash');
    }
    
    console.log('✅ هاش صحيح:', trans_id);
    
    // إذا اكتملت المهمة
    if (status === "1") {
      const dollars = parseFloat(amount_local) || 0;
      const points = Math.floor(dollars * 75);
      
      console.log(`💰 ${dollars}$ = ${points} نقطة`);
      
      // التحقق من عدم التكرار
      const txRef = firestore.collection('cpx_transactions').doc(trans_id);
      const exists = await txRef.get();
      
      if (exists.exists) {
        console.log('⚠️ معاملة مكررة');
        return res.send('OK');
      }
      
      // تحديث نقاط المستخدم
      const userRef = firestore.collection('users').doc(user_id);
      await userRef.set({
        points: Firestore.FieldValue.increment(points),
        lastActive: new Date()
      }, { merge: true });
      
      // حفظ المعاملة
      await txRef.set({
        userId: user_id,
        dollars: dollars,
        points: points,
        status: 'completed',
        timestamp: new Date()
      });
      
      console.log(`✅ تم إضافة ${points} نقطة للمستخدم ${user_id}`);
    }
    
    // الرد لـ CPX
    res.send('OK');
    
  } catch (error) {
    console.error('🔥 خطأ:', error);
    res.status(500).send('Server Error');
  }
});

// 🔥 4. صفحة تجريبية
app.get('/', (req, res) => {
  res.send('🚀 Omran CPX Backend is Running!');
});

// 🔥 5. تشغيل السيرفر
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});