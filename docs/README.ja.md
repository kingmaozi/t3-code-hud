# T3 Code HUD (`t3-code-hud`)

![License](https://img.shields.io/badge/license-MIT-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS-informational.svg) ![Electron](https://img.shields.io/badge/electron-injected-blue.svg) ![Non-invasive](https://img.shields.io/badge/non--invasive-✅-brightgreen.svg)

[English](../README.md) | [简体中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md)

**T3 Code / T3 Code (Beta)** 向けの**非侵入型**リアルタイムテレメトリ HUD、数十億トークンのサブエージェント＆コストトラッカー、真のコンテキストリング、クォータモニター、対話型 Git グラフフローティングウィンドウ。

> `app.asar` を一切変更せず、署名崩壊もなく、T3 自動更新後も動作します。**Antigravity / Muse / Codex / Claude** エンジンにおける速度誤表示、キャッシュ二重計上、コンテキスト上限虚偽、サブエージェント過少計上の根本原因を修正します。

---

## なぜ必要か（根本原因の修正）

純正 T3 は 4 種類のテレメトリを誤表示します。HUD は発生源から修正します：

| 不具合 | 純正 T3 | HUD の修正 |
|-----|---------|---------|
| **キャッシュヒット率 50% 上限制** | Antigravity SQLite フォールバックで `geminiPromptUsage` が `cachedInputTokens` を分子・分母の両方に二重加算。 | ネイティブ Protobuf / JSONL を直接読取り（`conversations/*.db`、`session.jsonl`、`sessions/*.jsonl`）、`uncached + cacheRead + cacheWrite` に重複排除。 |
| **`/new` で 100% 赤リング** | 非スレッドルートで前スレッドの `live.contextWindow.usedTokens` を再利用。 | `!stats.ok` のとき `ctxUsed = 0`、`ctxPct = 0` に強制。古い live 状態は一切読まない。 |
| **人工的な 30 万フロア** | Antigravity `contextMax` が `Math.max(300000, …)` でクランプされ、真の `100 万 / 1048576` ウィンドウを隠蔽。 | 全ての `300000` フロアを削除。`readAntigravityConvDb` は `contextMax: null` とし、`statev2 contextUsage.maxTokens` を継承（Gemini `1048576` / Claude `1000000`）、カタログフォールバック `lookupCatalogContextMax` で補完。 |
| **数十億サブエージェント欠損** | 再帰 `delegate_task` 子孫が過少計上。キャッシュキーが `updated_at` のみで WAL 遅延ターンが消失。 | `orchestration_v2_projection_subagents` を BFS、`COUNT(*), MAX(updated_at)` で失効ガード。混合エンジンスレッドは未カバー driver を統合し、ターンを落とさない。 |

その他の正確性：

- **真のコンテキストウィンドウ** — `contextUsed` は直近の単発コールの prompt（`promptTotal + output`、重複排除済）。Muse は `statev2` の `1007997` を継承、Codex は `token_count` の `model_context_window`、Antigravity は `1048576`（Gemini）/ `1000000`（Claude）にフォールバック。
- **ストリーミング速度** — 純粋デコード窓（Muse: `response_created → completed`、Antigravity: `t6 → t7`、Codex: `reasoning → token_usage`）でツール待機とプリフィルを除外。260ms サンプラでリアルタイム表示。
- **公式料金** — T3 公式 `usage-model-rates.json`（5900+ モデル＋階層料金）を利用。

---

## 主な機能

- **コンポーザー直上のミニマムカプセル**（自動スペーシングでメッセージ-streamを塞がない、Light/Dark 対応）：
  - ⚡ 待機時はセッション平均デコード速度（`Avg XX.X tok/s`）、出力中はリアルタイム `tok/s` と青い点滅ドット。ホバーで平均と直近ターンの速度を個別表示。
  - ♻️ 実セッションキャッシュヒット率。
  - 🧮 再帰サブエージェントを含む総トークン（`B` 表記、例 `2.34B tok`、ウォームクエリ `< 8ms`）。
  - 💰 公式料金等価コストとサブエージェント内訳（`$XX.XX (+N sub)`）。
  - 🔋 週間クォータ残量（`Wk 67%`）—— Gemini ↔ Claude/GPT 切替が送信不要で即時同期。ホバーで全エンジンの `5-hour / Session / Weekly` バーを表示。
  - ◔ コンテキストリング —— 真の使用率とホバーカード（`Context Capacity`、プログレスバー、`Avg Cache Hit Rate`）。
- **ゼロオーバーラップレイアウト** —— 設定画面、`/usage`、`/pair`、ダイアログ／モーダル、遮断されたコンポーザーでは `isChatComposerVisibleAndUncovered()` が HUD を隠します。トップバー `z-index: 30` はネイティブモーダル `50` の下。
- **ドラッグ可能な Git グラフフローティングウィンドウ**（`Option+G` / `Esc`）—— 中央配置、最大 920 × 600、単色ベクターアイコン、検索とリポジトリ状態をタイトルバーに集約。固定ヘッダーの 5 列（Graph / Description / Date / Author / Commit）、オレンジの HEAD 二重リング、独立した HEAD／ブランチラベル、`MM/DD HH:mm` 日時。クリックで下部にファイルの追加／削除数とハイライト差分。680px 未満では作者列を省略し日時／SHA 列を縮小。狭いカプセルのトークン／クォータ詳細はホバーで確認。設定画面では閉じ、ネイティブダイアログ中は一時非表示。`refs/t3/*` ノイズを自動除外。
- **日英バイリンガル自動検出**（`中文` / `English`）ワンクリック切替。
- **堅牢なローカル RPC** —— プライベート `~/.t3/hud-plugin/run/rpc.json`（ディレクトリ `0700`、ファイル `0600`、`wx`＋symlink ガード）、`rpcToken`（読取専用）と `adminToken`（CLI 専用）を分離、`/admin/eval` を完全削除、`t3code://` 起点ホワイトリスト厳格化。

---

## ワンラインインストール

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/install.sh | bash
```

またはクローンインストール：

```bash
git clone https://github.com/kingmaozi/t3-code-hud.git
cd t3-code-hud
./install.sh
```

有効化（優雅な再起動を 1 回）：

```bash
t3-hud restart
```

> インストールは `/Applications/T3 Code.app` 内部を変更しません。アンインストールは `~/.t3/hud-plugin` を削除して再起動してください。

---

## CLI コマンド

```bash
t3-hud start     # HUD 付きで T3 を起動（純正起動中はシームレスに再起動）
t3-hud restart   # 優雅に再起動して HUD を再マウント
t3-hud reload    # 再起動なしで UI＋バックエンドをホットリロード
t3-hud status    # PID＋マウント状態＋言語設定
t3-hud lang zh   # 中国語
t3-hud lang en   # English
t3-hud lang auto # 明示選択を解除し T3 UI 言語で自動検出
```

ショートカット：`Option + G` でグラフ切替、`Esc` で閉じる。

---

## i18n ガイド

解決順序：

1. **明示切替** — `localStorage["t3-hud-lang"]` または `config.userLang`（ポップオーバー頭部または Git ウィンドウ ツールバーの `EN` / `中文` ボタン、または `t3-hud lang`）。
2. **DOM 自動検出** — `document.documentElement.lang` と UI 文言（`想问什么` / `本地工作副本` / `新会话` / `设置` → `zh`、`Ask anything` / `Local working copy` / `New thread` / `Settings` → `en`）。
3. **インストール時デフォルト** — `install.sh` が `--lang` / `T3_HUD_LANG` / システムロケール（`LC_ALL` / `LC_MESSAGES` / `LANG` / AppleLanguages）から `config.defaultLang` を書込み、既定は `zh`。

即時反映で再起動後も保持：

```bash
./install.sh --lang en
T3_HUD_LANG=zh ./install.sh
t3-hud lang en
t3-hud lang zh
t3-hud lang auto
```

設定ファイル：`~/.t3/hud-plugin/config.json`（`{ "defaultLang": "zh"|"en", "userLang": "zh"|"en"|"auto" }`）。

---

## アーキテクチャ

```
T3 Code.app (Electron main "browser")
  └─ bootstrap.cjs → spawn --inspect=127.0.0.1:0 → CDP Runtime.evaluate → require(main-hook.cjs) → "OK" 検証
       └─ main-hook.cjs
            ├─ ループバック HTTP サーバ (127.0.0.1:0) — rpcToken (/rpc のみ) + adminToken (CLI のみ)
            ├─ IPC: t3hud:get-thread-stats / get-git-graph / get-commit-detail / get-config / set-config (senderFrame 許可リスト)
            └─ injectHudIntoWindow() → window.__t3HudHttpConfig + renderer-ui.js
                 └─ preload-bridge.cjs → window.__t3HudBridge
                      └─ renderer-ui.js（トップバー＋ポップオーバー＋Git ウィンドウ、日英ゼロオーバーラップ）
                           └─ backend.cjs → statev2.sqlite + ネイティブファイル + usage-model-rates.json
```

---

## アンインストール

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/uninstall.sh | bash
```

---

## セキュリティ

`src/main-hook.cjs`、`src/bootstrap.cjs`、`src/backend.cjs` の `getConfig`/`setConfig` を参照。ランタイム状態は `~/.t3/hud-plugin/run/` 配下（`0o700` / `0o600` + `wx`）。

---

## ライセンス

[MIT](../LICENSE)
