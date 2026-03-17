// routes/payme.js — Payme Merchant API (JSON-RPC 2.0)
// Документация: https://developer.help.paycom.uz/
// Версия: исправлена строго по официальной документации Payme

const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

// Таймаут: 12 часов = 43 200 000 мс (по документации Payme)
const PAYME_TIMEOUT_MS = 43200000;

// ─── AUTH ─────────────────────────────────────────────────────────────────────

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

  if (!mid) {
    console.log('❌ Payme auth: PAYME_MERCHANT_ID не задан в .env');
    return false;
  }

  const loginOk = login === mid || login === 'Paycom';
  const passOk = pass === testKey || (liveKey && pass === liveKey);
  const ok = loginOk && passOk;

  if (!ok) console.log(`❌ Payme auth failed. login="${login}"`);

  return ok;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getOrderCode(account) {
  return account?.order_code || account?.order || null;
}

// Локализованное сообщение — объект {ru, en, uz}
function msg(ru, en, uz) {
  return { ru, en: en || ru, uz: uz || ru };
}

// ✅ respondError строго по документации Payme:
// { "error": { "code": ..., "message": {...}, "data": ... }, "id": ... }
// HTTP статус ВСЕГДА 200 (иначе Payme считает это ошибкой -32400)
function respondError(res, reqId, code, message, data) {
  const errObj = { code, message };
  if (data !== undefined) errObj.data = data;
  return res.status(200).json({
    error: errObj,
    id: reqId !== undefined ? reqId : null,
  });
}

// ✅ respondResult строго по документации Payme:
// { "result": { ... }, "id": ... }
function respondResult(res, reqId, result) {
  return res.status(200).json({
    result,
    id: reqId !== undefined ? reqId : null,
  });
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
  const meta = { ...readPaymentMeta(payment), ...extra };
  db.prepare('UPDATE payments SET raw_payload = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(meta), nowIso(), payment.id);
  return meta;
}

// Время создания транзакции в системе Payme (поле time из CreateTransaction)
// Используется в GetStatement для фильтрации по from/to
function getPaymeTimeMs(payment) {
  const meta = readPaymentMeta(payment);
  const value = Number(meta.time || meta.create_time || 0);
  if (Number.isFinite(value) && value > 0) return value;
  return new Date(payment.created_at).getTime();
}

// ✅ perform_time — сохраняем в meta при PerformTransaction
function getPerformTimeMs(payment) {
  const meta = readPaymentMeta(payment);
  if (meta.perform_time && Number(meta.perform_time) > 0) return Number(meta.perform_time);
  return new Date(payment.updated_at || payment.created_at).getTime();
}

// ✅ cancel_time — сохраняем в meta при CancelTransaction
function getCancelTimeMs(payment) {
  const meta = readPaymentMeta(payment);
  if (meta.cancel_time && Number(meta.cancel_time) > 0) return Number(meta.cancel_time);
  return new Date(payment.updated_at || payment.created_at).getTime();
}

function getCancelState(payment) {
  const meta = readPaymentMeta(payment);
  return meta.cancel_state === -2 ? -2 : -1;
}

// ✅ reason — integer (1..10) или null, по типам данных документации Payme
function getCancelReason(payment) {
  const meta = readPaymentMeta(payment);
  const r = meta.cancel_reason;
  if (r === null || r === undefined) return null;
  const n = Number(r);
  return Number.isInteger(n) && n > 0 ? n : null;
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
      res, id, -31050,
      msg('Не указан номер заказа', 'Order is not specified', "Buyurtma raqami ko'rsatilmagan"),
      'order'  // ✅ data = субполе account (без префикса "account.")
    );
    return null;
  }

  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(String(orderCode));
  if (!order) {
    respondError(
      res, id, -31050,
      msg('Заказ не найден', 'Order not found', 'Buyurtma topilmadi'),
      'order'
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
  return payments.find((p) => currentTs - getPaymeTimeMs(p) <= PAYME_TIMEOUT_MS) || null;
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
    console.log(`❌ Сумма: order.amount=${order.amount}, payme.amount=${amount}`);
    respondError(res, id, -31001, msg('Неверная сумма', 'Incorrect amount', "Noto'g'ri summa"));
    return false;
  }
  return true;
}

