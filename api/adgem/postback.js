export default async function handler(req, res) {
  const { user_id, amount, transaction_id } = req.query;

  if (!user_id || !amount || !transaction_id) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  // TODO: أضف النقاط للمستخدم في قاعدة البيانات هنا
  console.log("AdGem Postback:", { user_id, amount, transaction_id });

  return res.status(200).json({ success: true });
}
