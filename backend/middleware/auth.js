// middleware/auth.js — JWT проверка
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'change_in_production';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
  try {
    req.user = jwt.verify(header.split(' ')[1], SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function generateToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
}

module.exports = { requireAuth, generateToken };
