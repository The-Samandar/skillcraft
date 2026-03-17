// backend/routes/payme.js
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

const PAYME_TIMEOUT_MS = 12 * 60 * 60 * 1000;

// =========================
// HELPERS
// =========================

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

  if (data !== undefined) {
    payload.error.data = data;
  }

  return res.json(payload);
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(value, fallback = {}) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getOrderCode(account) {
  return account?.order || account?.order_code || null;
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase();
}

function isPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function verifyAuth(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) return false;

  const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;

  const login = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  const merchantId = process.env.PAYME_MERCHANT_ID;
  const secretKey = process.env.PAYME_SECRET_KEY;
  const testKey = process.env.PAYME_TEST_KEY;

  if (!merchantId) return false;

  const loginOk = login === merchantId || login === 'Paycom';
  const passOk =
    (secretKey && pass === secretKey) ||
    (testKey && pass === testKey);

  return loginOk && passOk;
}

function getOrderOrAccountError(orderCode, res, id) {
  if (!orderCode) {
    respondError(
      res,
      id,
      -31050,
      msg(
        'Не указан номер заказа',
        'Order is not specified',
        "Buyurtma raqami ko'rsatilmagan"
      ),
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
      msg(
        'Заказ не найден',
        'Order not found',
        'Buyurtma topilmadi'
      ),
      'account.order'
    );
    return null;
  }

  return order;
}

function getOrderById(orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
}

function getPaymentByPaymeId(paymeId) {
  return db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' AND provider_transaction_id = ? LIMIT 1"
  ).get(String(paymeId));
}

function getPaymentMeta(payment) {
  return safeParseJson(payment?.raw_payload, {});
}

function writePaymentMeta(payment, patch = {}) {
  const next = {
    ...getPaymentMeta(payment),
    ...patch,
  };

  db.prepare(
    'UPDATE payments SET raw_payload = ?, updated_at = ? WHERE id = ?'
  ).run(JSON.stringify(next), nowIso(), payment.id);

  return next;
}

function getPaymeTimeMs(payment) {
  const meta = getPaymentMeta(payment);
  const t = Number(meta.time || meta.create_time || 0);
  if (Number.isFinite(t) && t > 0) return t;
  return new Date(payment.created_at).getTime();
}

function getCancelState(payment) {
  const meta = getPaymentMeta(payment);
  return meta.cancel_state === -2 ? -2 : -1;
}

function getCancelReason(payment) {
  const meta = getPaymentMeta(payment);
  return meta.cancel_reason ?? null;
}

function getPaymentState(payment) {
  if (payment.status === 'success') return 2;
  if (payment.status === 'failed') return getCancelState(payment);
  return 1;
}

function isOrderBlocked(order) {
  return ['paid', 'canceled', 'cancelled', 'failed'].includes(normalizeStatus(order.status));
}

function checkAmount(order, amount, res, id) {
  if (!isPositiveInteger(amount)) {
    respondError(
      res,
      id,
      -31001,
      msg('Неверная сумма', 'Incorrect amount', "Noto'g'ri summa")
    );
    return false;
  }

  if (Number(order.amount) !== Number(amount)) {
    respondError(
      res,
      id,
      -31001,
      msg('Неверная сумма', 'Incorrect amount', "Noto'g'ri summa")
    );
    return false;
  }

  return true;
}

function getPendingPaymentsForOrder(order) {
  const rows = db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' AND status = 'pending' ORDER BY created_at DESC"
  ).all();

  return rows.filter((payment) => {
    if (String(payment.order_id) === String(order.id)) return true;

    const meta = getPaymentMeta(payment);
    const metaOrderCode =
      getOrderCode(meta.account) ||
      meta.order_code ||
      meta.order ||
      null;

    return metaOrderCode && String(metaOrderCode) === String(order.order_code);
  });
}

function getActivePendingPayment(order) {
  const now = nowMs();
  const rows = getPendingPaymentsForOrder(order);
  return rows.find((p) => now - getPaymeTimeMs(p) <= PAYME_TIMEOUT_MS) || null;
}

// =========================
// CHECKOUT URL
// =========================

router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const merchantId = process.env.PAYME_MERCHANT_ID;
  if (!merchantId) {
    return res.status(500).json({ error: 'PAYME_MERCHANT_ID is missing' });
  }

  const params = `m=${merchantId};ac.order=${order.order_code};a=${order.amount};l=ru`;
  const encoded = Buffer.from(params).toString('base64');
  const base =
    process.env.NODE_ENV === 'production'
      ? 'https://checkout.paycom.uz'
      : 'https://test.paycom.uz';

  return res.json({
    checkout_url: `${base}/${encoded}`,
  });
});