// Состояния транзакции по документации:
// 1  = создана, ожидание подтверждения
// 2  = успешно завершена
// -1 = отменена (до выполнения)
// -2 = отменена после выполнения
function getPaymentState(payment) {
  if (payment.status === 'success') return 2;
  if (payment.status === 'failed') return getCancelState(payment);
  return 1;
}

// ─── CHECKOUT URL ─────────────────────────────────────────────────────────────

router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const mid = process.env.PAYME_MERCHANT_ID;
  if (!mid) return res.status(500).json({ error: 'Payme не настроен: нет PAYME_MERCHANT_ID' });

  const params = `m=${mid};ac.order=${order.order_code};a=${order.amount};l=ru`;
  const encoded = Buffer.from(params).toString('base64');
  const base = process.env.NODE_ENV === 'production'
    ? 'https://checkout.paycom.uz'
    : 'https://test.paycom.uz';

  return res.json({ checkout_url: `${base}/${encoded}` });
});

// ─── CALLBACK (JSON-RPC) ──────────────────────────────────────────────────────

router.post('/callback', (req, res) => {
  if (!verifyAuth(req)) {
    return respondError(
      res,
      req.body?.id ?? null,
      -32504,
      msg('Доступ запрещён', 'Forbidden', 'Ruxsat berilmagan')
    );
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

// ─── RPC МЕТОДЫ ───────────────────────────────────────────────────────────────

// ✅ CheckPerformTransaction
// Только проверяет возможность оплаты — НЕ создаёт транзакцию
function CheckPerformTransaction({ account, amount }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  if (isOrderBlocked(order)) {
    return respondError(
      res, id, -31050,
      msg('Заказ недоступен для оплаты', 'Order is not available for payment', "Buyurtmani to'lash mumkin emas"),
      'order'
    );
  }

  return respondResult(res, id, { allow: true });
}

// ✅ CreateTransaction
function CreateTransaction({ id: paymeId, time, amount, account }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  // Идемпотентность: транзакция с таким paymeId уже существует
  const existingByProviderId = getPaymePaymentByProviderId(paymeId);
  if (existingByProviderId) {
    if (existingByProviderId.status === 'failed') {
      return respondError(
        res, id, -31008,
        msg('Невозможно выполнить операцию', 'Unable to perform operation', "Amalni bajarib bo'lmaydi")
      );
    }
    return respondResult(res, id, {
      create_time: getPaymeTimeMs(existingByProviderId),
      transaction: existingByProviderId.id,
      state: getPaymentState(existingByProviderId),
    });
  }

  if (isOrderBlocked(order)) {
    return respondError(
      res, id, -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', "Amalni bajarib bo'lmaydi")
    );
  }

  // Есть активный pending платёж с другим paymeId
  const activePayment = getActivePendingPaymePayment(order);
  if (activePayment) {
    return respondError(
      res, id, -31051,   // ← СТАЛО
      msg(
       'Транзакция в обработке',
       'Transaction is in progress',
       'Tranzaksiya jarayonda'
      )
    );
  }

  const paymentId = uuidv4();
  const createTime = Number(time) || nowMs();
  const meta = {
    id: paymeId,
    time: createTime,     // ← Время Payme. Обязательно для GetStatement
    perform_time: 0,      // ← Заполняется при PerformTransaction
    cancel_time: 0,       // ← Заполняется при CancelTransaction
    amount: Number(amount),
    account: account || {},
    order_code: order.order_code,
    cancel_reason: null,
    cancel_state: null,
  };

  db.prepare(
    "INSERT INTO payments (id, order_id, provider, provider_transaction_id, amount, raw_payload, status, created_at, updated_at) VALUES (?, ?, 'payme', ?, ?, ?, 'pending', ?, ?)"
  ).run(paymentId, order.id, paymeId, Number(order.amount), JSON.stringify(meta), nowIso(), nowIso());

  console.log(`✅ Payme CreateTransaction: paymentId=${paymentId}, paymeId=${paymeId}`);

  return respondResult(res, id, {
    create_time: createTime,
    transaction: paymentId,
    state: 1,
  });
}

// ✅ PerformTransaction
function PerformTransaction({ id: paymeId }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003,
      msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi')
    );
  }

  // Уже выполнена — идемпотентный ответ
  if (payment.status === 'success') {
    return respondResult(res, id, {
      transaction: payment.id,
      perform_time: getPerformTimeMs(payment),
      state: 2,
    });
  }

  // Отменена — нельзя выполнить
  if (payment.status === 'failed') {
    return respondError(
      res, id, -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', "Amalni bajarib bo'lmaydi")
    );
  }

  // Таймаут — отменяем с причиной 4 (по документации)
  const createdMs = getPaymeTimeMs(payment);
  if (nowMs() - createdMs > PAYME_TIMEOUT_MS) {
    const cancelTime = nowMs();
    const cancelIso = new Date(cancelTime).toISOString();
    writePaymentMeta(payment, { cancel_reason: 4, cancel_state: -1, cancel_time: cancelTime });
    db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.id);
    db.prepare("UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.order_id);
    console.log(`⏱️ Payme PerformTransaction: таймаут`);
    return respondError(
      res, id, -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', "Amalni bajarib bo'lmaydi")
    );
  }

  const order = getOrderById(payment.order_id);
  if (!order) {
    return respondError(res, id, -31050,
      msg('Заказ не найден', 'Order not found', 'Buyurtma topilmadi'), 'order'
    );
  }

  if (['canceled', 'cancelled', 'failed'].includes(normalizeStatus(order.status))) {
    return respondError(
      res, id, -31008,
      msg('Невозможно выполнить операцию', 'Unable to perform operation', "Amalni bajarib bo'lmaydi")
    );
  }

  const performTime = nowMs();
  const performIso = new Date(performTime).toISOString();

  // ✅ Сохраняем perform_time в meta — используется в CheckTransaction и GetStatement
  writePaymentMeta(payment, { perform_time: performTime });
  db.prepare("UPDATE payments SET status = 'success', updated_at = ? WHERE id = ?").run(performIso, payment.id);
  db.prepare("UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?").run(performIso, payment.order_id);

  try {
    grantCourseAccess(order.id, order.user_id);
  } catch (e) {
    console.error('❌ grantCourseAccess error:', e);
  }

  console.log(`✅✅ Payme PerformTransaction SUCCESS: order=${payment.order_id}`);

  return respondResult(res, id, {
    transaction: payment.id,
    perform_time: performTime,
    state: 2,
  });
}

// ✅ CancelTransaction
function CancelTransaction({ id: paymeId, reason }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003,
      msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi')
    );
  }

  // Уже отменена — идемпотентный ответ
  if (payment.status === 'failed') {
    return respondResult(res, id, {
      transaction: payment.id,
      cancel_time: getCancelTimeMs(payment),
      state: getCancelState(payment),
    });
  }

  // ⚠️ Раскомментируйте если хотите запретить отмену после выполнения:
  /*
  if (payment.status === 'success') {
    return respondError(res, id, -31007,
      msg('Невозможно отменить. Услуга предоставлена.', 'Cannot cancel. Service provided.', "Bekor qilib bo'lmaydi.")
    );
  }
  */

  const cancelTime = nowMs();
  const cancelIso = new Date(cancelTime).toISOString();
  const wasPerformed = payment.status === 'success';
  const cancelState = wasPerformed ? -2 : -1;
  const cancelReason = reason !== undefined ? Number(reason) : null;

  writePaymentMeta(payment, {
    cancel_reason: cancelReason,
    cancel_state: cancelState,
    cancel_time: cancelTime,
  });
  db.prepare("UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?").run(cancelIso, payment.id);
  db.prepare("UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?").run(cancelIso, payment.order_id);
  db.prepare('UPDATE access_grants SET is_active = 0 WHERE order_id = ?').run(payment.order_id);

  console.log(`❌ Payme CancelTransaction: ${paymeId}, reason=${cancelReason}, state=${cancelState}`);

  return respondResult(res, id, {
    transaction: payment.id,
    cancel_time: cancelTime,
    state: cancelState,
  });
}

