// フォトコンテスト投稿の中継（Cloudflare Workers）
// 投稿画面から写真を受け取り、Googleドライブの指定フォルダに保存する。
//
// 環境変数（wrangler.toml の [vars]）
//   FOLDER_ID       保存先フォルダのID
//   ALLOWED_ORIGIN  投稿画面のURL（例: https://igarashi-k1.github.io）。カンマ区切りで複数可
//   SHEET_ID        （任意）投稿一覧を追記するスプレッドシートのID
//   SLIDESHOW_FOLDERS（任意）スライドショーで見せてよいフォルダのID。カンマ区切り。FOLDER_ID は常に含む
// シークレット（npx wrangler secret put で登録）
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//   VIEW_KEY        （任意）スライドショーが写真を読むときの合言葉。未設定ならスライドショー用の機能は使えない

const MAX_BYTES = 10 * 1024 * 1024;  // 1枚あたりの上限（10MB）
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/slideshow/')) return slideshow(request, env, url);

    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST')    return json({ error: 'POST で送信してください' }, 405, cors);
    if (!cors['Access-Control-Allow-Origin']) return json({ error: '許可されていない送信元です' }, 403, cors);

    try {
      const form = await request.formData();
      const table    = clean(form.get('table'), 10);
      const nickname = clean(form.get('nickname'), 30);
      const photo    = form.get('photo');

      if (!table)    return json({ error: 'テーブル番号を入力してください' }, 400, cors);
      if (!nickname) return json({ error: 'ニックネームを入力してください' }, 400, cors);
      if (!photo || typeof photo === 'string') return json({ error: '写真が見つかりません' }, 400, cors);
      if (photo.size > MAX_BYTES) return json({ error: '写真のサイズが大きすぎます' }, 400, cors);

      const bytes = new Uint8Array(await photo.arrayBuffer());
      const type = detectType(bytes);
      if (!type) return json({ error: '写真の形式が正しくありません' }, 400, cors);

      const now = new Date();
      const fileName = `${timestamp(now)}_T${safe(table)}_${safe(nickname)}_${rand()}.${TYPES[type]}`;
      const token = await accessToken(env);

      const file = await uploadToDrive(token, env.FOLDER_ID, fileName, type, bytes,
        `テーブル番号: ${table}\nニックネーム: ${nickname}`);

      if (env.SHEET_ID) {
        // 一覧への記録に失敗しても写真は保存済みなので、投稿は成功扱いにする
        await appendRow(token, env.SHEET_ID, {
          投稿日時: jst(now), テーブル番号: table, ニックネーム: nickname, ファイル名: fileName, 写真URL: file.webViewLink,
        })
          .catch(e => console.error('シート記録失敗', e));
      }

      return json({ ok: true }, 200, cors);
    } catch (e) {
      console.error(e);
      return json({ error: '保存に失敗しました。時間をおいてもう一度お試しください' }, 500, cors);
    }
  },
};

// ---- Google API ----

let cachedToken = null;  // 同じ Worker インスタンス内でアクセストークンを使い回す

async function accessToken(env) {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('トークン取得失敗: ' + await res.text());
  const data = await res.json();
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function uploadToDrive(token, folderId, name, type, bytes, description) {
  const boundary = 'b' + crypto.randomUUID();
  const meta = JSON.stringify({ name, parents: [folderId], description });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`, bytes,
    `\r\n--${boundary}--`,
  ]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  if (!res.ok) throw new Error('ドライブ保存失敗: ' + await res.text());
  return res.json();
}

// 1行目の見出しの名前で書き込む列を決める（列を足したり並べ替えたりしてもずれないように）
// 見出しが見つからないときは、従来どおり A〜E列に順に書く
const SHEET_COLUMNS = ['投稿日時', 'テーブル番号', 'ニックネーム', 'ファイル名', '写真URL'];
let cachedHeader = null;  // { cols, expires }

async function appendRow(token, sheetId, record) {
  const header = await sheetHeader(token, sheetId);
  const matched = SHEET_COLUMNS.every(name => header.includes(name));
  if (!matched) console.error('シートの見出しが見つからないため A〜E列に記録', header);
  const row = matched ? header.map(name => record[name] ?? '') : SHEET_COLUMNS.map(name => record[name]);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
  if (!res.ok) throw new Error(await res.text());
}

async function sheetHeader(token, sheetId) {
  if (cachedHeader && cachedHeader.expires > Date.now()) return cachedHeader.cols;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/1:1`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('見出しの取得失敗: ' + await res.text());
  const cols = ((await res.json()).values?.[0] || []).map(s => String(s).trim());
  cachedHeader = { cols, expires: Date.now() + 60_000 };  // 見出しを直したら1分ほどで反映される
  return cols;
}

// ---- スライドショー用（写真の一覧と写真本体を返す） ----
//   GET /slideshow/folders          見せてよいフォルダの一覧
//   GET /slideshow/photos?folder=ID フォルダ内の写真の一覧
//   GET /slideshow/photo/ID[?size=400] 写真本体（size 指定時は縮小版）
// どれもヘッダー X-View-Key に VIEW_KEY が必要。スライドショーはパソコンのファイルから開くこともあるので送信元は制限しない

const SS_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'X-View-Key',
  'Access-Control-Max-Age': '86400',
};

