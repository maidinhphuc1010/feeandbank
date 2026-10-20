const express = require('express');
const { randomUUID } = require('node:crypto');

const DEFAULT_LIMIT = 20_000_000;

function envEnabled(...names) {
  return names.some((name) => ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase()));
}

function createBankApp() {
  const dropRate = Number(process.env.DROP_RATE || 0);
  const failRate = Number(process.env.FAIL_RATE || 0);
  if (![dropRate, failRate].every((rate) => Number.isFinite(rate) && rate >= 0 && rate <= 1)) {
    throw new Error('DROP_RATE and FAIL_RATE must be between 0 and 1');
  }
  const delayMs = Number(process.env.DELAY_MS || 0);
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 2147483647) {
    throw new Error('DELAY_MS must be a non-negative integer <= 2147483647');
  }
  const app = express();
  app.use(express.json());
  require('../../docs/swagger').mountSwagger(app, 'bank');
  const charges = new Map();
  const idempotency = new Map();
  const limit = Number(process.env.BANK_LIMIT || DEFAULT_LIMIT);
  let totalAmount = 0;

  app.get('/health', (_req, res) => res.json({ service: 'bank', status: 'ok' }));

  app.post('/charges', (req, res) => {
    if (envEnabled('BANK_FAIL', 'BANK_SIMULATE_ERROR', 'SIMULATE_BANK_ERROR')) {
      return res.status(503).json({ error: 'simulated bank failure' });
    }
    const key = req.get('Idempotency-Key');
    if (!key) return res.status(400).json({ error: 'Idempotency-Key header is required' });
    const { paymentId, studentId, amount } = req.body || {};
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount must be a positive integer' });
    }
    const fingerprint = JSON.stringify({ paymentId: paymentId ?? null, studentId: studentId ?? null, amount });
    if (idempotency.has(key)) {
      const prior = idempotency.get(key);
      if (prior.fingerprint !== fingerprint) {
        return res.status(409).json({ error: 'Idempotency-Key already used with a different request' });
      }
      if (Math.random() < dropRate) return req.socket.destroy();
      return res.status(prior.status).json(prior.body);
    }
    if (envEnabled('BANK_FAIL_NEXT', 'BANK_SIMULATE_FAILURE', 'SIMULATE_BANK_FAILURE')) {
      return res.status(503).json({ error: 'simulated charge failure' });
    }
    if (totalAmount + amount > limit) {
      return res.status(402).json({ error: 'bank charge limit exceeded', limit, totalAmount });
    }
    if (Math.random() < failRate) return res.status(503).json({ error: 'simulated transient failure' });
    const charge = {
      id: randomUUID(), paymentId: paymentId ?? null, studentId: studentId ?? null,
      amount, status: 'SUCCESS', createdAt: new Date().toISOString(),
    };
    totalAmount += amount;
    charges.set(charge.id, charge);
    const body = { charge };
    idempotency.set(key, { fingerprint, status: 201, body });
    if (Math.random() < dropRate) return req.socket.destroy();
    // Commit before delaying the response: client timeout is not a rollback.
    // Cached idempotent replays above return immediately, without another charge.
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        if (!res.destroyed) res.status(201).json(body);
      }, delayMs);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    return res.status(201).json(body);
  });

  app.get('/charges', (_req, res) => res.json([...charges.values()]));

  app.get('/stats', (_req, res) => res.json({
    totalCharges: charges.size,
    totalAmount,
    limit,
    remainingLimit: Math.max(0, limit - totalAmount),
  }));

  return app;
}

module.exports = { createBankApp, DEFAULT_LIMIT };
