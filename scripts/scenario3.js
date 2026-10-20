const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const { createFeeApp } = require('../src/services/fee/service');
const { createBankApp } = require('../src/services/bank/service');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
async function call(base, path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  // Isolated, reproducible benchmark: no error simulation or existing data.
  process.env.DELAY_MS = '0';
  process.env.DROP_RATE = '0';
  process.env.FAIL_RATE = '0';
  process.env.BANK_LIMIT = '20000000';
  for (const key of ['BANK_FAIL', 'BANK_SIMULATE_ERROR', 'SIMULATE_BANK_ERROR',
    'BANK_FAIL_NEXT', 'BANK_SIMULATE_FAILURE', 'SIMULATE_BANK_FAILURE']) process.env[key] = 'false';
  const bank = createServer(createBankApp());
  bank.keepAliveTimeout = 5000;
  bank.headersTimeout = 60000;
  let tcpConnections = 0;
  bank.on('connection', () => { tcpConnections++; });
  const bankUrl = await listen(bank);
  const app = createFeeApp({ bankUrl });
  const fee = createServer(app);
  const base = await listen(fee);
  try {
    // Setup uses Fee only; no monitoring requests contaminate Bank TCP counts.
    for (let i = 0; i <= 200; i++) {
      assert.equal((await call(base, `/students/load-${i}/debt`, 'PUT', { amount: 1000 })).status, 200);
    }
    let next = 0;
    const results = [];
    const start = performance.now();
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (next < 200) {
        const id = next++;
        const begin = performance.now();
        const result = await call(base, '/payments', 'POST', { studentId: `load-${id}` });
        results.push({ ...result, ms: performance.now() - begin });
      }
    }));
    const durationMs = performance.now() - start;
    const batchConnections = tcpConnections;
    const successful = results.filter((r) => r.status === 201 && r.body.status === 'PAID' && r.body.amount === 1000).length;
    assert.equal(successful, 200);
    assert.equal(new Set(results.map((r) => r.body.transactionId)).size, 200);
    assert.ok(batchConnections <= 20, `TCP count: ${batchConnections}`);
    // Absolutely no requests to Fee or Bank during this interval.
    const idleStart = performance.now();
    await sleep(6000);
    const idleMs = performance.now() - idleStart;
    const begin = performance.now();
    const afterIdle = await call(base, '/payments', 'POST', { studentId: 'load-200' });
    const afterIdleMs = performance.now() - begin;
    const totalConnections = tcpConnections;
    assert.equal(afterIdle.status, 201);
    assert.equal(afterIdle.body.status, 'PAID');
    assert.ok(totalConnections <= 20);
    // Stats request happens AFTER connection snapshots.
    const stats = await call(bankUrl, '/stats');
    assert.equal(stats.body.totalCharges, 201);
    assert.equal(stats.body.totalAmount, 201000);
    const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
    console.log(JSON.stringify({
      node: process.version, count: 200, concurrency: 10, amount: 1000,
      successful, batchAmount: 200000, durationMs: +durationMs.toFixed(1),
      p95Ms: +latencies[189].toFixed(1), maxMs: +latencies[199].toFixed(1),
      newTcpConnections: batchConnections, idleMs: +idleMs.toFixed(1),
      afterIdleStatus: afterIdle.status, afterIdleMs: +afterIdleMs.toFixed(1),
      newTcpAfterIdle: totalConnections - batchConnections,
      totalTcpIncludingIdlePayment: totalConnections,
      totalCharges: stats.body.totalCharges, totalAmount: stats.body.totalAmount,
    }, null, 2));
  } finally {
    app.locals.closeBankClient();
    await close(fee);
    await close(bank);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
