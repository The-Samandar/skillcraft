// routes/payme.js — Payme Merchant API (JSON-RPC 2.0)
//
// ⚠️ ЗАПОЛНИ В .env:
//   PAYME_MERCHANT_ID, PAYME_SECRET_KEY, PAYME_TEST_KEY
//
// Документация: https://developer.help.paycom.uz/
// Callback URL (укажи в кабинете Payme):
//   https://api.yourdomain.uz/api/payments/payme/callback

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

function verifyAuth(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Basic ')) return false;
  const [login, pass] = Buffer.from(h.split(' ')[1], 'base64').toString().split(':');
  const mid  = process.env.PAYME_MERCHANT_ID;
  const key  = process.env.NODE_ENV === 'production' ? process.env.PAYME_SECRET_KEY : process.env.PAYME_TEST_KEY;
  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID') return true; // dev режим без ключей
  return login === mid && pass === key;
}

// GET /api/payments/payme/checkout-url?orderId=...
router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const mid = process.env.PAYME_MERCHANT_ID;
  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID')
    return res.status(500).json({ error: 'Payme не настроен. Укажи PAYME_MERCHANT_ID в .env' });

  const params = `m=${mid};ac.order_code=${order.order_code};a=${order.amount};l=ru`;
  const base   = process.env.NODE_ENV === 'production' ? 'https://checkout.paycom.uz' : 'https://test.paycom.uz';
  res.json({ checkout_url: `${base}/${Buffer.from(params).toString('base64')}` });
});

// POST /api/payments/payme/callback — все JSON-RPC методы
router.post('/callback', (req, res) => {
  if (!verifyAuth(req)) return res.json({ error: { code: -32504, message: 'Forbidden' }, id: req.body?.id });

  const { method, params, id } = req.body;
  console.log(`📥 Payme RPC: ${method}`);

  const handlers = { CheckPerformTransaction, CreateTransaction, PerformTransaction, CancelTransaction, CheckTransaction, GetStatement };
  if (handlers[method]) return handlers[method](params, id, res);
  res.json({ error: { code: -32601, message: 'Method not found' }, id });
});

function CheckPerformTransaction({ account, amount }, id, res) {
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(account?.order_code);
  if (!order) return res.json({ error: { code: -31050, message: { ru: 'Заказ не найден' } }, id });
  if (order.amount !== parseInt(amount)) return res.json({ error: { code: -31001, message: { ru: 'Неверная сумма' } }, id });
  res.json({ result: { allow: true }, id });
}

function CreateTransaction({ id: payme_id, time, amount, account }, id, res) {
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(account?.order_code);
  if (!order) return res.json({ error: { code: -31050, message: { ru: 'Заказ не найден' } }, id });
  if (order.amount !== parseInt(amount)) return res.json({ error: { code: -31001, message: { ru: 'Неверная сумма' } }, id });

  let pay = db.prepare("SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'").get(payme_id);
  if (pay) {
    if (pay.status === 'failed') return res.json({ error: { code: -31008, message: { ru: 'Отменена' } }, id });
    return res.json({ result: { create_time: new Date(pay.created_at).getTime(), transaction: pay.id, state: 1 }, id });
  }

  const pid = uuidv4();
  db.prepare("INSERT INTO payments (id,order_id,provider,provider_transaction_id,amount,raw_payload,status) VALUES (?,?,'payme',?,?,?,'pending')")
    .run(pid, order.id, payme_id, order.amount, JSON.stringify({ id: payme_id, time, amount, account }));
  res.json({ result: { create_time: time, transaction: pid, state: 1 }, id });
}

function PerformTransaction({ id: payme_id }, id, res) {
  const pay = db.prepare("SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'").get(payme_id);
  if (!pay) return res.json({ error: { code: -31003, message: { ru: 'Транзакция не найдена' } }, id });
  if (pay.status === 'success') return res.json({ result: { perform_time: new Date(pay.updated_at).getTime(), transaction: pay.id, state: 2 }, id });

  db.prepare("UPDATE payments SET status='success' WHERE id=?").run(pay.id);
  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(pay.order_id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(pay.order_id);
  grantCourseAccess(order.id, order.user_id);
  console.log(`✅ Payme paid: ${pay.order_id}`);
  res.json({ result: { perform_time: Date.now(), transaction: pay.id, state: 2 }, id });
}

function CancelTransaction({ id: payme_id }, id, res) {
  const pay = db.prepare("SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'").get(payme_id);
  if (!pay) return res.json({ error: { code: -31003, message: { ru: 'Транзакция не найдена' } }, id });
  db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(pay.id);
  db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(pay.order_id);
  db.prepare("UPDATE access_grants SET is_active=0 WHERE order_id=?").run(pay.order_id);
  res.json({ result: { cancel_time: Date.now(), transaction: pay.id, state: -1 }, id });
}

function CheckTransaction({ id: payme_id }, id, res) {
  const pay = db.prepare("SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'").get(payme_id);
  if (!pay) return res.json({ error: { code: -31003, message: { ru: 'Не найдена' } }, id });
  const s = { pending: 1, success: 2, failed: -1 };
  res.json({ result: { create_time: new Date(pay.created_at).getTime(), perform_time: pay.status === 'success' ? new Date(pay.updated_at).getTime() : 0, cancel_time: pay.status === 'failed' ? new Date(pay.updated_at).getTime() : 0, transaction: pay.id, state: s[pay.status] || 1, reason: null }, id });
}

function GetStatement({ from, to }, id, res) {
  const pays = db.prepare("SELECT * FROM payments WHERE provider='payme' AND created_at BETWEEN ? AND ?")
    .all(new Date(from).toISOString(), new Date(to).toISOString());
  res.json({ result: { transactions: pays.map(p => ({ id: p.provider_transaction_id, time: new Date(p.created_at).getTime(), amount: p.amount, account: { order_code: p.id }, transaction: p.id, state: p.status === 'success' ? 2 : -1, reason: null })) }, id });
}

module.exports = router;
