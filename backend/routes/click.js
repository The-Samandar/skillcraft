const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/init');
const { grantCourseAccess } = require('../services/accessService');

router.get('/checkout-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs  = order.amount / 100;
  const returnUrl  = process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  const url =
    `https://my.click.uz/services/pay` +
    `?service_id=${process.env.CLICK_SERVICE_ID}` +
    `&merchant_id=${process.env.CLICK_MERCHANT_ID}` +
    `&amount=${amountUzs}` +
    `&transaction_param=${order.order_code}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  res.json({ checkout_url: url });
});

router.get('/card-url', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const amountUzs = order.amount / 100;
  const returnUrl = process.env.CLICK_RETURN_URL || `${process.env.FRONTEND_URL}/success.html`;

  // Ссылка для оплаты картой без регистрации в Click
  const url =
    `https://my.click.uz/pay-by-card` +
    `?service_id=${process.env.CLICK_SERVICE_ID}` +
    `&merchant_id=${process.env.CLICK_MERCHANT_ID}` +
    `&amount=${amountUzs}` +
    `&transaction_param=${order.order_code}` +
    `&return_url=${encodeURIComponent(returnUrl)}`;

  res.json({ checkout_url: url });
});

function verifySign(body, action) {
  const secret = process.env.CLICK_SECRET_KEY; 

  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    merchant_prepare_id = '',
    amount,
    sign_time,
    sign_string,
  } = body;

  let signStr;
  if (parseInt(action) === 0) {
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${amount}${action}${sign_time}`;
  } else {
    signStr = `${click_trans_id}${service_id}${secret}${merchant_trans_id}${merchant_prepare_id}${amount}${action}${sign_time}`;
  }

  const expected = crypto.createHash('md5').update(signStr).digest('hex');
  const valid = sign_string === expected;

  if (!valid) {
    console.error('❌ Click sign mismatch');
    console.error('   Expected:', expected);
    console.error('   Got:     ', sign_string);
  }

  return valid;
}

router.post('/prepare', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    service_id,
    merchant_trans_id,
    amount,
    action,
  } = req.body;

  console.log('📥 Click PREPARE:', { merchant_trans_id, amount, click_trans_id });

  // проверка подписи
  if (!verifySign(req.body, 0)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  // проверяем service_id
  if (String(service_id) !== String(process.env.CLICK_SERVICE_ID)) {
    return res.json({ error: -6, error_note: 'Permission denied' });
  }

  //  находим заказ по order_code
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  //  уже оплачен?
  if (order.status === 'paid') {
    return res.json({ error: -4, error_note: 'Already paid' });
  }

  // проверяем сумму 
  const expectedUzs = order.amount / 100;
  if (Math.abs(parseFloat(amount) - expectedUzs) > 0.01) {
    console.error(`❌ Amount mismatch: expected ${expectedUzs}, got ${amount}`);
    return res.json({ error: -2, error_note: 'Incorrect parameter amount' });
  }

  // Создаём запись о платеже
  const paymentId = uuidv4();
  db.prepare(
    "INSERT INTO payments (id,order_id,provider,provider_transaction_id,amount,raw_payload,status) VALUES (?,?,'click',?,?,?,'pending')"
  ).run(paymentId, order.id, click_trans_id, order.amount, JSON.stringify(req.body));

  console.log(`✅ Click Prepare OK — order: ${merchant_trans_id}, payment: ${paymentId}`);

  return res.json({
    click_trans_id,
    merchant_trans_id,
    merchant_prepare_id: paymentId,
    error: 0,
    error_note: 'Success',
  });
});

router.post('/complete', require('express').urlencoded({ extended: true }), (req, res) => {
  const {
    click_trans_id,
    merchant_trans_id,
    merchant_prepare_id,
    amount,
    error: clickError,
  } = req.body;

  console.log('📥 Click COMPLETE:', { merchant_trans_id, clickError, click_trans_id });

  // проверка подписи
  if (!verifySign(req.body, 1)) {
    return res.json({ error: -1, error_note: 'SIGN CHECK FAILED!' });
  }

  // находим заказ
  const order = db.prepare('SELECT * FROM orders WHERE order_code = ?').get(merchant_trans_id);
  if (!order) {
    return res.json({ error: -5, error_note: 'User does not exist' });
  }

  // находим payment из Prepare
  const payment = db.prepare(
    "SELECT * FROM payments WHERE id = ? AND provider = 'click'"
  ).get(merchant_prepare_id);
  if (!payment) {
    return res.json({ error: -6, error_note: 'Transaction does not exist' });
  }

  // оплата не прошла
  if (parseInt(clickError) < 0) {
    db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id);
    db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(payment.id);
    console.log(`❌ Click payment FAILED: ${merchant_trans_id}`);
    return res.json({
      click_trans_id,
      merchant_trans_id,
      merchant_confirm_id: null,
      error: 0,
      error_note: 'Success',
    });
  }

  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(order.id);
  db.prepare(
    "UPDATE payments SET status='success', provider_transaction_id=? WHERE id=?"
  ).run(click_trans_id, payment.id);

  grantCourseAccess(order.id, order.user_id);

  console.log(`✅✅ Click payment SUCCESS: ${merchant_trans_id}`);

  return res.json({
    click_trans_id,
    merchant_trans_id,
    merchant_confirm_id: order.id,
    error: 0,
    error_note: 'Success',
  });
});

module.exports = router;
