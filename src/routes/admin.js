// routes/admin.js
const express = require('express');
const QRCode = require('qrcode');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const multer = require('multer'); // ★ 追加
const path = require('path'); // ★ 追加
const router = express.Router();

// S3 クライアント
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const BUCKET_NAME = process.env.STAMP_BUCKET;
const STAMP_FILE = 'stamp-names.json';

// Multer設定（メモリストレージ）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|svg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('画像ファイル（JPEG, PNG, GIF, SVG）のみアップロード可能です'));
    }
  }
});

// S3 から JSON 読み込み
async function loadJsonFromS3(key) {
  try {
    const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    const chunks = [];
    for await (const chunk of data.Body) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch (e) {
    console.error(`Failed to load ${key} from S3`, e);
    return {};
  }
}

// S3 へ JSON 保存
async function saveJsonToS3(key, data) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: JSON.stringify(data, null, 2),
    ContentType: 'application/json'
  }));
}

// Node.js ReadableStream -> string
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

// 管理トップ
router.get('/', async (req, res) => {
  const stamps = await loadJsonFromS3(STAMP_FILE);
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  res.render('admin/index', { stamps, baseUrl });
});

// QRコード一覧
router.get('/qrcodes', async (req, res) => {
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const baseUrl = `${proto}://${req.get('host')}`;
  const stamps = await loadJsonFromS3(STAMP_FILE);
  const qrList = Object.keys(stamps).map(id => ({
    id,
    name: stamps[id].name,
    hash: stamps[id].hash,
    url: `${baseUrl}/stamp/${stamps[id].hash}`,
    qr: null,
  }));

  for (const item of qrList) {
    item.qr = await QRCode.toDataURL(item.url);
  }

  res.render('admin/qrcodes', { qrList });
});

// スタンプ名・ハッシュ更新
router.post('/qrcodes', express.urlencoded({ extended: true }), async (req, res) => {
  const stamps = {};
  for (const key in req.body) {
    if (key.startsWith('name_')) {
      const id = key.replace('name_', '');
      stamps[id] ||= {};
      stamps[id].name = req.body[key];
    }
    if (key.startsWith('hash_')) {
      const id = key.replace('hash_', '');
      stamps[id] ||= {};
      stamps[id].hash = req.body[key];
    }
  }
  await saveJsonToS3(STAMP_FILE, stamps);
  res.redirect('/admin/qrcodes');
});

// スタンプ追加
router.post('/add-stamp', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).send('スタンプ名が必要です');

  const stamps = await loadJsonFromS3(STAMP_FILE);
  const newId = uuidv4();
  const hash = crypto.randomBytes(16).toString('hex');

  stamps[newId] = {
    name,
    hash,
    logo: null // 初期状態ではロゴなし
  };

  await saveJsonToS3(STAMP_FILE, stamps);
  res.redirect('/admin');
});

// アイコンアップロード
router.post('/upload-icon/:stampId', upload.single('icon'), async (req, res) => {
  try {
    const { stampId } = req.params;
    
    if (!req.file) {
      return res.status(400).send('ファイルが選択されていません');
    }

    const stamps = await loadJsonFromS3(STAMP_FILE);
    
    if (!stamps[stampId]) {
      return res.status(404).send('スタンプが見つかりません');
    }

    // ファイル名を生成（元の拡張子を保持）
    const ext = path.extname(req.file.originalname);
    const fileName = `${stampId}${ext}`;
    const s3Key = `logos/${fileName}`;

    // S3にアップロード
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }));

    // stamp-names.json を更新
    stamps[stampId].logo = fileName;
    await saveJsonToS3(STAMP_FILE, stamps);

    res.redirect('/admin');
  } catch (err) {
    console.error('Icon upload error:', err);
    res.status(500).send('アイコンのアップロードに失敗しました');
  }
});

// アイコン削除
router.post('/delete-icon/:stampId', async (req, res) => {
  try {
    const { stampId } = req.params;
    const stamps = await loadJsonFromS3(STAMP_FILE);
    
    if (!stamps[stampId]) {
      return res.status(404).send('スタンプが見つかりません');
    }

    // ロゴ情報を削除
    stamps[stampId].logo = null;
    await saveJsonToS3(STAMP_FILE, stamps);

    res.redirect('/admin');
  } catch (err) {
    console.error('Icon delete error:', err);
    res.status(500).send('アイコンの削除に失敗しました');
  }
});