async function slideshow(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: SS_CORS });
  if (request.method !== 'GET') return json({ error: 'GET で取得してください' }, 405, SS_CORS);
  if (!env.VIEW_KEY) return json({ error: 'スライドショー用の合言葉（VIEW_KEY）が設定されていません' }, 503, SS_CORS);
  if (!sameText(request.headers.get('X-View-Key') || '', env.VIEW_KEY)) return json({ error: '合言葉が正しくありません' }, 401, SS_CORS);

  const folders = [env.FOLDER_ID, ...String(env.SLIDESHOW_FOLDERS || '').split(',')].map(s => s.trim()).filter(Boolean);
  const route = url.pathname.slice('/slideshow/'.length);

  try {
    const token = await accessToken(env);

    if (route === 'folders') {
      const list = await Promise.all([...new Set(folders)].map(async id => {
        const f = await driveJson(token, `files/${id}?fields=id,name&supportsAllDrives=true`).catch(() => null);
        return f && { id: f.id, name: f.name };
      }));
      return json({ folders: list.filter(Boolean) }, 200, SS_CORS);
    }

    if (route === 'photos') {
      const folder = url.searchParams.get('folder') || folders[0];
      if (!folders.includes(folder)) return json({ error: 'このフォルダは見られません' }, 403, SS_CORS);
      const q = `'${folder}' in parents and trashed = false and mimeType contains 'image/'`;
      const photos = [];
      let pageToken = '';
      do {
        const data = await driveJson(token, 'files?' + new URLSearchParams({
          q, pageSize: '1000', corpora: 'allDrives', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
          fields: 'nextPageToken,files(id,name,mimeType,createdTime,description)',
          ...(pageToken ? { pageToken } : {}),
        }));
        photos.push(...data.files);
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return json({ photos }, 200, SS_CORS);
    }

    if (route.startsWith('photo/')) {
      const id = route.slice('photo/'.length);
      if (!/^[\w-]+$/.test(id)) return json({ error: '写真が見つかりません' }, 404, SS_CORS);
      // 見せてよいフォルダの写真か確かめる（ほかのドライブのファイルは返さない）
      const meta = await driveJson(token, `files/${id}?fields=parents,mimeType,thumbnailLink,trashed&supportsAllDrives=true`)
        .catch(() => null);
      if (!meta || meta.trashed || !String(meta.mimeType).startsWith('image/') ||
          !(meta.parents || []).some(p => folders.includes(p))) {
        return json({ error: '写真が見つかりません' }, 404, SS_CORS);
      }
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const size = Math.min(1600, Number(url.searchParams.get('size')) || 0);
      let res = null;
      if (size && meta.thumbnailLink) {
        // 縮小版はドライブのサムネイルを使う。取れなければ元の写真を返す
        res = await fetch(meta.thumbnailLink.replace(/=s\d+[^/]*$/, '') + `=s${size}`, auth).catch(() => null);
        if (res && !res.ok) res = null;
      }
      if (!res) res = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, auth);
      if (!res.ok) throw new Error(`写真の取得失敗 ${res.status}`);
      return new Response(res.body, {
        headers: { ...SS_CORS, 'Content-Type': res.headers.get('Content-Type') || meta.mimeType, 'Cache-Control': 'private, max-age=86400' },
      });
    }

    return json({ error: '不明なURLです' }, 404, SS_CORS);
  } catch (e) {
    console.error('スライドショー', e);
    return json({ error: 'ドライブから読み込めませんでした' }, 502, SS_CORS);
  }
}

async function driveJson(token, path) {
  const res = await fetch('https://www.googleapis.com/drive/v3/' + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('ドライブAPI失敗: ' + await res.text());
  return res.json();
}

// 合言葉の比較（文字ごとの比較時間で中身を推測されないようにする）
function sameText(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// ---- 補助 ----

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin || '*' } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 先頭バイトで画像形式を判定（拡張子やContent-Typeは偽装できるため）
function detectType(b) {
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// 前後空白を除き、長さを制限。先頭の = + - @ はシートで数式扱いされないよう ' を付ける
function clean(v, max) {
  const s = String(v || '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function safe(s) {
  return s.replace(/^'/, '').replace(/[\\/:*?"<>|\s]/g, '_');
}

function rand() {
  return Math.random().toString(36).slice(2, 6);
}

// 日本時間の Date 相当（UTC+9）
function jstDate(d) {
  return new Date(d.getTime() + 9 * 3600 * 1000);
}

function timestamp(d) {
  return jstDate(d).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);  // yyyyMMdd_HHmmss
}

function jst(d) {
  return jstDate(d).toISOString().replace('T', ' ').slice(0, 19);  // yyyy-MM-dd HH:mm:ss
}
