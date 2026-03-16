// routes/payme.js — Payme Merchant API (JSON-RPC 2.0)
// Документация: https://developer.help.paycom.uz/

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

const PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000;

function verifyAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) {
    console.log('❌ Payme auth: нет заголовка Authorization');
    return false;
  }

  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  const login = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  const mid = process.env.PAYME_MERCHANT_ID;
  const testKey = process.env.PAYME_TEST_KEY;
  const liveKey = process.env.PAYME_SECRET_KEY;

  console.log(`🔑 Payme auth: login="${login}", mid="${mid}"`);

  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID') return true;

  const loginOk = login === mid || login === 'Paycom';
  const passOk = pass === testKey || pass === liveKey;
  const ok = loginOk && passOk;

  if (!ok) {
    console.log(`❌ Payme auth failed. login="${login}"`);
  }

  return ok;
}

function getOrderCode(account) {
  return account?.order_code || account?.order || null;
}

function msg(ru, en, uz) {
  return {
    ru,
    en: en || ru,
    uz: uz || ru,
  };
}

function respondError(res, id, code, message, data) {
  const payload = {
    error: {
      code,
      message,
    },
    id,
  };

  if (data !== undefined) payload.error.data = data;
  return res.json(payload);
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = {}) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function readPaymentMeta(payment) {
  return safeJsonParse(payment?.raw_payload, {});
}

function writePaymentMeta(payment, extra = {}) {
  const meta = {
    ...readPaymentMeta(payment),
    ...extra,
  };

  db.prepare('UPDATE payments SET raw_payload = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), nowIso(), payment.id);

  return meta;
}

function getPaymeTimeMs(payment) {
  const meta = readPaymentMeta(payment);
  const value = Number(meta.time || meta.create_time || 0);
  if (Number.isFinite(value) && value > 0) return value;
  return new Date(payment.created_at).getTime();
}

function getCancelState(payment) {
  const meta = readPaymentMeta(payment);
  return meta.cancel_state === -2 ? -2 : -1;
}

function getCancelReason(payment) {
  const meta = readPaymentMeta(payment);
  return meta.cancel_reason ?? null;
}

function isPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase();
}

function getOrderOrAccountError(orderCode, res, id) {
  if (!orderCode) {
    respondError(
      res,
      id,
      -31050,
      msg('Не указан номер заказа', 'Order is not specified', 'Buyurtma raqami ko\'rsatilmagan'),
      'account.order'
    );
    return null;
  }

  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(String(orderCode));
  if (!order) {
    respondError(
      res,
      id,
      -31050,
      msg('Заказ не найден', 'Order not found', 'Buyurtma topilmadi'),
      'account.order'
    );
    return null;
  }

  return order;
}

function getOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function getPaymePaymentByProviderId(paymeId) {
  return db.prepare(
    "SELECT * FROM payments WHERE provider_transaction_id = ? AND provider = 'payme' LIMIT 1"
  ).get(paymeId);
}

function getPendingPaymePaymentsForOrder(order) {
  const rows = db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' AND status = 'pending' ORDER BY created_at DESC"
  ).all();

  return rows.filter((payment) => {
    if (String(payment.order_id) === String(order.id)) return true;

    const meta = readPaymentMeta(payment);
    const metaOrderCode = getOrderCode(meta.account) || meta.order_code || meta.order || null;
    if (metaOrderCode && String(metaOrderCode) === String(order.order_code)) return true;

    return false;
  });
}

function getActivePendingPaymePayment(order) {
  const payments = getPendingPaymePaymentsForOrder(order);
  if (!payments.length) return null;

  const currentTs = nowMs();
  const active = payments.find((payment) => currentTs - getPaymeTimeMs(payment) <= PAYME_TIMEOUT_MS);
  return active || payments[0];
}

function isOrderBlocked(order) {
  return ['paid', 'canceled', 'cancelled', 'failed'].includes(normalizeStatus(order.status));
}

function checkAmount(order, amount, res, id) {
  if (!isPositiveInteger(amount)) {
    respondError(res, id, -31001, msg('Неверная сумма', 'Incorrect amount', "Noto'g'ri summa"));
    return false;
  }

  if (Number(order.amount) !== Number(amount)) {
    console.log(`❌ Сумма не совпадает: order.amount=${order.amount}, payme.amount=${amount}`);
    respondError(res, id, -31001, msg('Неверная сумма', 'Incorrect amount', "Noto'g'ri summa"));
    return false;
  }

  return true;
}