// 統計ページ
router.get('/statistics', async (req, res) => { // ★ adminAuth を削除（すでに app.use で適用されている）
  try {
    const { dateFrom, dateTo } = req.query;
    
    // 日付フィルター用の範囲を設定
    let fromDate = dateFrom ? new Date(dateFrom + 'T00:00:00Z') : null;
    let toDate = dateTo ? new Date(dateTo + 'T23:59:59Z') : null;
    
    const allStamps = await loadJsonFromS3(STAMP_FILE);
    
    // S3からすべてのユーザースタンプファイルを取得
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'user-stamps/'
    });
    
    const listResponse = await s3.send(listCommand);
    const userFiles = listResponse.Contents || [];
    
    // 統計データの初期化
    const statistics = {
      totalUsers: 0,
      stampStats: {},
      dailyStats: {},
      completionRate: 0,
      totalAcquisitions: 0
    };
    
    // 各スタンプの統計を初期化
    Object.keys(allStamps).forEach(stampId => {
      statistics.stampStats[stampId] = {
        name: allStamps[stampId].name,
        count: 0,
        percentage: 0,
        acquisitions: []
      };
    });
    
    // 各ユーザーのデータを集計
    let completedUsers = 0;
    let usersInPeriod = new Set();
    
    for (const file of userFiles) {
      try {
        const userData = await s3.send(new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: file.Key
        }));
        
        const chunks = [];
        for await (const chunk of userData.Body) {
          chunks.push(chunk);
        }
        const userStampData = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        
        const stamps = Array.isArray(userStampData) 
          ? userStampData.map(id => ({ stampId: id, acquiredAt: null }))
          : userStampData.stamps;
        
        // 期間フィルター適用
        const filteredStamps = stamps.filter(stamp => {
          if (!stamp.acquiredAt) return !fromDate && !toDate;
          const acquiredDate = new Date(stamp.acquiredAt);
          
          if (fromDate && acquiredDate < fromDate) return false;
          if (toDate && acquiredDate > toDate) return false;
          return true;
        });
        
        // フィルター期間内にスタンプを取得したユーザーをカウント
        if (filteredStamps.length > 0) {
          usersInPeriod.add(userStampData.userId || file.Key);
        }
        
        // 全スタンプ取得済みユーザーをカウント
        if (filteredStamps.length === Object.keys(allStamps).length) {
          completedUsers++;
        }
        
        // 各スタンプの取得数をカウント
        filteredStamps.forEach(stamp => {
          if (statistics.stampStats[stamp.stampId]) {
            statistics.stampStats[stamp.stampId].count++;
            statistics.totalAcquisitions++;
            
            if (stamp.acquiredAt) {
              const date = new Date(stamp.acquiredAt).toISOString().split('T')[0];
              statistics.dailyStats[date] = (statistics.dailyStats[date] || 0) + 1;
              statistics.stampStats[stamp.stampId].acquisitions.push({
                date: stamp.acquiredAt,
                userId: userStampData.userId
              });
            }
          }
        });
      } catch (err) {
        console.error(`Error processing ${file.Key}:`, err);
      }
    }
    
    // 期間内のアクティブユーザー数を設定
    statistics.totalUsers = (fromDate || toDate) ? usersInPeriod.size : userFiles.length;
    
    // パーセンテージを計算
    Object.keys(statistics.stampStats).forEach(stampId => {
      statistics.stampStats[stampId].percentage = 
        statistics.totalUsers > 0 
          ? ((statistics.stampStats[stampId].count / statistics.totalUsers) * 100).toFixed(1)
          : 0;
    });
    
    statistics.completionRate = 
      statistics.totalUsers > 0 
        ? ((completedUsers / statistics.totalUsers) * 100).toFixed(1)
        : 0;
    
    res.render('admin-statistics', { 
      statistics, 
      allStamps,
      dateFrom: dateFrom || '',
      dateTo: dateTo || ''
    });
  } catch (err) {
    console.error('Statistics error:', err);
    res.status(500).send('集計エラー');
  }
});

module.exports = router;