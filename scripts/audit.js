const { createServer } = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const { createFeeApp } = require('../src/services/fee/service');
const { createBankApp } = require('../src/services/bank/service');
const rows = [];
async function call(base, route, method = 'GET', body) {
  const start = performance.now();
  const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return { status: r.status, body: await r.json(), ms: +(performance.now() - start).toFixed(2) };
}
async function listen(s, port = 0) {
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${s.address().port}`;
}
async function close(s) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
async function fixture(env, fn) {
  Object.assign(process.env, { DELAY_MS: '0', DROP_RATE: '0', FAIL_RATE: '0', BANK_LIMIT: '20000000',
    BANK_FAIL: 'false', BANK_FAIL_NEXT: 'false', BANK_SIMULATE_ERROR: 'false', SIMULATE_BANK_ERROR: 'false',
    BANK_SIMULATE_FAILURE: 'false', SIMULATE_BANK_FAILURE: 'false' }, env);
  const app = createBankApp();
  let tcp = 0; let attempts = 0;
  const bank = createServer((req, res) => { if (req.method === 'POST') attempts++; app(req, res); });
  bank.on('connection', () => tcp++);
  const bankUrl = await listen(bank);
  const feeApp = createFeeApp({ bankUrl });
  const fee = createServer(feeApp);
  const base = await listen(fee);
  const ctx = { base, bank, bankUrl, counts: () => ({ tcp, attempts }),
    seed: (id, amount = 1000) => call(base, `/students/${id}/debt`, 'PUT', { amount }),
    pay: (id) => call(base, '/payments', 'POST', { studentId: id }),
    debt: async (id) => (await call(base, `/students/${id}/debt`)).body.debt };
  try { await fn(ctx); } finally { feeApp.locals.closeBankClient(); await close(fee); await close(bank); }
}
async function record(name, c, results, ids, checks) {
  const counts = c.counts(); // Snapshot before monitoring opens connections.
  const charges = (await call(c.bankUrl, '/charges')).body;
  const stats = (await call(c.bankUrl, '/stats')).body;
  const duplicates = charges.length - new Set(charges.map((x) => x.paymentId)).size;
  const debts = await Promise.all(ids.map((id) => c.debt(id)));
  const statuses = {};
  results.forEach((r) => { statuses[r.status] = (statuses[r.status] || 0) + 1; });
  checks['no duplicate charge'] = duplicates === 0;
  checks['Bank totals consistent'] = stats.totalAmount === charges.reduce((a, x) => a + x.amount, 0);
  rows.push({ name, statuses, maxMs: Math.max(...results.map((r) => r.ms)), ...counts,
    charges: charges.length, duplicates, bankAmount: stats.totalAmount,
    debt: debts.reduce((a, b) => a + b, 0), checks,
    result: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL' });
}
async function run() {
  await fixture({}, async (c) => {
    await c.seed('s'); const port = c.bank.address().port; await close(c.bank);
    const down = await c.pay('s'); const read = await call(c.base, '/students/s/debt');
    await listen(c.bank, port); const up = await c.pay('s');
    await record('1: Bank down/up', c, [down, up], ['s'], {
      '503 under 1500ms': down.status === 503 && down.ms < 1500,
      'GET alive, debt unchanged': read.status === 200 && read.body.debt === 1000,
      '201 without Fee restart': up.status === 201 && await c.debt('s') === 0,
    });
  });
  await fixture({ DELAY_MS: '5000' }, async (c) => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    await Promise.all(ids.map((id) => c.seed(id)));
    let completed = 0;
    const pending = Promise.all(ids.map((id) => c.pay(id).finally(() => completed++)));
    const start = performance.now();
    while (c.counts().attempts < 20 && performance.now() - start < 900) await sleep(5);
    const reads = await Promise.all(ids.map((id) => call(c.base, `/students/${id}/debt`)));
    const concurrent = completed === 0 && c.counts().attempts === 20;
    const results = await pending;
    await record('2: delay 5000, concurrency 20', c, results, ids, {
      '504 PENDING <=4500ms': results.every((r) => r.status === 504 && r.body.payment.status === 'PENDING' && r.ms <= 4500),
      [`concurrent GET max ${Math.max(...reads.map((r) => r.ms))}ms <300`]: concurrent && reads.every((r) => r.status === 200 && r.ms < 300 && r.body.debt === 1000),
      'all debt unchanged': (await Promise.all(ids.map((id) => c.debt(id)))).every((d) => d === 1000),
    });
  });
  await load();
  await faults();
}


async function load() {
  await fixture({}, async (c) => {
    const ids = Array.from({ length: 201 }, (_, i) => `s${i}`);
    for (const id of ids) await c.seed(id);
    const results = []; let next = 0;
    await Promise.all(Array.from({ length: 10 }, async () => {
      while (next < 200) results.push(await c.pay(ids[next++]));
    }));
    const tcp = c.counts().tcp;
    await sleep(6000);
    const after = await c.pay(ids[200]);
    await record('3: batch 200 + idle payment', c, [...results, after], ids, {
      '200/200 HTTP 201': results.length === 200 && results.every((r) => r.status === 201),
      [`batch TCP ${tcp} <=20`]: tcp <= 20,
      'idle 6000ms then 201': after.status === 201,
      'all debts zero': (await Promise.all(ids.map((id) => c.debt(id)))).every((d) => d === 0),
    });
  });
}
async function faults() {
  for (const mode of ['DROP', 'FAIL']) {
    await fixture({ [`${mode}_RATE`]: '0.3' }, async (c) => {
      const ids = []; const results = []; let correct = true;
      for (let i = 0; i < 60; i++) {
        const id = `s${i}`; ids.push(id); await c.seed(id);
        const r = await c.pay(id); results.push(r);
        correct &&= await c.debt(id) === (r.status === 201 ? 0 : 1000);
      }
      await record(`4: ${mode}=0.3`, c, results, ids, {
        '>=54/60 HTTP 201': results.filter((r) => r.status === 201).length >= 54,
        '<=4500ms': results.every((r) => r.ms <= 4500),
        'unknown = 504 PENDING': results.every((r) => r.status === 201 || (r.status === 504 && r.body.payment.status === 'PENDING')),
        'exact student debts': correct,
      });
    });
  }
  await fixture({}, async (c) => {
    await c.seed('large', 25000000); const r = await c.pay('large');
    await record('4: 25 million', c, [r], ['large'], {
      '402, one attempt': r.status === 402 && c.counts().attempts === 1,
      'debt unchanged': await c.debt('large') === 25000000,
      '<=4500ms': r.ms <= 4500,
    });
  });
}
async function main() {
  const dir = path.join(__dirname, '..', 'reports'); fs.mkdirSync(dir, { recursive: true });
  let error;
  try { await run(); } catch (e) { error = e.stack; }
  const data = { timestamp: new Date().toISOString(), node: process.version, platform: process.platform, rows, error };
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(data, null, 2));
  const lines = ['# Lab 3 — Báo cáo kiểm thử thực tế', '', `UTC: ${data.timestamp}; Node ${data.node}; ${data.platform}.`, '',
    'HTTP loopback, hai server cùng tiến trình, dữ liệu mới mỗi tình huống. TCP đếm tại Bank trước request giám sát; không gồm client → Fee. Duplicates tính theo paymentId; debt là tổng công nợ. TH3 gồm 200 payment và 1 payment sau idle.', '',
    '| Tình huống | HTTP | Max ms | TCP | Attempts | Charges | Duplicates | Bank amount | Debt | Kết quả |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const r of rows) lines.push(`| ${r.name} | ${JSON.stringify(r.statuses)} | ${r.maxMs} | ${r.tcp} | ${r.attempts} | ${r.charges} | ${r.duplicates} | ${r.bankAmount} | ${r.debt} | ${r.result} |`);
  for (const r of rows) {
    lines.push('', `## ${r.name}`);
    for (const [criterion, pass] of Object.entries(r.checks)) lines.push(`- **${pass ? 'PASS' : 'FAIL'}**: ${criterion}`);
  }
  lines.push('', '## Trước/sau tối ưu', '',
    'Baseline trước tối ưu: **N/A**. Không có snapshot mã nguồn hoặc số liệu đủ kiểm chứng để chạy A/B. Không bịa số liệu trước tối ưu. Các mốc lịch sử sau đây đều đã tối ưu, không dùng để suy ra tăng tốc:', '',
    '| Mốc | Số liệu lịch sử |', '|---|---|',
    '| TH1 | Bank tắt 14,8ms; timeout 1026,5ms |',
    '| TH2 | 20 payment max 1128,8ms; GET max 5,8ms |',
    '| TH3 | 200/200; TCP 10; sau idle 6014,9ms HTTP 201 |',
    '| TH4 | DROP 60/60 max 402,8ms; FAIL 60/60 max 170,7ms |', '',
    'Số liệu hiện tại ở bảng đầu báo cáo. Tải máy và lỗi ngẫu nhiên thay đổi giữa các lần đo; không bảo đảm tuyệt đối ≥54/60.', '',
    '## Sửa lỗi rà soát', '',
    '- Cô lập DROP_RATE/FAIL_RATE trong script scenario3 khỏi ENV bên ngoài.',
    '- Chặn PATCH ép trạng thái FAILED sang PAID không có Bank xác nhận; không ghi đè transactionId đã xác nhận.',
    '- Sửa mô tả BANK_FAIL_NEXT: cờ tĩnh, không phải one-off.', '',
    'Chạy `npm run verify`: regression và audit. Dữ liệu in-memory mất khi restart. Chưa có file đề gốc để nghiệm thu ngoài các tiêu chí người dùng đã cung cấp.');
  if (error) lines.push('', '## Execution error', '```', error, '```');
  fs.writeFileSync(path.join(dir, 'REPORT.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  if (error || rows.length !== 6 || rows.some((r) => r.result === 'FAIL')) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
