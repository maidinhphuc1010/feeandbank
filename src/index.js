require('dotenv').config();

const { createFeeApp } = require('./services/fee/service');
const { createBankApp } = require('./services/bank/service');

const feePort = Number(process.env.FEE_SERVICE_PORT || process.env.SERVICE1_PORT || 4001);
const bankPort = Number(process.env.BANK_SERVICE_PORT || process.env.SERVICE2_PORT || 4002);

createFeeApp().listen(feePort, () => console.log(`Fee Service listening on port ${feePort}`));
createBankApp().listen(bankPort, () => console.log(`Bank Service listening on port ${bankPort}`));
