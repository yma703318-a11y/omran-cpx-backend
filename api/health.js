// api/health.js
const { Firestore } = require('@google-cloud/firestore');

module.exports = async (req, res) => {
  const checks = {
    server: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  };
  
  // تحقق من Firebase
  try {
    const db = new Firestore();
    await db.collection('health_check').doc('test').set({
      timestamp: new Date(),
      status: 'ok'
    });
    checks.firebase = 'connected';
  } catch (error) {
    checks.firebase = 'error: ' + error.message;
  }
  
  // تحقق من AdGem
  checks.adgem = {
    api_key: process.env.ADGEM_API_KEY ? 'set' : 'missing',
    app_id: process.env.ADGEM_APP_ID ? 'set' : 'missing'
  };
  
  res.status(200).json(checks);
};