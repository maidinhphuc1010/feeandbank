const express = require('express');

function startService(name, port) {
  const app = express();
  app.use(express.json());

  // Placeholder only: no Lab 3 business routes have been implemented.
  app.get('/health', (_req, res) => {
    res.json({ service: name, status: 'ok' });
  });

  const server = app.listen(Number(port), () => {
    console.log(`${name} listening on port ${port}`);
  });

  server.on('error', (error) => {
    console.error(`${name} failed to start:`, error.message);
    process.exitCode = 1;
  });

  return server;
}

module.exports = { startService };
