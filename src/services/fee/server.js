require('dotenv').config();

const { createFeeApp } = require('./service');
const port = Number(process.env.FEE_SERVICE_PORT || process.env.SERVICE1_PORT || 4001);

createFeeApp().listen(port, () => console.log(`Fee Service listening on port ${port}`));
