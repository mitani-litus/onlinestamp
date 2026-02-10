const { v4: uuidv4 } = require('uuid');

function userCookie(req, res, next) {
  // すでにCookieに userId がある場合はそれを使用
  let userId = req.cookies.userId;
  
  if (!userId) {
    userId = uuidv4(); // 新しいUUIDを発行
    res.cookie('userId', userId, {
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30日
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production'
    });
  }

  req.userId = userId;
  next();
}

module.exports = userCookie;