function getPaymentState(payment) {
  if (payment.status === 'success') return 2;
  if (payment.status === 'failed') return getCancelState(payment);
  return 1;
}

router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const mid = process.env.PAYME_MERCHANT_ID;
  if (!mid || mid === 'YOUR_PAYME_MERCHANT_ID') {
    return res.status(500).json({ error: 'Payme не настроен' });
  }

  const params = `m=${mid};ac.order=${order.order_code};a=${order.amount};l=ru`;
  const encoded = Buffer.from(params).toString('base64');
  const base = process.env.NODE_ENV === 'production'
    ? 'https://checkout.paycom.uz'
    : 'https://test.paycom.uz';

  return res.json({ checkout_url: `${base}/${encoded}` });
});

router.post('/callback', (req, res) => {
  if (!verifyAuth(req)) {
    return respondError(res, req.body?.id ?? null, -32504, msg('Доступ запрещён', 'Forbidden', 'Ruxsat berilmagan'));
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

  return respondError(res, id, -32601, msg('Метод не найден', 'Method not found', 'Metod topilmadi'));
});

function CheckPerformTransaction({ account, amount }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  if (isOrderBlocked(order)) {
    return respondError(
      res,
      id,
      -31052,
      msg(
        'Заказ недоступен для оплаты',
        'Order is not available for payment',
        'Buyurtmani to\'lash mumkin emas'
      ),
      'account.order'
    );
  }

  const activePayment = getActivePendingPaymePayment(order);
  if (activePayment) {
    return respondError(
      res,
      id,
      -31051,
      msg(
        'Платёж по этому заказу уже обрабатывается',
        'Payment for this order is already being processed',
        'Ushbu buyurtma bo\'yicha to\'lov allaqachon qayta ishlanmoqda'
      ),
      'account.order'
    );
  }

  return res.json({ result: { allow: true }, id });
}

function CreateTransaction({ id: paymeId, time, amount, account }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  if (isOrderBlocked(order)) {
    return respondError(
      res,
      id,
      -31052,
      msg(
        'Заказ недоступен для оплаты',
        'Order is not available for payment',
        'Buyurtmani to\'lash mumkin emas'
      ),
      'account.order'
    );
  }

  const existingByProviderId = getPaymePaymentByProviderId(paymeId);
  if (existingByProviderId) {
    return res.json({
      result: {
        create_time: getPaymeTimeMs(existingByProviderId),
        transaction: existingByProviderId.id,
        state: getPaymentState(existingByProviderId),
      },
      id,
    });
  }

  const activePayment = getActivePendingPaymePayment(order);
  if (activePayment) {
    return respondError(
      res,
      id,
      -31051,
      msg(
        'Платёж по этому заказу уже обрабатывается',
        'Payment for this order is already being processed',
        'Ushbu buyurtma bo\'yicha to\'lov allaqachon qayta ishlanmoqda'
      ),
      'account.order'
    );
  }

  const paymentId = uuidv4();
  const meta = {
    id: paymeId,
    time: Number(time) || nowMs(),
    amount: Number(amount),
    account: account || {},
    order_code: order.order_code,
    cancel_reason: null,
    cancel_state: null,
  };

  db.prepare(
    "INSERT INTO payments (id, order_id, provider, provider_transaction_id, amount, raw_payload, status, created_at, updated_at) VALUES (?, ?, 'payme', ?, ?, ?, 'pending', ?, ?)"
  ).run(paymentId, order.id, paymeId, Number(order.amount), JSON.stringify(meta), nowIso(), nowIso());

  console.log(`✅ Payme CreateTransaction: ${paymentId}`);

  return res.json({
    result: {
      create_time: Number(time) || nowMs(),
      transaction: paymentId,
      state: 1,
    },
    id,
  });
}

function PerformTransaction({ id: paymeId }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003, msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi'));
  }

  if (payment.status === 'success') {
    return res.json({
      result: {
        transaction: payment.id,
        perform_time: new Date(payment.updated_at || payment.created_at).getTime(),
        state: 2,
      },
      id,
    });
  }

  if (payment.status === 'failed') {
    return respondError(
      res,
      id,
      -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', 'Amalni bajarib bo\'lmaydi')
    );
  }

  const createdMs = getPaymeTimeMs(payment);
  if (nowMs() - createdMs > PAYME_TIMEOUT_MS) {
    const cancelTime = nowMs();
    const cancelIso = new Date(cancelTime).toISOString();
    db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.id);
    writePaymentMeta(payment, { cancel_reason: 4, cancel_state: -1, cancel_time: cancelTime });
    db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.order_id);

    return respondError(
      res,
      id,
      -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', 'Amalni bajarib bo\'lmaydi')
    );
  }

  const order = getOrderById(payment.order_id);
  if (!order) {
    return respondError(
      res,
      id,
      -31050,
      msg('Заказ не найден', 'Order not found', 'Buyurtma topilmadi'),
      'account.order'
    );
  }

  if (isOrderBlocked(order) && normalizeStatus(order.status) !== 'paid') {
    return respondError(
      res,
      id,
      -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', 'Amalni bajarib bo\'lmaydi')
    );
  }

  const performTime = nowMs();
  const performIso = new Date(performTime).toISOString();
  db.prepare("UPDATE payments SET status = 'success', updated_at = ? WHERE id = ?").run(performIso, payment.id);
  db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?").run(performIso, payment.order_id);

  grantCourseAccess(order.id, order.user_id);
  console.log(`✅✅ Payme PerformTransaction SUCCESS: order=${payment.order_id}`);

  return res.json({
    result: {
      transaction: payment.id,
      perform_time: performTime,
      state: 2,
    },
    id,
  });
}

