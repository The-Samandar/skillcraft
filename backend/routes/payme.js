// routes/payme.js — Payme Merchant API (JSON-RPC 2.0)
// Документация: https://developer.help.paycom.uz/

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

// ─── АВТОРИЗАЦИЯ ─────────────────────────────────────────────
// Payme шлёт Basic Auth: login = Merchant ID, password = Secret Key
function verifyAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    console.log('❌ Payme auth: нет заголовка Authorization');
    return false;
  }

  const decoded  = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const login    = decoded.slice(0, colonIdx);
  const pass     = decoded.slice(colonIdx + 1);

  const mid      = process.env.PAYME_MERCHANT_ID;
  const testKey  = process.env.PAYME_TEST_KEY;
  const liveKey  = process.env.PAYME_SECRET_KEY;

  console.log(`🔑 Payme auth: login="${login}", mid="${mid}"`);

  // Dev режим — ключи не заданы
  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID') return true;

  // В тестовой среде Payme присылает логин "Paycom"
  // В боевой — присылает Merchant ID
  const loginOk = (login === mid) || (login === 'Paycom');
  const passOk  = (pass === testKey || pass === liveKey);

  const ok = loginOk && passOk;
  if (!ok) console.log(`❌ Payme auth failed. login="${login}", pass="${pass}", testKey="${testKey}"`);
  return ok;
}

// ─── ПОЛУЧИТЬ ORDER_CODE ──────────────────────────────────────
// Payme может передавать как account.order так и account.order_code
function getOrderCode(account) {
  return account?.order_code || account?.order || null;
}

// ─── CHECKOUT URL ─────────────────────────────────────────────
router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const mid = process.env.PAYME_MERCHANT_ID;
  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID')
    return res.status(500).json({ error: 'Payme не настроен' });

  // ac.order — передаём order_code как параметр order
  const params  = `m=${mid};ac.order=${order.order_code};a=${order.amount};l=ru`;
  const encoded = Buffer.from(params).toString('base64');
  const base    = process.env.NODE_ENV === 'production'
    ? 'https://checkout.paycom.uz'
    : 'https://test.paycom.uz';

  res.json({ checkout_url: `${base}/${encoded}` });
});

// ─── CALLBACK (все JSON-RPC методы) ──────────────────────────
router.post('/callback', (req, res) => {
  // Проверка авторизации
  if (!verifyAuth(req)) {
    return res.json({
      error: { code: -32504, message: 'Forbidden' },
      id: req.body?.id ?? null,
    });
  }

  const { method, params, id } = req.body || {};
  console.log(`📥 Payme RPC: ${method}`, JSON.stringify(params));

  const handlers = {
    CheckPerformTransaction,
    CreateTransaction,
    PerformTransaction,
    CancelTransaction,
    CheckTransaction,
    GetStatement,
  };

  if (handlers[method]) return handlers[method](params || {}, id, res);

  return res.json({
    error: { code: -32601, message: 'Method not found' },
    id,
  });
});

// ─── CheckPerformTransaction ──────────────────────────────────
// Payme проверяет: можно ли создать транзакцию?
function CheckPerformTransaction({ account, amount }, id, res) {
  const orderCode = getOrderCode(account);

  if (!orderCode) {
    return res.json({
      error: { code: -31050, message: { ru: 'Не указан номер заказа', en: 'Order not specified' } },
      id,
    });
  }

  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(String(orderCode));

  if (!order) {
    return res.json({
      error: { code: -31050, message: { ru: 'Заказ не найден', uz: 'Buyurtma topilmadi', en: 'Order not found' } },
      id,
    });
  }

  if (order.status === 'paid') {
    return res.json({
      error: { code: -31050, message: { ru: 'Заказ уже оплачен', en: 'Already paid' } },
      id,
    });
  }

  // Сумма в тийинах должна совпадать
  if (order.amount !== parseInt(amount)) {
    console.log(`❌ Сумма не совпадает: order.amount=${order.amount}, payme.amount=${amount}`);
    return res.json({
      error: { code: -31001, message: { ru: 'Неверная сумма', uz: "Noto'g'ri summa", en: 'Incorrect amount' } },
      id,
    });
  }

  return res.json({ result: { allow: true }, id });
}

