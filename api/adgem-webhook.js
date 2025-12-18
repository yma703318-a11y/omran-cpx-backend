// api/adgem-webhook.js
const { Firestore } = require('@google-cloud/firestore');
const crypto = require('crypto');

// 🔥 تهيئة Firebase
const firestore = new Firestore({
  projectId: process.env.FIREBASE_PROJECT_ID,
  credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
});

// 🔑 مفتاح AdGem Webhook
const ADGEM_WEBHOOK_SECRET = process.env.ADGEM_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  try {
    // 1. التحقق من طريقة الطلب
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // 2. التحقق من السرية (إذا كانت موجودة)
    if (ADGEM_WEBHOOK_SECRET) {
      const signature = req.headers['x-adgem-signature'];
      if (!signature) {
        console.warn('⚠️ No signature in AdGem webhook');
      } else {
        // التحقق من التوقيع
        const expectedSignature = crypto
          .createHmac('sha256', ADGEM_WEBHOOK_SECRET)
          .update(JSON.stringify(req.body))
          .digest('hex');
          
        if (signature !== expectedSignature) {
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }
    }
    
    // 3. استخراج البيانات
    const {
      event,
      player_id,
      offer_id,
      payout,
      conversion_id,
      trans_id,
      timestamp
    } = req.body;
    
    console.log('📨 AdGem Webhook received:', {
      event,
      player_id,
      offer_id,
      payout,
      conversion_id
    });
    
    // 4. التحقق من عدم التكرار
    if (conversion_id || trans_id) {
      const transactionId = conversion_id || trans_id;
      const existing = await firestore
        .collection('adgem_conversions')
        .where('conversion_id', '==', transactionId)
        .limit(1)
        .get();
      
      if (!existing.empty) {
        console.log('⚠️ Duplicate conversion detected:', transactionId);
        return res.status(200).json({ status: 'duplicate' });
      }
    }
    
    // 5. معالجة الحدث
    let result;
    switch (event) {
      case 'conversion':
        result = await handleConversion(req.body);
        break;
        
      case 'reversal':
        result = await handleReversal(req.body);
        break;
        
      case 'test':
        result = { status: 'test_received' };
        break;
        
      default:
        console.log('Unknown event type:', event);
        result = { status: 'ignored' };
    }
    
    // 6. الرد الناجح
    res.status(200).json({
      success: true,
      ...result,
      received_at: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('🔥 AdGem webhook error:', error);
    
    // ⚠️ مهم: لا نرجع خطأ للـ AdGem
    res.status(200).json({
      success: false,
      error: error.message,
      note: 'Error logged but request accepted'
    });
  }
};

// 💰 معالجة التحويل
async function handleConversion(data) {
  const {
    player_id,
    offer_id,
    payout,
    conversion_id,
    user_id
  } = data;
  
  // 1. البحث عن المستخدم
  const userQuery = await firestore
    .collection('adgem_users')
    .where('player_id', '==', player_id)
    .limit(1)
    .get();
  
  if (userQuery.empty) {
    console.log('❌ User not found for player_id:', player_id);
    
    // محاولة البحث بواسطة user_id إذا وجد
    if (user_id) {
      const userById = await firestore
        .collection('adgem_users')
        .doc(user_id)
        .get();
      
      if (userById.exists) {
        await processUserConversion(userById.id, data);
      }
    }
    
    return { status: 'user_not_found' };
  }
  
  // 2. معالجة التحويل
  const userId = userQuery.docs[0].id;
  await processUserConversion(userId, data);
  
  return { 
    status: 'processed',
    user_id: userId,
    points: Math.floor(payout * 100)
  };
}

async function processUserConversion(userId, data) {
  const db = firestore;
  const {
    offer_id,
    payout,
    conversion_id
  } = data;
  
  const pointsEarned = Math.floor(payout * 100);
  const timestamp = new Date();
  
  // 🔥 Batch write لضمان الاتساق
  const batch = db.batch();
  
  // 1. تحديث نقاط المستخدم
  const userRef = db.collection('users').doc(userId);
  batch.update(userRef, {
    'points': firestore.FieldValue.increment(pointsEarned),
    'totalAdGemEarned': firestore.FieldValue.increment(payout),
    'lastAdGemConversion': timestamp
  });
  
  // 2. تحديث إحصائيات AdGem
  const adgemUserRef = db.collection('adgem_users').doc(userId);
  batch.update(adgemUserRef, {
    'total_earnings': firestore.FieldValue.increment(payout),
    'total_conversions': firestore.FieldValue.increment(1),
    'last_conversion': timestamp
  });
  
  // 3. تسجيل التحويل
  const conversionRef = db.collection('adgem_conversions').doc(conversion_id || `conv_${Date.now()}`);
  batch.set(conversionRef, {
    user_id: userId,
    player_id: data.player_id,
    offer_id: offer_id,
    conversion_id: conversion_id,
    payout_amount: payout,
    points_earned: pointsEarned,
    status: 'completed',
    converted_at: timestamp,
    raw_data: data
  });
  
  // 4. تسجيل حركة النقاط
  const transactionRef = db.collection('point_transactions').doc();
  batch.set(transactionRef, {
    user_id: userId,
    amount: pointsEarned,
    type: 'adgem_conversion',
    description: `AdGem: ${data.offer_name || 'Offer'}`,
    source: 'adgem',
    timestamp: timestamp,
    conversion_id: conversion_id
  });
  
  await batch.commit();
  
  console.log('💰 AdGem conversion processed:', {
    userId,
    pointsEarned,
    conversion_id
  });
}

// ↩️ معالجة الإلغاء
async function handleReversal(data) {
  const { conversion_id, player_id } = data;
  
  // البحث عن التحويل الأصلي
  const conversionQuery = await firestore
    .collection('adgem_conversions')
    .where('conversion_id', '==', conversion_id)
    .limit(1)
    .get();
  
  if (conversionQuery.empty) {
    console.log('⚠️ Original conversion not found for reversal:', conversion_id);
    return { status: 'original_not_found' };
  }
  
  const conversionDoc = conversionQuery.docs[0];
  const conversionData = conversionDoc.data();
  const userId = conversionData.user_id;
  const pointsToDeduct = conversionData.points_earned || 0;
  const payout = conversionData.payout_amount || 0;
  
  // تحديث التحويل
  await conversionDoc.ref.update({
    status: 'reversed',
    reversed_at: new Date(),
    reversal_data: data
  });
  
  // خصم النقاط
  if (pointsToDeduct > 0 && userId) {
    await firestore.collection('users').doc(userId).update({
      'points': firestore.FieldValue.increment(-pointsToDeduct),
      'totalAdGemEarned': firestore.FieldValue.increment(-payout)
    });
    
    // تسجيل عملية الإلغاء
    await firestore.collection('point_transactions').add({
      user_id: userId,
      amount: -pointsToDeduct,
      type: 'adgem_reversal',
      description: 'AdGem: Reversal',
      source: 'adgem',
      timestamp: new Date(),
      conversion_id: conversion_id
    });
  }
  
  console.log('↩️ AdGem reversal processed:', conversion_id);
  return { status: 'reversed', points_deducted: pointsToDeduct };
}