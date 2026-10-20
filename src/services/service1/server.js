require('dotenv').config();

const { startService } = require('../create-service');

startService('service1', process.env.SERVICE1_PORT || 4001);