// ✅ CheckTransaction
// Документация: https://developer.help.paycom.uz/metody-merchant-api/checkperformtransaction
//
// Обязательные поля ответа (все 6 полей):
//   create_time  — Timestamp создания транзакции в нашей системе
//   perform_time — Timestamp выполнения, или 0
//   cancel_time  — Timestamp отмены, или 0
//   transaction  — Наш внутренний строковый ID
//   state        — integer: 1, 2, -1, -2
//   reason       — integer код причины отмены, или null
//
// Единственный код ошибки: -31003 (транзакция не найдена)
function CheckTransaction({ id: paymeId }, id, res) {
  const payment = getPaymePaymentByProviderId(paymeId);

  if (!payment) {
    return respondError(res, id, -31003,
      msg('Транзакция не найдена', 'Transaction not found', 'Tranzaksiya topilmadi')
    );
  }

  const state = getPaymentState(payment);

  return respondResult(res, id, {
    create_time:  getPaymeTimeMs(payment),
    perform_time: (state === 2 || state === -2) ? getPerformTimeMs(payment) : 0,
    cancel_time:  state < 0   ? getCancelTimeMs(payment)  : 0,
    transaction:  payment.id,
    state,
    reason:       state < 0   ? getCancelReason(payment)  : null,
  });
}

