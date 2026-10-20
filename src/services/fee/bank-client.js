const http = require('node:http');
const https = require('node:https');

function createBankClient() {
  const options = {
    keepAlive: true, keepAliveMsecs: 1000,
    maxSockets: 20, maxTotalSockets: 20, maxFreeSockets: 10,
    scheduling: 'lifo', timeout: 4000,
  };
  const agents = { 'http:': new http.Agent(options), 'https:': new https.Agent(options) };

  function charge(url, payment, signal) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'https:' ? https : http;
      const body = JSON.stringify({ paymentId: payment.id, studentId: payment.studentId, amount: payment.amount });
      const req = transport.request(target, {
        method: 'POST', agent: agents[target.protocol], signal,
        headers: {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          'Idempotency-Key': payment.id,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  async function chargeWithRetry(url, payment, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await charge(url, payment, signal);
        if (response.status < 500) return response;
        throw new Error('Bank temporarily unavailable');
      } catch (error) {
        if (signal.aborted || error.code === 'ECONNREFUSED') {
          if (attempt > 0) error.outcomeUnknown = true;
          throw error;
        }
        if (attempt === 3) {
          error.outcomeUnknown = true;
          throw error;
        }
        await require('node:timers/promises').setTimeout(50 * (2 ** attempt), undefined, { signal });
      }
    }
  }

  return { charge: chargeWithRetry, close() { Object.values(agents).forEach((agent) => agent.destroy()); } };
}

module.exports = { createBankClient };
