const swaggerUi = require('swagger-ui-express');
const str = { type: 'string' };
const money = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = []) => ({ type: 'object', properties, required });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const body = (schema) => ({ required: true, content: json(schema) });
const param = (name) => ({ name, in: 'path', required: true, schema: str });
const errors = (...codes) => Object.fromEntries(codes.map((code) => [code, response({
  400: 'Invalid input', 402: 'Bank limit exceeded; no retry', 404: 'Not found',
  409: 'Conflict', 503: 'Bank unavailable', 504: 'Outcome unknown; PENDING, debt unchanged',
}[code], ref('Error'))]));
const schemas = {
  Debt: object({ studentId: str, debt: money }, ['studentId', 'debt']),
  Payment: object({ id: { type: 'string', example: 'P1' }, studentId: str, amount: money,
    status: { type: 'string', enum: ['PENDING', 'PAID', 'FAILED'] },
    transactionId: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } }),
  Charge: object({ id: str, paymentId: { ...str, nullable: true }, studentId: { ...str, nullable: true },
    amount: money, status: { type: 'string', enum: ['SUCCESS'] }, createdAt: { type: 'string', format: 'date-time' } }),
  Error: object({ error: str, payment: ref('Payment'), limit: money, totalAmount: money }, ['error']),
};
const health = { get: { summary: 'Health check', responses: { 200: response('Healthy', object({ service: str, status: str })) } } };
const feePaths = {
  '/health': health,
  '/students/{studentId}/debt': {
    parameters: [param('studentId')],
    put: { summary: 'Create/replace student debt', requestBody: body(object({ amount: { ...money, example: 1000 } }, ['amount'])),
      responses: { 200: response('Debt saved', ref('Debt')), ...errors(400, 409) } },
    get: { summary: 'Read student debt', responses: { 200: response('Debt', ref('Debt')), ...errors(404) } },
  },
  '/payments': {
    post: { summary: 'Pay outstanding debt through Bank',
      description: 'Retries up to 4 attempts with the same Idempotency-Key within 1000ms. Retry a PENDING payment by posting the same studentId. Only confirmed success reduces debt.',
      requestBody: body(object({ studentId: { ...str, example: 's1' } }, ['studentId'])),
      responses: { 201: response('PAID', ref('Payment')), ...errors(400, 402, 404, 409, 503, 504) } },
    get: { summary: 'List payments', responses: { 200: response('Payments', { type: 'array', items: ref('Payment') }) } },
  },
  '/payments/{paymentId}': { get: { summary: 'Read payment', parameters: [param('paymentId')],
    responses: { 200: response('Payment', ref('Payment')), ...errors(404) } } },
  '/payments/{paymentId}/status': { patch: { summary: 'Update payment status (restricted)',
    description: 'Pending reconciliation blocks PATCH. Cannot force PAID without Bank confirmation or revert PAID. Same status is a no-op.',
    parameters: [param('paymentId')], requestBody: body(object({ status: { type: 'string', enum: ['PENDING', 'PAID', 'FAILED'] }, transactionId: str }, ['status'])),
    responses: { 200: response('Payment', ref('Payment')), ...errors(400, 404, 409) } } },
};
const bankPaths = {
  '/health': health,
  '/charges': {
    post: { summary: 'Charge with idempotency', description: 'Same key and payload replay the saved charge; changed payload returns 409. DELAY_MS delays new responses; DROP_RATE drops connections after commit; FAIL_RATE returns 503 before commit.',
      parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { ...str, example: 'manual-P1' } }],
      requestBody: body(object({ amount: { ...money, minimum: 1, example: 1000 }, paymentId: { ...str, example: 'P1' }, studentId: { ...str, example: 's1' } }, ['amount'])),
      responses: { 201: response('Charge saved or replayed', object({ charge: ref('Charge') })), ...errors(400, 402, 409, 503) } },
    get: { summary: 'List charges', responses: { 200: response('Charges', { type: 'array', items: ref('Charge') }) } },
  },
  '/stats': { get: { summary: 'Bank totals', responses: { 200: response('Statistics', object({ totalCharges: money, totalAmount: money, limit: money, remainingLimit: money })) } } },
};
function mountSwagger(app, service) {
  const spec = { openapi: '3.0.3', info: { title: `Lab 3 ${service === 'fee' ? 'Fee' : 'Bank'} Service`, version: '1.0.0',
    description: 'In-memory demo. Try it out modifies live data. Amounts are integer VND.' },
    servers: [{ url: '/' }], paths: service === 'fee' ? feePaths : bankPaths, components: { schemas } };
  app.get('/openapi.json', (_req, res) => res.json(spec));
  app.use('/api-docs', swaggerUi.serveFiles(spec), swaggerUi.setup(spec, { swaggerOptions: { validatorUrl: null } }));
}
module.exports = { mountSwagger };