// ✅ GetStatement
// Документация: https://developer.help.paycom.uz/metody-merchant-api/getstatement
//
// Требования:
// 1. Искать по времени создания в Payme (поле time из CreateTransaction params)
// 2. from <= time <= to, сортировка по возрастанию
// 3. Пустой список если нет транзакций за период
function GetStatement({ from, to }, id, res) {
  const fromMs = Number(from);
  const toMs = Number(to);

  if (!fromMs || !toMs || fromMs <= 0 || toMs <= 0) {
    return respondError(
      res, id, -31050,
      msg('Неверный диапазон дат', 'Invalid date range', "Noto'g'ri sana oralig'i")
    );
  }

  const allPayments = db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' ORDER BY created_at ASC"
  ).all();

  const filtered = allPayments.filter((payment) => {
    const t = getPaymeTimeMs(payment);
    return t >= fromMs && t <= toMs;
  });

  return respondResult(res, id, {
    transactions: filtered.map((payment) => {
      const meta = readPaymentMeta(payment);
      const state = getPaymentState(payment);
      return {
        id:           payment.provider_transaction_id,    // ID транзакции Payme
        time:         getPaymeTimeMs(payment),             // Время создания в Payme
        amount:       Number(payment.amount),
        account: {
          order: getOrderCode(meta.account) || meta.order_code || meta.order || null,
        },
        create_time:  getPaymeTimeMs(payment),
        perform_time: (state === 2 || state === -2) ? getPerformTimeMs(payment) : 0,
        cancel_time:  state < 0   ? getCancelTimeMs(payment)  : 0,
        transaction:  payment.id,                          // Наш внутренний ID
        state,
        reason:       state < 0   ? getCancelReason(payment)  : null,
      };
    }),
  });
}

module.exports = router;