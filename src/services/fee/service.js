const express = require('express');
const { randomUUID } = require('node:crypto');

function createFeeApp({ bankUrl = process.env.BANK_URL || 'http://127.0.0.1:4002' } = {}) {
  const { createBankClient } = require('./bank-client');
  const bankClient = createBankClient();
  const app = express();
  app.locals.closeBankClient = () => bankClient.close();
  app.use(express.json());
  require('../../docs/swagger').mountSwagger(app, 'fee');
  const students = new Map();
  const payments = new Map();
  let nextPaymentId = 1;

  app.get('/health', (_req, res) => res.json({ service: 'fee', status: 'ok' }));

  // Create or replace a student's in-memory debt account.
  app.put('/students/:studentId/debt', (req, res) => {
    const { studentId } = req.params;
    const amount = Number(req.body?.amount);
    if (!studentId || !Number.isSafeInteger(amount) || amount < 0) {
      return res.status(400).json({ error: 'amount must be a non-negative integer' });
    }
    if (pendingByStudent.has(studentId)) {
      return res.status(409).json({ error: 'cannot replace debt while payment outcome is pending' });
    }
    const account = { studentId, debt: amount };
    students.set(studentId, account);
    return res.status(200).json(account);
  });

  app.get('/students/:studentId/debt', (req, res) => {
    const account = students.get(req.params.studentId);
    if (!account) return res.status(404).json({ error: 'student not found' });
    return res.json(account);
  });

  const inFlight = new Set();
  const pendingByStudent = new Map();

  app.post('/payments', async (req, res) => {
    const { studentId } = req.body || {};
    const account = students.get(studentId);
    if (!account) return res.status(404).json({ error: 'student debt account not found' });
    if (account.debt <= 0) return res.status(409).json({ error: 'no outstanding debt' });
    if (inFlight.has(studentId)) return res.status(409).json({ error: 'payment in progress' });
    const payment = pendingByStudent.get(studentId) || {
      id: `P${nextPaymentId++}`,
      studentId,
      amount: account.debt,
      status: 'PENDING',
      transactionId: null,
      createdAt: new Date().toISOString(),
    };
    payments.set(payment.id, payment);
    pendingByStudent.set(studentId, payment);
    inFlight.add(studentId);
    const signal = AbortSignal.timeout(1000);
    try {
      const response = await bankClient.charge(`${bankUrl.replace(/\/$/, '')}/charges`, payment, signal);
      if (response.status >= 500) throw new Error('Bank unavailable');
      const result = response.data;
      if (!response.ok) {
        payment.status = 'FAILED';
        pendingByStudent.delete(studentId);
        return res.status(response.status).json({ error: result.error || 'Charge rejected', payment });
      }
      if (result.charge?.status !== 'SUCCESS' || !result.charge.id) {
        throw new Error('Invalid bank response');
      }
      payment.status = 'PAID';
      payment.transactionId = result.charge.id;
      account.debt = Math.max(0, account.debt - payment.amount);
      pendingByStudent.delete(studentId);
      return res.status(201).json(payment);
    } catch (_error) {
      // A timeout can happen after the bank charged: retain PENDING and reuse its key.
      const timedOut = signal.aborted || _error.outcomeUnknown === true;
      return res.status(timedOut ? 504 : 503).json({
        error: timedOut ? 'Bank timeout; transaction outcome unknown' : 'Bank unavailable; retry later',
        payment,
      });
    } finally {
      inFlight.delete(studentId);
    }
  });

  app.get('/payments', (_req, res) => res.json([...payments.values()]));

  app.get('/payments/:paymentId', (req, res) => {
    const payment = payments.get(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });
    return res.json(payment);
  });

  app.patch('/payments/:paymentId/status', (req, res) => {
    const payment = payments.get(req.params.paymentId);
    if (!payment) return res.status(404).json({ error: 'payment not found' });
    if (pendingByStudent.has(payment.studentId)) {
      return res.status(409).json({ error: 'pending payment must be reconciled through the bank' });
    }
    const { status, transactionId } = req.body || {};
    if (!['PENDING', 'PAID', 'FAILED'].includes(status)) {
      return res.status(400).json({ error: 'status must be PENDING, PAID, or FAILED' });
    }
    if (status === payment.status) return res.json(payment);
    if (status === 'PAID') return res.status(409).json({ error: 'Bank confirmation required; use POST /payments' });
    if (payment.status === 'PAID' && status !== 'PAID') {
      return res.status(409).json({ error: 'paid payment cannot change status' });
    }
    if (status === 'PAID' && payment.status !== 'PAID') {
      const account = students.get(payment.studentId);
      account.debt = Math.max(0, account.debt - payment.amount);
    }
    payment.status = status;
    if (transactionId !== undefined) payment.transactionId = String(transactionId);
    if (status === 'PAID' && !payment.transactionId) payment.transactionId = randomUUID();
    return res.json(payment);
  });

  return app;
}

module.exports = { createFeeApp };