// ─── CreateTransaction ────────────────────────────────────────
function CreateTransaction({ id: payme_id, time, amount, account }, id, res) {
  const orderCode = getOrderCode(account);
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(String(orderCode));

  if (!order) {
    return res.json({
      error: { code: -31050, message: { ru: 'Заказ не найден', en: 'Order not found' } },
      id,
    });
  }

  if (order.amount !== parseInt(amount)) {
    return res.json({
      error: { code: -31001, message: { ru: 'Неверная сумма', en: 'Incorrect amount' } },
      id,
    });
  }

  // Проверяем существующую транзакцию
  const existing = db.prepare(
    "SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'"
  ).get(payme_id);

  if (existing) {
    if (existing.status === 'failed') {
      return res.json({
        error: { code: -31008, message: { ru: 'Транзакция отменена', en: 'Transaction cancelled' } },
        id,
      });
    }
    return res.json({
      result: {
        create_time: new Date(existing.created_at).getTime(),
        transaction: existing.id,
        state: 1,
      },
      id,
    });
  }

  // Создаём новую
  const pid = uuidv4();
  db.prepare(
    "INSERT INTO payments (id,order_id,provider,provider_transaction_id,amount,raw_payload,status) VALUES (?,?,'payme',?,?,?,'pending')"
  ).run(pid, order.id, payme_id, order.amount, JSON.stringify({ id: payme_id, time, amount, account }));

  console.log(`✅ Payme CreateTransaction: ${pid}`);

  return res.json({
    result: { create_time: time, transaction: pid, state: 1 },
    id,
  });
}

// ─── PerformTransaction ───────────────────────────────────────
function PerformTransaction({ id: payme_id }, id, res) {
  const pay = db.prepare(
    "SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'"
  ).get(payme_id);

  if (!pay) {
    return res.json({
      error: { code: -31003, message: { ru: 'Транзакция не найдена', en: 'Transaction not found' } },
      id,
    });
  }

  if (pay.status === 'success') {
    return res.json({
      result: {
        perform_time: new Date(pay.updated_at).getTime(),
        transaction: pay.id,
        state: 2,
      },
      id,
    });
  }

  const now = Date.now();
  db.prepare("UPDATE payments SET status='success' WHERE id=?").run(pay.id);
  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(pay.order_id);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(pay.order_id);
  grantCourseAccess(order.id, order.user_id);

  console.log(`✅✅ Payme PerformTransaction SUCCESS: order=${pay.order_id}`);

  return res.json({
    result: { perform_time: now, transaction: pay.id, state: 2 },
    id,
  });
}

// ─── CancelTransaction ────────────────────────────────────────
function CancelTransaction({ id: payme_id, reason }, id, res) {
  const pay = db.prepare(
    "SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'"
  ).get(payme_id);

  if (!pay) {
    return res.json({
      error: { code: -31003, message: { ru: 'Транзакция не найдена', en: 'Transaction not found' } },
      id,
    });
  }

  const now = Date.now();
  db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(pay.id);
  db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(pay.order_id);
  db.prepare("UPDATE access_grants SET is_active=0 WHERE order_id=?").run(pay.order_id);

  console.log(`❌ Payme CancelTransaction: ${payme_id}, reason=${reason}`);

  return res.json({
    result: { cancel_time: now, transaction: pay.id, state: -1 },
    id,
  });
}

// ─── CheckTransaction ─────────────────────────────────────────
function CheckTransaction({ id: payme_id }, id, res) {
  const pay = db.prepare(
    "SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme'"
  ).get(payme_id);

  if (!pay) {
    return res.json({
      error: { code: -31003, message: { ru: 'Транзакция не найдена', en: 'Transaction not found' } },
      id,
    });
  }

  const stateMap = { pending: 1, success: 2, failed: -1 };

  return res.json({
    result: {
      create_time:  new Date(pay.created_at).getTime(),
      perform_time: pay.status === 'success' ? new Date(pay.updated_at).getTime() : 0,
      cancel_time:  pay.status === 'failed'  ? new Date(pay.updated_at).getTime() : 0,
      transaction:  pay.id,
      state:        stateMap[pay.status] ?? 1,
      reason:       null,
    },
    id,
  });
}

// ─── GetStatement ─────────────────────────────────────────────
function GetStatement({ from, to }, id, res) {
  const pays = db.prepare(
    "SELECT * FROM payments WHERE provider='payme' AND created_at BETWEEN ? AND ?"
  ).all(new Date(from).toISOString(), new Date(to).toISOString());

  return res.json({
    result: {
      transactions: pays.map(p => ({
        id:           p.provider_transaction_id,
        time:         new Date(p.created_at).getTime(),
        amount:       p.amount,
        account:      { order: p.id },
        transaction:  p.id,
        state:        p.status === 'success' ? 2 : -1,
        reason:       null,
      })),
    },
    id,
  });
}

module.exports = router;