function CancelTransaction({ id: paymeId, reason }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003, msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi'));
  }

  if (payment.status === 'failed') {
    return res.json({
      result: {
        transaction: payment.id,
        cancel_time: new Date(payment.updated_at || payment.created_at).getTime(),
        state: getCancelState(payment),
      },
      id,
    });
  }

  const cancelTime = nowMs();
  const cancelIso = new Date(cancelTime).toISOString();
  const wasPerformed = payment.status === 'success';
  const cancelState = wasPerformed ? -2 : -1;

  db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.id);
  db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(cancelIso, payment.order_id);
  db.prepare('UPDATE access_grants SET is_active = 0 WHERE order_id = ?').run(payment.order_id);
  writePaymentMeta(payment, { cancel_reason: reason ?? null, cancel_state: cancelState, cancel_time: cancelTime });

  console.log(`❌ Payme CancelTransaction: ${paymeId}, reason=${reason}`);

  return res.json({
    result: {
      transaction: payment.id,
      cancel_time: cancelTime,
      state: cancelState,
    },
    id,
  });
}

function CheckTransaction({ id: paymeId }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003, msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi'));
  }

  return res.json({
    result: {
      create_time: getPaymeTimeMs(payment),
      perform_time: payment.status === 'success' ? new Date(payment.updated_at || payment.created_at).getTime() : 0,
      cancel_time: payment.status === 'failed' ? new Date(payment.updated_at || payment.created_at).getTime() : 0,
      transaction: payment.id,
      state: getPaymentState(payment),
      reason: payment.status === 'failed' ? getCancelReason(payment) : null,
    },
    id,
  });
}

function GetStatement({ from, to }, id, res) {
  const fromIso = new Date(Number(from)).toISOString();
  const toIso = new Date(Number(to)).toISOString();
  const payments = db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC"
  ).all(fromIso, toIso);

  return res.json({
    result: {
      transactions: payments.map((payment) => {
        const meta = readPaymentMeta(payment);
        return {
          id: payment.provider_transaction_id,
          time: Number(meta.time) || new Date(payment.created_at).getTime(),
          amount: Number(payment.amount),
          account: {
            order: getOrderCode(meta.account) || meta.order_code || meta.order || null,
          },
          create_time: getPaymeTimeMs(payment),
          perform_time: payment.status === 'success' ? new Date(payment.updated_at || payment.created_at).getTime() : 0,
          cancel_time: payment.status === 'failed' ? new Date(payment.updated_at || payment.created_at).getTime() : 0,
          transaction: payment.id,
          state: getPaymentState(payment),
          reason: payment.status === 'failed' ? getCancelReason(payment) : null,
        };
      }),
    },
    id,
  });
}

module.exports = router;