// =========================
// JSON-RPC CALLBACK
// =========================

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

  const handlers = {
    CheckPerformTransaction,
    CreateTransaction,
    PerformTransaction,
    CancelTransaction,
    CheckTransaction,
    GetStatement,
  };

  if (!handlers[method]) {
    return respondError(
      res,
      id,
      -32601,
      msg('Метод не найден', 'Method not found', 'Metod topilmadi')
    );
  }

  try {
    return handlers[method](params || {}, id, res);
  } catch (err) {
    console.error('Payme RPC error:', err);
    return respondError(
      res,
      id,
      -32400,
      msg('Системная ошибка', 'System error', 'Tizim xatosi')
    );
  }
});

// =========================
// CheckPerformTransaction
// =========================

function CheckPerformTransaction({ amount, account }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  if (isOrderBlocked(order)) {
    return respondError(
      res,
      id,
      -31050,
      msg(
        'Заказ недоступен для оплаты',
        'Order is not available for payment',
        "Buyurtmani to'lash mumkin emas"
      ),
      'account.order'
    );
  }

  return res.json({
    result: {
      allow: true,
    },
    id,
  });
}

// =========================
// CreateTransaction
// =========================

function CreateTransaction({ id: paymeId, time, amount, account }, id, res) {
  const orderCode = getOrderCode(account);
  const order = getOrderOrAccountError(orderCode, res, id);
  if (!order) return;

  if (!checkAmount(order, amount, res, id)) return;

  const existing = getPaymentByPaymeId(paymeId);
  if (existing) {
    if (existing.status === 'failed') {
      return respondError(
        res,
        id,
        -31008,
        msg(
          'Невозможно выполнить операцию',
          'Unable to perform operation',
          "Amalni bajarib bo'lmaydi"
        )
      );
    }

    return res.json({
      result: {
        create_time: getPaymeTimeMs(existing),
        transaction: existing.id,
        state: getPaymentState(existing),
      },
      id,
    });
  }

  if (isOrderBlocked(order)) {
    return respondError(
      res,
      id,
      -31008,
      msg(
        'Невозможно выполнить операцию',
        'Unable to perform operation',
        "Amalni bajarib bo'lmaydi"
      )
    );
  }

  const active = getActivePendingPayment(order);
  if (active) {
    return respondError(
      res,
      id,
      -31008,
      msg(
        'Невозможно выполнить операцию',
        'Unable to perform operation',
        "Amalni bajarib bo'lmaydi"
      )
    );
  }

  const paymentId = uuidv4();
  const createTime = Number(time) || nowMs();
  const meta = {
    id: String(paymeId),
    time: createTime,
    amount: Number(amount),
    account: account || {},
    order_code: order.order_code,
    cancel_reason: null,
    cancel_state: null,
  };

  db.prepare(
    "INSERT INTO payments (id, order_id, provider, provider_transaction_id, amount, raw_payload, status, created_at, updated_at) VALUES (?, ?, 'payme', ?, ?, ?, 'pending', ?, ?)"
  ).run(
    paymentId,
    order.id,
    String(paymeId),
    Number(order.amount),
    JSON.stringify(meta),
    nowIso(),
    nowIso()
  );

  return res.json({
    result: {
      create_time: createTime,
      transaction: paymentId,
      state: 1,
    },
    id,
  });
}

// =========================
// PerformTransaction
// =========================

function PerformTransaction({ id: paymeId }, id, res) {
  const payment = getPaymentByPaymeId(paymeId);

  if (!payment) {
    return respondError(
      res,
      id,
      -31003,
      msg(
        'Транзакция не найдена',
        'Transaction not found',
        'Tranzaksiya topilmadi'
      )
    );
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
      msg(
        'Невозможно выполнить операцию',
        'Unable to perform operation',
        "Amalni bajarib bo'lmaydi"
      )
    );
  }

  const createdMs = getPaymeTimeMs(payment);
  if (nowMs() - createdMs > PAYME_TIMEOUT_MS) {
    const cancelTime = nowMs();
    const cancelIso = new Date(cancelTime).toISOString();

    db.prepare(
      "UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?"
    ).run(cancelIso, payment.id);

    writePaymentMeta(payment, {
      cancel_reason: 4,
      cancel_state: -1,
      cancel_time: cancelTime,
    });

    db.prepare(
      "UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?"
    ).run(cancelIso, payment.order_id);

    return respondError(
      res,
      id,
      -31008,
      msg(
        'Невозможно выполнить операцию',
        'Unable to perform operation',
        "Amalni bajarib bo'lmaydi"
      )
    );
  }

  const order = getOrderById(payment.order_id);
  if (!order) {
    return respondError(
      res,
      id,
      -31050,
      msg(
        'Заказ не найден',
        'Order not found',
        'Buyurtma topilmadi'
      ),
      'account.order'
    );
  }

  const status = normalizeStatus(order.status);
  if (['canceled', 'cancelled', 'failed'].includes(status)) {
    return respondError(
      res,
      id,
      -31008,
      msg(
        'Невозможно выполнить операцию',
        'Unable to perform operation',
        "Amalni bajarib bo'lmaydi"
      )
    );
  }

  const performTime = nowMs();
  const performIso = new Date(performTime).toISOString();

  db.prepare(
    "UPDATE payments SET status = 'success', updated_at = ? WHERE id = ?"
  ).run(performIso, payment.id);

  db.prepare(
    "UPDATE orders SET status = 'paid', updated_at = ? WHERE id = ?"
  ).run(performIso, payment.order_id);

  try {
    grantCourseAccess(order.id, order.user_id);
  } catch (e) {
    console.error('grantCourseAccess error:', e);
  }

  return res.json({
    result: {
      transaction: payment.id,
      perform_time: performTime,
      state: 2,
    },
    id,
  });
}

