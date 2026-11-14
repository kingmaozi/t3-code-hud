# T3 Code HUD (`t3-code-hud`)

![License](https://img.shields.io/badge/license-MIT-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS-informational.svg) ![Electron](https://img.shields.io/badge/electron-injected-blue.svg) ![Non-invasive](https://img.shields.io/badge/non--invasive-✅-brightgreen.svg)

[English](../README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어**

**T3 Code / T3 Code (Beta)** 를 위한 **비침습적** 실시간 텔레메트리 HUD, 수십억 토큰 서브에이전트 및 비용 트래커, 실제 컨텍스트 링, 쿼터 모니터, 인터랙티브 Git 그래프 플로팅 창.

> `app.asar` 를 전혀 수정하지 않고, 서명을 깨뜨리지 않으며, T3 자동 업데이트 후에도 유지됩니다. **Antigravity / Muse / Codex / Claude** 엔진에서 속도 오표시, 캐시 이중 집계, 컨텍스트 용량 과대평가, 서브에이전트 토큰 누락의 근본 원인을 수정합니다.

---

## 존재 이유 (근본 원인 수정)

순정 T3는 네 가지 텔레메트리에서 오표시됩니다. HUD는 발생 지점에서 수정합니다:

| 버그 | 순정 T3 | HUD 수정 |
|-----|---------|---------|
| **캐시 히트율 50% 상한** | Antigravity SQLite 폴백 경로에서 `geminiPromptUsage` 가 `cachedInputTokens` 를 분자와 분모에 이중 가산. | 네이티브 Protobuf/JSONL 직접 판독(`conversations/*.db`, `session.jsonl`, `sessions/*.jsonl`)으로 `uncached + cacheRead + cacheWrite` 중복 제거. |
| **`/new` 에서 100% 빨간 링** | 비스레드 라우트에서 이전 스레드의 `live.contextWindow.usedTokens` 를 재사용. | `!stats.ok` 일 때 `ctxUsed = 0`, `ctxPct = 0` 강제. 오래된 live 상태는 읽지 않음. |
| **인공적인 30만 하한** | Antigravity `contextMax` 가 `Math.max(300000, …)` 로 클램프되어 실제 `100만 / 1048576` 윈도우를 숨김. | 모든 `300000` 하한 제거. `readAntigravityConvDb` 는 `contextMax: null` 로 `statev2 contextUsage.maxTokens`를 상속(Gemini `1048576` / Claude `1000000`)하고 `lookupCatalogContextMax` 카탈로그 폴백 적용. |
| **수십억 서브에이전트 누락** | 재귀 `delegate_task` 자손 과소 집계. 캐시 키가 `updated_at` 뿐이라 WAL 늦은 턴이 소실. | `orchestration_v2_projection_subagents` BFS + 턴 수/`MAX(updated_at)` 무효화 가드. 혼합 엔진 스레드는 미커버 driver 병합으로 턴 누락 제로. |

기타 정확성:

- **진짜 컨텍스트 윈도우** — `contextUsed`는 마지막 단일 호출 prompt(`promptTotal + output`, 중복 제거). Muse는 `statev2`의 `1007997` 상속, Codex는 `token_count`의 `model_context_window`, Antigravity는 `1048576`(Gemini)/`1000000`(Claude) 폴백.
- **스트리밍 속도** — 순수 디코드 윈도우(Muse: `response_created → completed`, Antigravity: `t6 → t7`, Codex: `reasoning → token_usage`)로 도구 대기·프리필 제외, 260ms 실시간 샘플러.
- **공식 요금** — T3 공식 `usage-model-rates.json`(5900+ 모델 + 계층 요금) 재사용.

---

## 주요 기능

- **컴포저 위 미니멀 캡슐** (자동 여백으로 메시지 흐름을 가리지 않음, Light/Dark 대응):
  - ⚡ 대기 시 세션 평균 디코드 속도(`Avg XX.X tok/s`), 스트리밍 중 실시간 `tok/s`와 파란 점멸 표시. 호버 카드에서 평균과 마지막 턴 속도를 각각 확인.
  - ♻️ 실제 세션 캐시 히트율.
  - 🧮 재귀 서브에이전트 포함 전체 토큰(`B` 단위, 예 `2.34B tok`, 웜 쿼리 `< 8ms`).
  - 💰 공식 요금 환산 비용 + 서브에이전트 내역(`$XX.XX (+N sub)`).
  - 🔋 주간 쿼터 잔여(`Wk 67%`) — Gemini ↔ Claude/GPT 전환이 메시지 전송 없이 즉시 동기화. 호버 시 전 엔진 `5-hour / Session / Weekly` 바 표시.
  - ◔ 컨텍스트 링 — 실제 사용률 + 호버 카드(`Context Capacity`, 프로그레스 바, `Avg Cache Hit Rate`).
- **제로 오버랩 레이아웃** — `isChatComposerVisibleAndUncovered()` 가 설정, `/usage`, `/pair`, 다이어로그/모달, 가려진 컴포저에서 HUD 숨김. 탑바 `z-index: 30` 으로 네이티브 모달(`50`) 아래 유지.
- **드래그 가능한 Git 그래프 플로팅 창**(`Option+G` / `Esc`) — 중앙 배치, 최대 920 × 600, 단색 벡터 아이콘, 제목 표시줄에 검색과 저장소 상태 통합. 고정된 5열 헤더(Graph / Description / Date / Author / Commit), 주황색 HEAD 이중 링, 분리된 HEAD/브랜치 라벨과 `MM/DD HH:mm` 날짜. 커밋 클릭 시 하단 분할 창에서 파일 추가/삭제 수와 강조된 diff 확인. 680px 미만에서는 작성자 열을 숨기고 날짜/SHA 폭을 축소하며, 좁은 캡슐의 토큰/쿼터 정보는 호버 카드에 유지. 설정에서 창을 닫고 네이티브 모달 중에는 일시 숨김. `refs/t3/*` 노이즈 자동 제외.
- **이중언어 자동 감지**(`中文` / `English`) 원클릭 전환.
- **강화 로컬 RPC** — 프라이빗 `~/.t3/hud-plugin/run/rpc.json`(디렉토리 `0700`, 파일 `0600`, `wx` + symlink 가드), `rpcToken`(읽기 전용)과 `adminToken`(CLI 전용) 분리, `/admin/eval` 완전 제거, `t3code://` 오리진 허용목록 강화.

---

## 한 줄 설치

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/install.sh | bash
```

또는 클론 후 설치:

```bash
git clone https://github.com/kingmaozi/t3-code-hud.git
cd t3-code-hud
./install.sh
```

활성화(우아한 재시작 1회):

```bash
t3-hud restart
```

> 설치 스크립트는 `/Applications/T3 Code.app` 내부를 수정하지 않습니다. 제거는 `~/.t3/hud-plugin` 삭제 후 재시작하면 됩니다.

---

## CLI 명령

```bash
t3-hud start     # HUD 마운트 T3 시작(순정 실행 중이면 심리스 재시작)
t3-hud restart   # 우아한 재시작 후 HUD 재마운트
t3-hud reload    # 재시작 없이 UI+백엔드 핫 리로드
t3-hud status    # PID + 마운트 상태 + 언어 설정
t3-hud lang zh   # 중국어
t3-hud lang en   # English
t3-hud lang auto # 명시 선택 해제, T3 UI 언어로 자동 감지
```

단축키: `Option + G` 그래프 토글, `Esc` 닫기.

---

## i18n 가이드

해결 순서:

1. **명시 토글** — `localStorage["t3-hud-lang"]` 또는 `config.userLang` (통계 팝오버 헤더 또는 Git 창 툴바의 `EN` / `中文` 버튼, 또는 `t3-hud lang`).
2. **DOM 자동 감지** — `document.documentElement.lang` 과 UI 문구(`想问什么` / `本地工作副本` / `新会话` / `设置` → `zh`, `Ask anything` / `Local working copy` / `New thread` / `Settings` → `en`).
3. **설치 기본값** — `install.sh` 가 `--lang` / `T3_HUD_LANG` / 시스템 로케일(`LC_ALL` / `LC_MESSAGES` / `LANG` / AppleLanguages)로 `config.defaultLang` 작성, 폴백 `zh`.

즉시 적용되고 재시작 유지:

```bash
./install.sh --lang en
T3_HUD_LANG=zh ./install.sh
t3-hud lang en
t3-hud lang zh
t3-hud lang auto
```

설정 파일: `~/.t3/hud-plugin/config.json` (`{ "defaultLang": "zh"|"en", "userLang": "zh"|"en"|"auto" }`).

---

## 아키텍처

```
T3 Code.app (Electron main "browser")
  └─ bootstrap.cjs → spawn --inspect=127.0.0.1:0 → CDP Runtime.evaluate → require(main-hook.cjs) → "OK" 검증
       └─ main-hook.cjs
            ├─ 루프백 HTTP 서버 (127.0.0.1:0) — rpcToken (/rpc만) + adminToken (CLI만)
            ├─ IPC: t3hud:get-thread-stats / get-git-graph / get-commit-detail / get-config / set-config (senderFrame 허용목록)
            └─ injectHudIntoWindow() → window.__t3HudHttpConfig + renderer-ui.js
                 └─ preload-bridge.cjs → window.__t3HudBridge
                      └─ renderer-ui.js (탑바 + 팝오버 + Git 창, 이중언어 제로오버랩)
                           └─ backend.cjs → statev2.sqlite + 네이티브 파일 + usage-model-rates.json
```

---

## 제거

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/uninstall.sh | bash
```

---

## 보안

`src/main-hook.cjs` , `src/bootstrap.cjs`, `src/backend.cjs` 의 `getConfig`/`setConfig` 참조. 런타임 상태는 `~/.t3/hud-plugin/run/` (`0o700` / `0o600` + `wx`).

---

## 라이선스

[MIT](../LICENSE)
