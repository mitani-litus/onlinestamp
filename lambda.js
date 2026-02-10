// lambda.js
const serverlessExpress = require('@vendia/serverless-express');
const app = require('./src/index'); 
module.exports.handler = serverlessExpress({ app });