// =========================
// CancelTransaction
// =========================

function CancelTransaction({ id: paymeId, reason }, id, res) {
  const payment = getPaymentByPaymeId(paymeId);

  if (!payment) {
    return respondError(
      res,
      id,
      -31003,
      msg(
        'Транзакция не найдена',
        'Transaction not found',
        'Tranzaksiya topilmadi'
      )
    );
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

  // Если хочешь запретить отмену после оказания услуги:
  // if (payment.status === 'success') {
  //   return respondError(
  //     res,
  //     id,
  //     -31007,
  //     msg(
  //       'Невозможно отменить транзакцию. Услуга уже оказана',
  //       'Cannot cancel transaction. Service already provided',
  //       "Tranzaksiyani bekor qilib bo'lmaydi. Xizmat ko'rsatilgan"
  //     )
  //   );
  // }

  const cancelTime = nowMs();
  const cancelIso = new Date(cancelTime).toISOString();
  const wasPerformed = payment.status === 'success';
  const cancelState = wasPerformed ? -2 : -1;

  db.prepare(
    "UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?"
  ).run(cancelIso, payment.id);

  db.prepare(
    "UPDATE orders SET status = 'canceled', updated_at = ? WHERE id = ?"
  ).run(cancelIso, payment.order_id);

  db.prepare(
    'UPDATE access_grants SET is_active = 0 WHERE order_id = ?'
  ).run(payment.order_id);

  writePaymentMeta(payment, {
    cancel_reason: reason ?? null,
    cancel_state: cancelState,
    cancel_time: cancelTime,
  });

  return res.json({
    result: {
      transaction: payment.id,
      cancel_time: cancelTime,
      state: cancelState,
    },
    id,
  });
}

// =========================
// CheckTransaction
// =========================

function CheckTransaction({ id: paymeId }, id, res) {
  const payment = getPaymentByPaymeId(paymeId);

  if (!payment) {
    return respondError(
      res,
      id,
      -31003,
      msg(
        'Транзакция не найдена',
        'Transaction not found',
        'Tranzaksiya topilmadi'
      )
    );
  }

  return res.json({
    result: {
      create_time: getPaymeTimeMs(payment),
      perform_time:
        payment.status === 'success'
          ? new Date(payment.updated_at || payment.created_at).getTime()
          : 0,
      cancel_time:
        payment.status === 'failed'
          ? new Date(payment.updated_at || payment.created_at).getTime()
          : 0,
      transaction: payment.id,
      state: getPaymentState(payment),
      reason: payment.status === 'failed' ? getCancelReason(payment) : null,
    },
    id,
  });
}

// =========================
// GetStatement
// =========================

function GetStatement({ from, to }, id, res) {
  const fromMs = Number(from);
  const toMs = Number(to);

  if (!fromMs || !toMs || fromMs <= 0 || toMs <= 0) {
    return respondError(
      res,
      id,
      -31050,
      msg(
        'Неверный диапазон дат',
        'Invalid date range',
        "Noto'g'ri sana oralig'i"
      )
    );
  }

  const allPayments = db.prepare(
    "SELECT * FROM payments WHERE provider = 'payme' ORDER BY created_at ASC"
  ).all();

  const filtered = allPayments.filter((payment) => {
    const t = getPaymeTimeMs(payment);
    return t >= fromMs && t <= toMs;
  });

  return res.json({
    result: {
      transactions: filtered.map((payment) => {
        const meta = getPaymentMeta(payment);

        return {
          id: payment.provider_transaction_id,
          time: getPaymeTimeMs(payment),
          amount: Number(payment.amount),
          account: {
            order: getOrderCode(meta.account) || meta.order_code || meta.order || null,
          },
          create_time: getPaymeTimeMs(payment),
          perform_time:
            payment.status === 'success'
              ? new Date(payment.updated_at || payment.created_at).getTime()
              : 0,
          cancel_time:
            payment.status === 'failed'
              ? new Date(payment.updated_at || payment.created_at).getTime()
              : 0,
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