// src/index.js
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const adminRoutes = require('./routes/admin');
const adminAuth = require('./middleware/adminAuth');
const userCookie = require('./middleware/userCookie');

// S3 設定
const s3 = new S3Client({ region: 'ap-northeast-1' });
const BUCKET_NAME = process.env.STAMP_BUCKET;
const STAMP_FILE = 'stamp-names.json';
const PORT = process.env.PORT || 3000;

// ★ app の定義を最初に移動
const app = express();

// ★ trust proxy と baseUrlFull の設定
app.set('trust proxy', true);
app.use((req, res, next) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host =
   req.get('x-forwarded-host') ||
   req.get('host') ||
   (req.headers && (req.headers['x-forwarded-host'] || req.headers.host));
   req.baseUrlFull = `${proto}://${host}`;
  next();
});

// ミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(cookieParser());
app.use(userCookie);
app.use(express.static(path.join(__dirname, '../public')));
app.set('views', path.join(__dirname, '../views'));
app.set('view engine', 'ejs');

// debug
app.locals.compileDebug = true;
app.locals.rmWhitespace = false;

// 管理画面認証
app.use('/admin', adminAuth, adminRoutes);

// userIdをCookieで保持
app.use((req, res, next) => {
  if (!req.cookies.userId) {
    const newId = uuidv4();
    res.cookie('userId', newId, { maxAge: 365 * 24 * 60 * 60 * 1000 });
    req.userId = newId;
  } else {
    req.userId = req.cookies.userId;
  }
  next();
});

// ユーザーデータ保存先
const getUserDataPath = (userId) => path.join('/tmp', `stamps-${userId}.json`);

// S3 から JSON 読み込み
async function loadJsonFromS3(key) {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    return await streamToString(data.Body).then(JSON.parse);
  } catch (e) {
    console.error(`Failed to load ${key} from S3`, e);
    return {};
  }
}

// S3からユーザースタンプデータを読み込み
async function loadUserStamps(userId) {
  try {
    const data = await s3.send(new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `user-stamps/${userId}.json`
    }));
    const content = JSON.parse(await data.Body.transformToString());
    
    // 旧形式（配列）から新形式への自動移行
    if (Array.isArray(content)) {
      return {
        userId: userId,
        stamps: content.map(stampId => ({
          stampId: stampId,
          stampName: null,
          acquiredAt: new Date().toISOString(),
          location: null
        })),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    
    return content;
  } catch (err) {
    // データがない場合は初期構造を返す
    return {
      userId: userId,
      stamps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }
}

// S3にユーザースタンプデータを保存
async function saveUserStamps(userId, stampData) {
  stampData.updatedAt = new Date().toISOString();
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: `user-stamps/${userId}.json`,
    Body: JSON.stringify(stampData, null, 2),
    ContentType: "application/json"
  }));
}

// スタンプIDの配列を取得（後方互換性のため）
function getUserStampIds(stampData) {
  return stampData.stamps.map(s => s.stampId);
}

// ReadableStream -> String
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// スタンプページ
app.get('/stamp/:hash', async (req, res) => {
  const stamps = await loadJsonFromS3(STAMP_FILE);
  const stampId = Object.keys(stamps).find(id => stamps[id].hash === req.params.hash);

  if (!stampId) return res.status(404).send("Invalid stamp");

  // ユーザーのスタンプ履歴をS3から取得
  const userStampData = await loadUserStamps(req.userId);
  const userStampIds = getUserStampIds(userStampData);

  // 新しいスタンプを追加
  if (!userStampIds.includes(stampId)) {
    userStampData.stamps.push({
      stampId: stampId,
      stampName: stamps[stampId].name,
      acquiredAt: new Date().toISOString(),
      location: null
    });
    
    // 初回作成時のみcreatedAtを設定
    if (!userStampData.createdAt) {
      userStampData.createdAt = new Date().toISOString();
    }
    
    await saveUserStamps(req.userId, userStampData);
  }

  // シンプルにレンダリング
  res.render('stamp', { 
    stampId, 
    stampName: stamps[stampId].name
  });
});

// 獲得スタンプ一覧
app.get('/my-stamps', async (req, res) => {
  const allStamps = await loadJsonFromS3(STAMP_FILE);

  // ユーザー取得済みスタンプをS3から取得
  const userStampData = await loadUserStamps(req.userId);
  const userStampIds = getUserStampIds(userStampData);

  // 全スタンプを基準に「取得済みかどうか」を判定
  const stamps = Object.keys(allStamps).map(key => {
    const acquired = userStampIds.includes(key);
    return {
      id: key,
      name: allStamps[key].name,
      logo: acquired ? `/logos/${key}` : null,
      acquired
    };
  });

  res.render('my-stamps', { stamps, allStamps });
});

// トップページ
app.get('/', async (req, res) => {
  const stampNames = await loadJsonFromS3(STAMP_FILE);

  let userId = req.cookies.userId;
  if (!userId) {
    userId = uuidv4();
    res.cookie('userId', userId, { maxAge: 365 * 24 * 60 * 60 * 1000 });
  }
  req.userId = userId;

  // ユーザー取得済みスタンプをS3から取得
  const userStampData = await loadUserStamps(req.userId);
  const userStampIds = getUserStampIds(userStampData);

  // 全スタンプを基準に「取得済みかどうか」を判定
  const stamps = Object.keys(stampNames).map(key => {
    const acquired = userStampIds.includes(key);
    return {
      id: key,
      name: stampNames[key].name,
      logo: acquired ? `/logos/${key}` : null,
      acquired
    };
  });

  res.render('index', {
    message: 'ようこそスタンプラリーへ！',
    stamps,
    allStamps: stampNames,
    baseUrl: req.baseUrlFull
  });
});


// 画像配信用ルート
app.get('/logos/:id', async (req, res) => {
  const allStamps = await loadJsonFromS3(STAMP_FILE);
  const id = String(req.params.id);

  if (!allStamps[id] || !allStamps[id].logo) {
    return res.status(404).send('Logo not found');
  }

  const key = `logos/${allStamps[id].logo}`;

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key });
    const response = await s3.send(command);

    res.setHeader('Content-Type', response.ContentType || 'image/png');
    response.Body.pipe(res);
  } catch (err) {
    console.error('Error fetching logo:', err);
    res.status(500).send('Error fetching logo');
  }
});

// 会場マップ配信用ルート
app.get('/map', async (req, res) => {
  const key = 'map.png';

  try {
    const command = new GetObjectCommand({ 
      Bucket: BUCKET_NAME,
      Key: key 
    });
    const response = await s3.send(command);

    res.setHeader('Content-Type', response.ContentType || 'image/png');
    response.Body.pipe(res);
  } catch (err) {
    console.error('Error fetching map:', err);
    res.status(404).send('Map not found');
  }
});

module.exports = app;