// Googleドライブ用のリフレッシュトークンを取得する（最初に一度だけ実行）
//
// 使い方:
//   node get-refresh-token.mjs <クライアントID> <クライアントシークレット>
//   node get-refresh-token.mjs <ダウンロードしたclient_secret_〜.json>
//   末尾に --out <ファイル> を付けると、画面に表示せずファイルに保存する
//
// ブラウザでGoogleのログイン画面が開くので、保存先フォルダを編集できる会社アカウントで許可する。
// 取得した refresh_token を Cloudflare のシークレット GOOGLE_REFRESH_TOKEN に登録する。

import http from 'node:http';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;

let [clientId, clientSecret] = args;
if (clientId && clientId.endsWith('.json')) {
  const j = JSON.parse(fs.readFileSync(clientId, 'utf8'));
  ({ client_id: clientId, client_secret: clientSecret } = j.installed || j.web);
}
if (!clientId || !clientSecret) {
  console.error('使い方: node get-refresh-token.mjs <クライアントID> <クライアントシークレット> [--out ファイル]');
  console.error('    または node get-refresh-token.mjs <client_secret_〜.json> [--out ファイル]');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/drive';  // 共有ドライブ内の既存フォルダへ保存するため drive を使う
const state = crypto.randomUUID();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('認証に失敗しました: ' + (url.searchParams.get('error') || '不正な応答'));
    server.close();
    return;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await tokenRes.json();

  if (data.refresh_token) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('完了しました。この画面は閉じてかまいません。');
    if (outFile) {
      fs.writeFileSync(outFile, data.refresh_token);
      console.log('refresh_token を保存しました: ' + outFile);
    } else {
      console.log('\n===== refresh_token =====\n' + data.refresh_token + '\n=========================\n');
    }
  } else {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('トークンを取得できませんでした。ターミナルを確認してください。');
    console.error('取得失敗:', data);
  }
  server.close();
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
  });
  console.log('ブラウザで次のURLを開いて許可してください:\n' + authUrl + '\n');
  const opener = process.platform === 'win32' ? `start "" "${authUrl}"`
               : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(opener);
});
