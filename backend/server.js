// server.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const { initDatabase } = require('./db/init');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storageDir = path.join(__dirname, 'storage', 'lessons');
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

async function start() {
  await initDatabase();

  app.use('/api/orders',             require('./routes/orders'));
  app.use('/api/lessons',            require('./routes/lessons'));
  app.use('/api/payments/click',     require('./routes/click'));
  app.use('/api/payments/payme',     require('./routes/payme'));
  app.use('/api/access',             require('./routes/access'));

  app.use((_, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, _, res, __) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

  app.listen(PORT, () => {
    console.log('');
    console.log('🚀 Skillcraft Backend запущен!');
    console.log(`📡 http://localhost:${PORT}`);
    console.log('');
    console.log('Click endpoints:');
    console.log(`  Prepare:  POST http://localhost:${PORT}/api/payments/click/prepare`);
    console.log(`  Complete: POST http://localhost:${PORT}/api/payments/click/complete`);
    console.log(`  Checkout: GET  http://localhost:${PORT}/api/payments/click/checkout-url`);
    console.log(`  CardPay:  GET  http://localhost:${PORT}/api/payments/click/card-url`);
    console.log('');
    console.log('');
  });
}

start().catch(e => { console.error('Start failed:', e); process.exit(1); });
