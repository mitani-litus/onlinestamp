const auth = require('basic-auth');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

function adminAuth(req, res, next) {
  console.log('adminAuth middleware called');
  const credentials = auth(req);

  if (
    !credentials ||
    credentials.name !== ADMIN_USER ||
    credentials.pass !== ADMIN_PASS
  ) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  next();
}

module.exports = adminAuth;
