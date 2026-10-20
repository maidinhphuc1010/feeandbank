require('dotenv').config();

const { startService } = require('../create-service');

startService('service2', process.env.SERVICE2_PORT || 4002);
