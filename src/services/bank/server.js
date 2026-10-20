require('dotenv').config();

const { createBankApp } = require('./service');
const port = Number(process.env.BANK_SERVICE_PORT || process.env.SERVICE2_PORT || 4002);

createBankApp().listen(port, () => console.log(`Bank Service listening on port ${port}`));
