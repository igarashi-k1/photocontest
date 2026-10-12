# フォトコンテスト投稿システム（web版）

ログイン不要で、スマホのブラウザから誰でも写真を投稿できます。投稿された写真はGoogleドライブのフォルダに保存されます。

```
スマホのブラウザ ──▶ GitHub Pages（投稿画面） ──▶ Cloudflare Workers（中継） ──▶ Googleドライブ
```

| フォルダ | 内容 |
|---|---|
| `index.html` / `site/index.html` | 投稿画面（同じ内容）。直下の `index.html` を GitHub Pages が表示する |
| `worker/` | 中継プログラム。Cloudflare Workers に置く。ドライブの鍵はここだけが持つ |
| `tools/get-refresh-token.mjs` | ドライブの鍵（リフレッシュトークン）を取得するツール。最初に一度だけ使う |

## 設置済みの環境

| 項目 | 内容 |
|---|---|
| 投稿画面 | GitHub Pages で公開。https://igarashi-k1.github.io/photocontest/ |
| 中継 | Cloudflare Workers で写真を受け取り、ドライブへ保存 |
| Google Cloud | ドライブに保存する許可（鍵）を出すためだけに使用。サーバーは動かしていない。Drive API 有効／OAuth（内部・デスクトップアプリ）。**受付中は削除しない** |
| 保存先 | 共有ドライブの `photocontest` フォルダ |

- 投稿画面を直したら：直下の `index.html` と `site/index.html` の両方を更新する
- 中継を直したら：`cd worker` → `npx wrangler deploy`

## 設置手順

### 1. Google Cloud でドライブ用の鍵を作る（会社アカウントで）

1. https://console.cloud.google.com を開き、上部のプロジェクト選択で「新しいプロジェクト」を作成（名前は例: `photocontest`）
2. 「APIとサービス」→「ライブラリ」で **Google Drive API** を有効にする
   - 投稿一覧をスプレッドシートにも記録する場合は **Google Sheets API** も有効にする
3. 「APIとサービス」→「OAuth同意画面」（Google Auth Platform）
   - ユーザーの種類：**内部**（社内アプリ扱いになり、審査不要・鍵の期限切れなし）
   - アプリ名・メールアドレスを入力して保存
4. 「認証情報」（クライアント）→「OAuthクライアントIDを作成」
   - アプリケーションの種類：**デスクトップアプリ**
   - 作成後に表示される **クライアントID** と **クライアントシークレット** を控える
5. このフォルダでツールを実行し、ブラウザで **保存先フォルダを編集できる会社アカウント** を選んで許可する
   ```
   node tools/get-refresh-token.mjs <クライアントID> <クライアントシークレット>
   ```
   ターミナルに表示された `refresh_token` を控える（**他人に見せない**）

### 2. Cloudflare Workers に中継を置く

1. https://dash.cloudflare.com/sign-up で無料登録
2. `worker/wrangler.toml` を確認（保存先フォルダIDと投稿画面のURLは設定済み）
3. ターミナルで次を実行
   ```
   cd worker
   npx wrangler login
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GOOGLE_REFRESH_TOKEN
   npx wrangler deploy
   ```
   - `secret put` ではそれぞれ値の入力を求められるので、1. で控えた値を貼り付ける
   - 最後に表示される `https://photocontest-upload.○○○.workers.dev` が中継のURL

### 3. GitHub Pages に投稿画面を置く

1. `site/index.html` の `API_URL` を、2. で表示された中継のURLに書き換える
2. GitHub で新しいリポジトリ（例: `photocontest`、**Public**）を作り、`index.html` をアップロード
3. リポジトリの「Settings」→「Pages」→ Branch を `main` / `/ (root)` にして保存
4. 数分後に `https://igarashi-k1.github.io/photocontest/` が投稿画面になる → QRコードにして配布

### 4. 動作確認

スマホで投稿画面を開いてテスト投稿し、保存先フォルダに写真が入ることを確認してください。

## 設定の変更

- **保存先フォルダ**：`worker/wrangler.toml` の `FOLDER_ID` を書き換えて `npx wrangler deploy`
- **投稿一覧のスプレッドシート**：`SHEET_ID` にスプレッドシートのID（URLの `/d/` と `/edit` の間）を入れて `npx wrangler deploy`。1枚目のシートに「投稿日時／テーブル番号／ニックネーム／ファイル名／写真URL」の順で追記されます
- **投稿画面のURLが変わったとき**：`ALLOWED_ORIGIN` を新しいURL（`https://ドメイン` まで）にして `npx wrangler deploy`。これ以外のサイトからの送信は拒否されます
- **受付終了**：Cloudflare のダッシュボードで Worker を削除するか、`ALLOWED_ORIGIN` を空にしてデプロイ

## 仕組みと注意

- 写真はスマホ側で長辺2400pxのJPEGに縮小してから送信。中継側でもサイズ（10MBまで）と画像形式をチェック
- ファイル名：`投稿日時_Tテーブル番号_ニックネーム_ランダム4文字.jpg`。ドライブの説明欄にもテーブル番号・ニックネームを記録
- URLを知っていれば誰でも投稿できます。`ALLOWED_ORIGIN` はブラウザ経由の送信を制限するだけなので、いたずら投稿が心配な場合は配布先を限定してください
- リフレッシュトークンは会社アカウントのドライブ全体を操作できる鍵です。Cloudflare のシークレットにだけ保存し、ファイルやチャットに貼らないでください。漏れた場合は https://myaccount.google.com/permissions でアクセス権を削除すれば無効になります
