# CLAUDE.md — TAA Income Quant PM System

> Claude Code용 프로젝트 지침입니다. 이 파일만 읽어도 목적, 현재 상태, 금지 사항을 파악할 수 있도록 작성했습니다.
> - 기준 시점: 2026-09-30 (Claude Project → Claude Code 이사 시점)
> - 기준 코드: `taa_pm_system_v1.0` (System v1.0 · Model v3.0)
> - 상세 인수인계: `docs/HANDOVER.md`
> - v1.0 원본 로컬 실행 설명서: `docs/LOCAL_RUN_v1.0.md`
>
> **상태 표기**
>
> | 표기 | 의미 |
> |---|---|
> | [현재] | 코드에 구현됐고 실행으로 검증됨 |
> | [부분] | 구현됐으나 미검증이거나 제한이 있음 |
> | [계획] | 미구현 |
> | [결정] | 사용자가 명시적으로 확정한 사항 |

---

## for_dashboard 통합 (2026-09-30) — 이 문서의 다른 절보다 우선

이 패키지는 public 저장소 `hahajongha/for_dashboard`의 `investment_model/` 폴더에 있습니다 (사용자 결정: 공개 운영, 모델·결과 public 가능).
이 폴더 기준 상대경로(`config/`, `qpm/`, `tests/` …)는 그대로 유효합니다. 저장소 전체 규칙은 루트 `CLAUDE.md`를 따릅니다.

| 항목 | 상태 | 내용 |
|---|---|---|
| 모델 코드 `qpm/`, `config/`, `params/`, `history/`, `data/` | [현재] | v1.0 zip 그대로 (코드 변경 없음) |
| 대시보드 `dashboard/…v1.0.html` | [현재] | 보호 블록(seed 마커·주문 엔진) 밖만 수정: 정적 모드 1단계를 **Update Data 링크**(Actions 워크플로 페이지)로, `status.json` 표시(Last Update·Market/Macro Data Date·Update Status), `scrollIntoView` → 문서 내부 스크롤(런처 iframe 안에서 화면 밀림 방지), **투자금 배분 계산** 섹션(`#s-alloc`: 투자금 $ × 목표 비중 → Data As Of 종가 기준 정수 주수, 목표에 더 가까워질 때만 잔여 현금으로 1주씩 추가, CSV, **[실보유 입력란으로 보내기]**), 실보유 **CSV 저장**(`[현재 실보유 CSV 저장]`·`[주문 체결 후 실보유 CSV 저장]`: 업로드 양식 그대로, 수량만 저장해 다음 달 최신 종가로 평가, 수량 없는 종목은 평가금액, 유니버스 외 매도·거래비용 반영 → 다음 달 [CSV]로 불러오기; 실보유는 저장소·브라우저 저장소에 남기지 않음 — 사용자 결정), 직접 입력값이 [비교하고 주문 만들기] 후에도 유지. 골든·parity PASS |
| 화면 게시 | [현재] | 런처 `index.html`의 `APPS` → `output/taa_pm_dashboard_v1.0_latest.html` |
| CI 진입점 `scripts/ci_run.py` | [현재] 로컬 검증 / [부분] 러너 미검증 | 임시 복사본에서 update_data → `scripts/ci_guards.py` → `qpm.pipeline.validate` → (model_run·monthly) `portfolio_engine.py --as-of` → 실보유·키 점검 → **모두 통과 시에만** data/·history/·output/ 교체. 실패 시 `output/status.json`만 갱신. 고장 주입 6종(이력 잘림, proxy 결측, FRED 잘림·빈 파일, 빈티지 누락, 다운로드 실패)에서 기존 데이터 유지 확인 |
| K-1 (검증 전 덮어쓰기) | [현재] CI 경로에서 해소 | 위 임시 복사본 방식. 로컬 `update_data.py`는 여전히 덮어씀 |
| K-2 (월초 기준일) | [현재] | `--task monthly` = 직전 월 마지막 NYSE 거래일 |
| K-3 (실보유) | [현재] CI 경로 | CI는 실보유를 입력하지 않고, 결과에 `actual.provided`가 있으면 교체 거부. 로컬 `rebalance_cli.py` 결과를 커밋하지 말 것 |
| K-4 (마감 월) | [현재] | `history/<월>/result.json`(source=live)이 있으면 모델 건너뜀, `--force`로만 재계산 |
| K-10 (버전) | [현재] | `requirements.lock` (Python 3.12, pandas 3.0.2, numpy 2.4.4, cvxpy 1.9.3, clarabel 0.11.1, scipy 1.18.1, yfinance 1.7.0) |
| 관측일·이용가능일 저장소 | [현재] 기록만 | `scripts/fred_pit.py` → `data/fred_pit/<ID>.csv` (주간·월간·분기 16종, 추가 전용). `available_basis` = alfred_vintage / release_rule_est(추정) / first_seen(수정치). **모델은 읽지 않음** — 백테스트 적용은 methodology 변경(승인 필요) |
| Peer 비교 | [현재] 로컬 검증 / [부분] 실데이터는 첫 Actions 실행 후 | `config/peers.json`(12종, 모델 유니버스와 무관) → `scripts/peers.py`: 데이터 업데이트마다 yfinance로 `data/peers/*.csv.gz` 수집(티커별 이력이 짧아지면 기존 유지, 실패해도 파이프라인 계속) → `output/peers.json`(총수익률 기준: 기간 수익률·3년 변동성·Sharpe·MDD·연도별·누적 차트·Live 성과. 분배수익률은 공모펀드의 Yahoo 분배금에 자본이득 분배가 섞여 제외). 모델 수익률 = 현재 파라미터 `run_path` 백테스트(**Fixed params, partial in-sample**) + v3.0 연도별(**Honest OOS**, 정적) + 실제 발표 목표 보유 성과(Live). 대시보드 `#s-peer` (SVG 선 차트, 범주형 8색 light/dark 검증) |
| FRED | [결정] | 키 없는 CSV·ALFRED 경로(`fred_mode=csv`) 유지. API 키 미사용 |
| 워크플로 | [부분] 러너 접속 확인 (2026-09-30 첫 실행: yfinance 32종·FRED 33/33·ALFRED 12 다운로드 성공, ICE BofA 3년 이동 창 가드 오탐으로 실패 → 수정) | 저장소 루트 `.github/workflows/`: `update-investment-data.yml`(수동), `investment-model-monthly.yml`(매월 1~5일 22:17 UTC), `_investment-model-pipeline.yml`(공통), `investment-model-tests.yml`(골든) |
| 골든 테스트 | [현재] | CI가 `data/`를 갱신하므로 `python scripts/golden_ci.py`로 실행 — `tests/fixtures/taa_pm_repo_v1.0.zip`(v1.0 원본)의 data·history·params로 임시 복사본에서 `tests/check_golden.py`, `check_rebalance_parity.py` 실행 |

아래 "GitHub 저장소·Pages·Actions 현재 없음", "비공개 저장소 권장" 문구는 이사 시점 기록이며 위 표가 현재 상태입니다.

## 0. Working Rules (반드시 지킬 것)

1. **추측 금지**
   - 코드, 데이터, 실행 결과로 확인한 내용만 기록하고 주장합니다.
   - 확인하지 못한 내용은 "미확인"으로 남깁니다.
2. **Methodology 임의 변경 금지** [결정]
   - 다음 항목은 사용자 승인 없이 바꾸지 않습니다: 유니버스, 파라미터, 점수식, 목적함수·제약, 밴드, 국면 판정 (§Do Not Change).
   - 승인을 받은 변경도 골든 테스트의 변경 전/후 비교를 함께 제시합니다.
3. **변경 후 테스트**
   - 코드를 바꾼 뒤에는 `python tests/check_golden.py`를 실행해 통과해야 합니다. 오프라인으로 동작합니다.
   - `dashboard/`의 JS 주문 엔진을 수정했다면 `python tests/check_rebalance_parity.py`도 통과해야 합니다. Node가 필요합니다.
4. **[현재]와 [계획]을 섞지 않기**
   - 문서, 주석, PR 설명 모두에 해당합니다.
5. **Secret 금지**
   - API 키와 토큰은 코드, HTML, 문서, 커밋 어디에도 넣지 않습니다.
   - 로컬은 `.env`, GitHub Actions는 Secrets를 사용합니다.
   - `qpm/config.py::load_env`는 `FRED_API_KEY`, `ANTHROPIC_API_KEY`를 `.env`에서 읽고, 같은 이름의 환경변수가 있으면 그 값을 우선합니다 [현재].
6. **실보유(Actual) 데이터 커밋 금지**
   - 현재 코드는 실보유를 여러 파일에 함께 기록하므로 주의해야 합니다 (§Known Issues K-3).
7. **Look-ahead 방지**
   - 관측일(observation date)과 이용 가능일(release/vintage date)을 항상 구분합니다 (§FRED).
8. **사용자 산출물 형식** [결정]
   - 간결하고 구조화된 한국어 보고서체(표, 불릿)로 작성합니다.
   - HTML 파일명에는 버전을 넣습니다. 예: `taa_pm_dashboard_v1.0.html`
   - HTML 화면은 탭과 표를 최소화하고, 계산 과정(기본 비중, 민감도 등)을 쉬운 말로 설명합니다.
9. **검증 방식** [결정]
   - 계산, 코드, 수치는 설명이 아니라 실제 실행으로 검증합니다.
   - 수치에는 출처나 계산 경로를 남깁니다. 예: `[computed]`, `[web: 출처]`, `[uncertain]`

---

## Project Overview

- **무엇인가**
  - 미국 상장 ETF 25종으로 구성한 멀티에셋 인컴/배당 포트폴리오를 관리합니다.
  - 매월 월말 데이터로 다음 달 목표비중(Target)을 계산합니다.
  - 실제 보유(Actual)와 비교해 리밸런싱 주문을 만듭니다.
- **역할 분리** [결정]

  | 구성요소 | 역할 |
  |---|---|
  | HTML | 화면(UI) |
  | Python | 데이터 수집과 퀀트 엔진 |
  | LLM | 해석 전용. ETF·비중·한도·유니버스를 바꾸지 않음 |

- **개발 경과** (Claude Project에서 진행)
  1. 1단계: 유니버스 구축 — 후보 108종 → 22종
  2. 2단계: 월간 최적화 v1.0 → v2.0 → v3.0 (25종)
  3. 3단계: 월간 운용 시스템 v1.0 (로컬 실행형)
- **다음 단계**: 이 저장소를 기반으로 GitHub(클라우드) 실행으로 이전합니다 [계획].

## Objective

- **포트폴리오 목표** [결정]
  - 인컴 7%+ (소프트 벌점으로 추구, 하드 제약 아님)
  - 총수익 10%+ (목표치이며 보장 아님)
  - 월 1회 리밸런싱: 월말 컷오프 → 익월 첫 거래일에 적용
  - 리밸런스 밴드와 거래비용 반영
  - 커버드콜 과다 편입 관리
  - 워크포워드/OOS로 파라미터 검증
  - Look-ahead 방지
- **시스템 목표** [결정]
  - 매월 코드를 수정하지 않고 기준일(as_of)만 바꾸거나 자동 인식해 같은 파이프라인을 반복합니다.
  - 파이프라인: 데이터 → 검증 → 국면 → 점수 → 리스크 → 최적화 → 목표 → 실보유 비교 → 주문 → 내보내기
- **이번 이사의 목표** [결정]
  - 로컬 실행을 GitHub 기반 클라우드 실행으로 옮깁니다: GitHub Actions + (선택) Pages.
  - 자동 실행(schedule)과 수동 실행(Update 버튼 / workflow_dispatch)은 **별개 기능**으로 구분합니다.

## Current Architecture [현재 — 로컬 실행형 v1.0]

```
[브라우저] dashboard/taa_pm_dashboard_v1.0.html
   ├─ 정적 모드: 내장 결과(seed JSON) 표시 + 실보유 비교·주문·CSV (서버 불필요)
   └─ 백엔드 모드: server.py(127.0.0.1:8765)가 같은 HTML을 서빙 → /api/* 호출
          │
[로컬 Python] server.py (stdlib ThreadingHTTPServer, 한 번에 작업 1개)
   └─ qpm.pipeline: update_data → validate → run_model → submit_actual → export
          │
   ├─ data/     yfinance·FRED·ALFRED 캐시 (덮어쓰기)
   ├─ history/  월별 결과 (history/<데이터월>/)
   ├─ params/   백테스트 v3.0 결과(정적)·워크포워드 제안
   └─ output/   latest.json · 결과 내장 대시보드 · Excel/CSV
```

- GitHub 저장소, GitHub Pages, GitHub Actions는 **현재 없음**. 이 저장소가 첫 번째 커밋입니다.
- 명령어 실행 스크립트(저장소 루트)

  | 스크립트 | 역할 |
  |---|---|
  | `update_data.py` | 데이터 업데이트 |
  | `portfolio_engine.py` | 모델 실행 (`--update`, `--as-of`, `--basis`, `--llm`) |
  | `rebalance_cli.py` | 실보유 비교·주문 |
  | `export_excel.py` | Excel·CSV 내보내기 |
  | `walkforward_cli.py` | 워크포워드 재선정 제안 |
  | `run_server.bat/.sh`, `run_monthly.bat/.sh` | 실행 편의용 |

## Repository Structure

**v1.0 zip에서 온 구조** [현재]

```
config/     universe.json · model_params.json · fred_series.json · settings.json
qpm/        __init__ config data_layer macro etf_stats scoring engine analytics
            rebalance validation history export backtest commentary dashboard pipeline
dashboard/  taa_pm_dashboard_v1.0.html          (2026-09-29 결과 내장, seed 마커 포함)
data/       market/*.csv.gz(8개 필드) · fred/<ID>.csv(33) · alfred/<ID>_<YYYYMMDD>.csv(12)
            reference/PFF_top_holdings.csv · _last_update.json
history/    index.json · 2026-08/(seed) · 2026-09/(live) · _reference/backtest_chain_weights.csv
params/     backtest_v3.0.json
output/     latest.json · taa_pm_dashboard_v1.0_latest.html
sample/     actual_portfolio_sample.csv          (가상의 테스트용 보유)
server.py  update_data.py  portfolio_engine.py  rebalance_cli.py  export_excel.py  walkforward_cli.py
run_server.bat/.sh  run_monthly.bat/.sh  requirements.txt  .env.example
```

**이사 키트에서 추가하거나 옮긴 파일** (코드 변경 없음)

| 파일 | 내용 |
|---|---|
| `CLAUDE.md` | 이 파일 |
| `README.md` | GitHub용으로 새로 작성. v1.0 원본은 `docs/LOCAL_RUN_v1.0.md`로 이동(내용 그대로) |
| `docs/HANDOVER.md` | 상세 인수인계 문서 |
| `.gitignore` | 비밀값·실보유·내보내기 파일 제외 |
| `tests/check_golden.py` + `tests/golden_2026-09.json` | 결과 재현(회귀) 테스트 |
| `tests/check_rebalance_parity.py` | JS·Python 주문 계산 일치 테스트 |

## Data Sources

| 소스 | 용도 | 접근 | 상태 |
|---|---|---|---|
| yfinance | 25 ETF + proxy 5종(BIL·IAU·HYG·QQQ·SPY) + ^IRX(무위험) + XLF(PFF 분석용)의 OHLC·Adj Close·Volume·Dividends·Splits | 키 불필요 | [현재] |
| FRED fredgraph.csv | 33개 매크로 시리즈 | 키 불필요. **custom User-Agent를 보내면 503 → requests 기본 UA 사용** | [현재] |
| FRED API | 위와 동일 | `FRED_API_KEY` 필요 | [부분] 미검증 |
| ALFRED alfredgraph.csv `?id=..&vintage_date=YYYY-MM-DD` | 기준일 시점 빈티지(12 시리즈) | 키 불필요 | [현재] |
| ALFRED API (realtime_start/end) | 위와 동일 | `FRED_API_KEY` 필요 | [부분] 미검증 |
| Yahoo funds_data | PFF 상위 보유 10종(참고) | 키 불필요 | [현재] |
| Anthropic Messages API | AI 해설(선택) | `ANTHROPIC_API_KEY` 필요 | [부분] 미검증 |
| Morningstar (MCP) | 1단계 스크리닝, 듀레이션 값 | Claude Project 전용 | 저장소에서는 사용 안 함 |

- 듀레이션 값은 `config/universe.json`에 정적으로 저장되어 있습니다 (Morningstar 2026-09 기준).
- PFF 듀레이션은 FPE 5.42를 대용(Proxy)합니다.

## Data Pipeline [현재]

| 단계 | 함수 | 내용 |
|---|---|---|
| ① 시장 | `DataLayer.update_market` | 2009-01-01부터 전체 재다운로드. 장이 마감되지 않은 당일 행은 뉴욕 16:30 전이면 제거 |
| ② 매크로 | `update_fred` + `fetch_vintages` | 시리즈별로 다운로드. 실패하면 캐시 사용. 수정치(revision) 건수를 기록 |
| ③ 검증 | `validation.validate_data` | ERROR가 하나라도 있으면 `ValidationError`로 실행 중단 |
| ④ 국면 | `macro.build_macro` | as_of 이후 데이터는 사용하지 않음 |
| ⑤ ETF 통계 | `etf_stats.build_context` | |
| ⑥ 점수 | `scoring.build_scores` | |
| ⑦ 공분산 | `engine.covariance` | |
| ⑧ 리스크 | `analytics.factor_betas` | |
| ⑨ 파라미터 | `config/model_params.json` | 고정값 로드. 워크포워드 재선정 필요 여부만 표시 |
| ⑩ 최적화 | `engine.optimize` → `engine.apply_band` | |
| ⑪ 목표·분석 | | 지표, 제약 진단, 프론티어, 민감도, 스트레스, 0% 분석, CLO/PFF 분석, 해설 → `history/<월>/` 저장 |
| ⑫~⑭ 실보유·주문 | `pipeline.submit_actual` → `rebalance.compare` | |
| ⑮ 내보내기 | `export.export_excel` / `export_csv_bundle` | |

- **Model Current** = 직전 월 목표 × (TR(as_of) ÷ TR(직전 as_of)), 합계 1로 정규화합니다. 추정치일 뿐 실보유가 아닙니다.
- **12개월 롤링 인컴 이력** = `history/index.json`의 `income_history`에서 직전 11개 월을 사용합니다.

## Investment Universe [결정 — 25종 고정, 코드·HTML에서 재선정 금지]

| 자산군(표시) | ETF | 최적화 클래스 |
|---|---|---|
| Covered Call | JEPQ, GPIX, JEPI | CoveredCall |
| Dividend | SCHD, VYMI, VIG | Dividend |
| Equity | VOO, QQQM, VEA, IEMG | Equity (= pure equity) |
| Cash | SGOV | Cash |
| Treasury / Bond | VGSH, VGIT, VGLT, SCHP, VCIT, USHY | Bond |
| CLO AAA | JAAA | CLO |
| CLO BBB | JBBB | CLO |
| Preferred | PFF | Preferred |
| Alternative | DBMF | Alt |
| Real Asset | PDBC, SCHH, IGF, GLDM | RealAsset |

**리스크 슬리브** (`config/universe.json::sleeves`)

| 슬리브 | 구성 |
|---|---|
| credit_risk | VCIT, USHY, **JBBB, PFF** — 크레딧 한도 25% 적용 대상 |
| clo_aaa | JAAA — 크레딧과 **별도**, 한도 15% |
| defensive | SGOV, VGSH, VGIT, VGLT, GLDM |
| pure_equity | VOO, QQQM, VEA, IEMG |
| covered_call | JEPI, JEPQ, GPIX |
| duration_assets | VGLT, VGIT, SCHP, VCIT, PFF |
| risk_assets | pure_equity + covered_call + credit_risk + SCHD, VIG, VYMI, SCHH, IGF |

**Proxy와 기준 티커**

- 상장 전 기간은 Total Return을 다음 proxy로 이어 붙입니다: SGOV←BIL, GLDM←IAU, USHY←HYG, QQQM←QQQ, VOO←SPY. 분배금과 가격도 같은 방식으로 연결합니다.
- 무위험수익률: ^IRX(13주 국채) ÷ 100
- 듀레이션(년): SGOV 0.12, VGSH 1.86, VGIT 4.85, VGLT 13.52, SCHP 6.34, VCIT 5.96, USHY 2.95, JAAA 0.14, JBBB 0.16, PFF 5.40(Proxy). 그 외는 0.
- `inception` 필드는 표시용입니다. 계산에는 실제 가격 시작일을 씁니다.

## Model Methodology [현재 = Model v3.0, 변경 금지]

### 국면 (`qpm/macro.py`)

- 월말 격자는 1999-12 ~ as_of가 속한 달입니다.
- z와 백분위는 롤링 120개월(최소 60개월) 기준입니다.

**복합 z 구성**

| 복합 z | 구성 요소의 롤링 z 평균 |
|---|---|
| Growth z | INDPRO yoy, PAYEMS 3개월 평균 증감, −UNRATE 3개월 변화, −ICSA(4주 평균) yoy, RSXFS yoy |
| Inflation z | 근원CPI 3개월 연율, 근원CPI yoy, 근원PCE yoy, T5YIE, MICH |

**요인별 판정 규칙**

| 요인 | 규칙 |
|---|---|
| Growth | 복합 z의 3개월 변화 > +0.25 → Improving, < −0.25 → Deteriorating |
| Inflation | 복합 z의 3개월 변화 ±0.25 → Rising / Falling |
| Rates | DGS10 3개월 변화 ±25bp → Rising / Falling |
| Credit | BAA10Y 3개월 변화 > +15bp → Deteriorating, < −15bp → Improving |
| Volatility | VIX 1개월 평균 > 25 → High, < 15 → Low |
| Liquidity | NFCI > 0 → Tight, < −0.4 → Loose |
| Dollar | DTWEXBGS 3개월 변화 ±2% → Rising / Falling |

**종합 국면** (위에서부터 순서대로 적용)

1. Risk-Off: Volatility High, 또는 (Credit Deteriorating 이고 Volatility가 Low가 아님)
2. Recession: Growth Deteriorating 이고 Growth z < −1
3. Stagflation: Growth Deteriorating 이고 Inflation Rising
4. Slowdown: Growth Deteriorating
5. Reflation: Inflation Rising 이고 Growth Improving
6. Inflation: Inflation Rising
7. 그 외: Growth + Disinflation

**위험 상태 (RISK_STATE)**

- RiskOff: Volatility High 또는 Credit Deteriorating
- RiskOn: Volatility Low 이고 Growth가 Deteriorating이 아님
- 그 외: Neutral

**방어 상태 (DEF_STATE)**

- Crisis: Volatility High 이고 (Credit Deteriorating 또는 Growth Deteriorating)
- HighRisk: Volatility High, Credit Deteriorating, Growth Deteriorating 중 하나
- 그 외: Normal

### ETF 통계 (`qpm/etf_stats.py`)

- 월말 평가는 2011-12-31부터 합니다.
- 수익률: 1·3·6·12·24개월, 5년 CAGR
- 변동성: 3·6·12개월 (일간 × √252)
- 12개월 지표: 하방편차, MDD, CVaR95(일간 최악 5%), Sharpe(^IRX 초과), Sortino, Calmar
- 인컴
  - TTM 수익률 = 365일 분배금 합 ÷ 종가
  - 분배 성장률 = 현재 TTM 분배금 ÷ 1년 전 TTM 분배금 − 1
  - 분배 안정성 = 1 − (분기 합의 표준편차 ÷ 평균)
- 상대 모멘텀 6개월 = 6개월 수익률 − 가용 종목 중앙값
- 가용 조건: 현재와 12개월 전 Total Return이 모두 있어야 합니다.
- 매크로 조건부 Sharpe
  - **t보다 이전 달만** 사용합니다.
  - (Growth, Inflation, Rates) 국면이 같은 달이 12개월 이상이면 그 달들을 씁니다.
  - 부족하면 종합 국면이 같은 달을 씁니다(12개월 이상).
  - 전체 이력이 24개월 이상이어야 하고, ETF별 관측치가 12개 이상이어야 합니다.

### 점수 (`qpm/scoring.py`)

- 공통 함수
  - `rz`: 자기 이력 z. shift(1), 창 L=24, 최소 max(6, L/2), ±3에서 자름
  - `csz`: 횡단면 z. ±3에서 자름

| 구성 | 계산 |
|---|---|
| 모멘텀 | csz(평균[rz(ret3), rz(ret6), rz(ret12), csz(relmom6)]) |
| 위험조정 | csz(평균[rz(sharpe12), csz(sortino ±5에서 자름), csz(calmar ±5에서 자름)]) |
| 인컴 | csz(평균[csz(yield), csz(rz(yield)), csz(분배성장, 결측 0, ±1), csz(분배안정, ±1, 결측 −1)]) |
| 매크로 | csz(조건부 Sharpe, ±4에서 자름), 결측 0 × min(1, 관측월/24) |
| 위험 벌점 | csz(평균[csz(vol6), csz(−mdd12), csz(−cvar12), rz(vol6)]) |
| **총점 (cfg A)** | 0.25·모멘텀 + 0.25·위험조정 + 0.25·인컴 + 0.25·매크로 − 0.25·위험. 가용하지 않은 ETF는 NaN |

### 기대수익과 리스크 (`qpm/engine.py`)

- **기대수익 μ** = 기본 + κ·vol12·점수 + 국면 틸트·vol12
  - 기본 = 0.5·과거 120개월 평균 + 0.5·횡단면 평균
  - 과거 평균은 관측 36개월 이상일 때만 쓰고, 부족하면 횡단면 평균으로 채웁니다.
- **국면 틸트** (`universe.json::regime_overlay`)

  | 조건 | 조정 |
  |---|---|
  | 금리 상승 | 듀레이션 자산 −0.2 (하락 시 +0.2) |
  | 물가 하락 | VGSH·VGIT·VGLT +0.1 |
  | 물가 상승 | SCHP·PDBC·GLDM +0.1 |
  | 크레딧 악화 | 크레딧 슬리브 −0.2, 분산 ×1.5 / JAAA −0.1, 분산 ×1.5 |
  | 크레딧 개선 | 크레딧 슬리브 +0.1 |
  | RiskOff | 위험자산 −0.2, 분산 ×1.3 / 방어자산 +0.1 |

- **공분산**
  - 최근 60개월 월간 수익률 × 12, 쌍별 최소 12개 관측
  - 결측은 0으로 채우고, 대각행렬 쪽으로 30% 수축
  - 고유값 하한 1e-6

## Optimization [현재]

**목적함수 (최대화, cvxpy + CLARABEL)**

```
μ'w − 2λ·w'Σw − λ_c·Σw² − λ_cvar·CVaR95(w; 최근 60개월 시나리오) − tc·|w − w_prev|₁
    + λ_y·y'w − λ_inc·max(0, T − inc_eff)²
inc_eff = (직전 11개월 목표 인컴 합 + y'w) / 12
```

- 파라미터 값

  | 기호 | 값 |
  |---|---|
  | λ | 1.5 |
  | λ_c | 0.5 |
  | λ_cvar | 0.5 |
  | tc | 0.001 |
  | λ_y | 0.5 |
  | λ_inc | 50 |
  | T (목표 인컴) | 7% |

- y는 TTM 분배수익률입니다.

**제약**

- 비중 합 = 1, w ≥ 0
- 한도: 단일 15%, 커버드콜 30%, 크레딧(VCIT·USHY·JBBB·PFF) 25%, JAAA 15%, 순수주식 45%, 배당 35%, 실물 25%, DBMF 10%
- SGOV 최소 3%
- 순수주식 하한 (위험 상태별): RiskOn 15%, Neutral 10%, RiskOff 5% — E2
- 방어 하한 (방어 상태별): Normal 15%, HighRisk 20%, Crisis 30% — D3

**풀리지 않을 때의 대체 경로**

1. 하드 인컴이 불가능하면 소프트 벌점으로 바꿔 다시 풉니다.
2. 그래도 불가능하면 동적 하한을 제거하고 풉니다.
3. 그래도 실패하면 오류로 중단합니다.

**밴드** (`apply_band`)

- `|raw − current| < 1.5%p` 이고 current가 단일 한도 이하면, 현재 비중을 그대로 유지합니다.
- 남는 비중은 거래하는 종목에 비례 배분합니다.
- 단일 한도를 넘는 부분은 SGOV로 보냅니다.
- current는 Model Current입니다. `--basis actual`이면 실보유를 씁니다.
- 이 규칙은 백테스트와 라이브에 동일하게 적용됩니다.

## Backtest Methodology

- **구현** [현재]: `qpm/backtest.py::run_path`
  - 2014-12-31부터 매월말 의사결정을 합니다.
  - 적용 수익률은 다음 달 Total Return입니다.
  - 첫 달 이후부터 밴드를 적용하고, 거래비용은 10bp × 회전율입니다.
  - 인컴 이력을 누적합니다.
- **대시보드에 표시하는 수치** [현재 — 정적]: `params/backtest_v3.0.json`
  - v3.0 세션에서 **이사 전 코드(패키지 외부 스크립트)**로 산출한 값입니다.
  - OOS 구간: 2017-01 ~ 2026-08
  - 구분을 반드시 유지합니다 [결정]:

  | 구분 | 성격 |
  |---|---|
  | `Honest OOS (annual walk-forward)` | 정직한 OOS |
  | `Fixed params (partial in-sample)` | 부분 In-Sample |
  | `M6-Soft Fixed Parameter Reference (final, partial in-sample)` | 부분 In-Sample |
  | `Benchmark` | 비교 기준 (M0 Buy&Hold, M1 Monthly EW) |

- **주요 결과** (v3.0, 2017-01 ~ 2026-08)

  | 모델 | CAGR | Sharpe | MDD |
  |---|---|---|---|
  | M6-Soft WF OOS | 6.43% | 0.635 | −10.4% |
  | 고정 파라미터 최종 | 7.08% | 0.756 | −7.9% |
  | M0 Buy&Hold | 9.48% | 0.711 | −19.9% |

  - 총수익 목표 10%는 백테스트에서 달성하지 못했습니다.
- **한계**
  - 과거 매크로는 현재 빈티지에 발표시차 규칙만 적용한 데이터입니다. 수정치 look-ahead가 남아 있습니다.
  - 유니버스를 2026-09에 선정했으므로 사후 선택(생존) 편향이 있습니다.

## Walk-forward Methodology

- **v3.0 절차** [현재 — 결과는 정적 파일]
  1. 연 단위(2017~2026)로 진행합니다.
  2. 직전 36개월 성과로 조합을 평가합니다. 종합순위 = Sharpe·Sortino·MDD·CVaR 순위의 평균. 동률이면 회전율이 낮은 쪽을 고릅니다.
  3. 고른 조합을 다음 해에 적용합니다.
- **그리드**

  | 단계 | 대상 |
  |---|---|
  | 1 | L {12, 24} × cfg {A, C} × κ {0, 0.5, 1.0} × λ {1.0, 1.5} = 24개 조합 (소프트 인컴 구조) |
  | 2 | 방어 하한 D1(5/10/15) / D2(10/15/25) / D3(15/20/30) × 주식 하한 E1(10/5/0) / E2(15/10/5) |
  | 3 | 밴드 {0.5, 1.0, 1.5%} × 창 {36, 60개월} |

  - 인컴 처리 방식(λ_inc 50·200, 코리도 등)은 고정 파라미터 비교로 결정했습니다.
- **최종 선택 방식**
  - 연도별 선택의 최빈값을 쓰고, 동률은 전 기간 종합순위로 정했습니다(부분 In-Sample).
  - 2·3단계의 연도별 선택은 **실행 로그에서 옮겨 적은 값**입니다.
- **재선정 경로** [부분]: `walkforward_cli.py` / `run_walkforward`
  - 1단계 그리드를 사용하며, 직전 36개월 종합순위로 **제안만 저장**합니다: `params/wf_proposal_*.json`
  - 적용하려면 사용자가 `config/model_params.json`을 직접 수정해야 합니다.
  - 2개 조합 축소 실행(19초)만 검증했습니다. 전체 24개 조합은 미검증입니다.

## Dashboard [현재 — `dashboard/taa_pm_dashboard_v1.0.html`, 단일 파일]

- **외부 의존성 0**
  - CDN, 외부 폰트, 외부 URL, `<link>`, 외부 스크립트가 없습니다.
  - 차트는 JS가 직접 만드는 SVG입니다.
  - 폰트는 시스템 한글 폰트 목록으로 지정합니다.
  - localStorage는 쓰지 않습니다.
- **데이터 읽기**
  1. 기본: 내장 JSON `<script id="seed-data" type="application/json">…</script><!--/seed-data-->`
  2. 백엔드 모드: `/api/status`가 응답하면 `/api/result/latest`, `/api/history`를 읽습니다.
  3. "결과 파일 열기"로 `result.json`을 직접 불러올 수 있습니다.
  - seed 마커를 바꾸면 `qpm/dashboard.py::embed`가 깨집니다.
- **화면 구성**
  - 헤더: 기준일, 리밸런싱일, 모델, FRED 연결 정보
  - 이번 달 할 일 1~6단계
  - 한눈에 보기 (8개 타일)
  - 시장 국면 7개 요인
  - 다음 달 목표: 자산군 막대, Target / Model Current / 원 최적화 / 실보유 / 조치, "비중은 이렇게 정해졌습니다" 설명
  - 실보유 입력: CSV 업로드와 직접 입력, 주문과 노출 비교
  - 제약 진단
  - 상세 분석 (펼침): 점수표, CLO·PFF 분석, 프론티어·완화, 민감도, 스트레스, 0% 분석, 백테스트, 워크포워드, 이력, 검증, 한계, 해설
- **JS 주문 엔진**
  - 위치: `// ==== REBALANCE ENGINE START/END ====` 블록
  - `qpm/rebalance.py`와 **동일 알고리즘**입니다. 샘플 입력으로 대조한 차이는 0입니다.
- **백엔드 전용 기능**: 업데이트, 검증, 실행, 워크포워드, FRED 모드 변경, Excel 내보내기
- **정적 모드에서 동작하는 기능**: 조회, 실보유 비교, CSV 내보내기

## Data Update Architecture

**현재** [현재]

- 로컬에서 `update_data.py` 또는 서버의 update 작업을 실행하면 `data/`를 덮어씁니다.
- 이후 `portfolio_engine.py`가 캐시를 읽어 계산합니다.
- 클라우드 실행과 자동 실행은 없습니다.

**목표** [계획, 상세는 `docs/HANDOVER.md` C·D]

```
(수동) 대시보드 Update 버튼 ─┐
(수동) Actions "Run workflow" ─┼─> workflow_dispatch ─┐
(자동) schedule(cron, UTC)  ─────────────────────────┴─> Actions 러너: pip install → ci 스크립트
   → update_data(as_of) → validate(ERROR면 실패 종료, 커밋 안 함) → run_model(월간일 때)
   → output/status.json 작성 → 검증 통과 시에만 git commit/push → (선택) Pages 반영
```

**원칙**

- 자동 실행과 수동 실행은 워크플로와 트리거를 분리합니다.
- 두 실행이 동시에 돌지 않도록 `concurrency` 그룹을 공유합니다.
- 월간 실행은 `--as-of <직전 월 마지막 거래일>`을 **반드시 명시**합니다 (K-2).
- 마감된 월(history)은 덮어쓰지 않습니다 (K-4).

## yfinance [현재]

| 항목 | 내용 |
|---|---|
| 호출 | `yf.download(tickers, start="2009-01-01", end=as_of+1일, auto_adjust=False, actions=True)` 1회 |
| Adj Close | `auto_adjust=True`의 Close와 동일함을 확인. Total Return에 사용 |
| Close + Dividends | TTM 수익률과 분배 지표에 사용 |
| 저장 | `data/market/{adj_close,close,open,high,low,volume,dividends,stock_splits}.csv.gz` (행=날짜, 열=티커) |
| 빈도 | 일간 → 월말(`resample("ME").last()`) |
| 날짜 기준 | 거래소 현지 날짜. 미완성 세션 판정만 뉴욕 시간 사용(`zoneinfo`, Windows는 `tzdata` 필요) |
| 결측·휴장 | 티커 합집합 날짜 기준. 결측은 NaN 유지. 일간 수익률은 직전값이 NaN이면 NaN |
| 캘린더 | `qpm/config.py`의 NYSE 휴장일 규칙 계산(특별 휴장 미반영). 리밸런싱일과 지연 판정에 사용 |
| **merge 정책** | 증분 병합 없이 **전체 재다운로드 후 덮어쓰기** |

- 전체 재다운로드를 하는 이유: 배당이 발생하면 Adj Close의 과거 값 전체가 재조정되므로 부분 병합을 하면 불연속이 생깁니다 [memory, 설계 판단].
- 이 방식의 위험(K-1): 일부 티커 다운로드에 실패해도 NaN으로 캐시를 덮어쓴 **뒤에** 검증이 이를 잡습니다.

## FRED [현재 + 계획]

**관측일 vs 이용 가능일 원칙** [결정]

- 투자 판단 시점 t에는 **t까지 실제로 공개된 값만** 씁니다.
- 예: 10월 말 데이터로 11월 목표를 만들 때, 11월에 발표된 지표는 쓰지 않습니다.

**[현재] 구현**

- 일간 시리즈: as_of 이후 값을 버립니다.
- 월간 시리즈
  - 관측월 m의 값은 m+lag월 말 라벨에 배치합니다(v3.0 규칙). lag는 대부분 1, MICH는 0.
  - 발표일 가드: 통상 발표일(PAYEMS·UNRATE 7일, CPI 15일, INDPRO·RSXFS 17일, PCE 30일, MICH 28일, GDP 분기말+28일)이 as_of보다 뒤면 제외합니다.
  - 이 통상 발표일은 **추정값**입니다.
- 주간 시리즈: 발표 지연을 반영합니다. ICSA·NFCI·ANFCI +5일, WALCL·WRESBAL +1일.
- 분기 시리즈: 분기말 + 1개월 라벨에 배치합니다.
- **ALFRED as-of 빈티지**
  - 수정되는 12개 시리즈를 기준일 시점 공개값으로 **통째로 교체**합니다: INDPRO, PAYEMS, UNRATE, RSXFS, GDPC1, CPIAUCSL, CPILFESL, PCEPI, PCEPILFE, MICH, NFCI, ANFCI
  - 빈티지 시리즈에는 발표일 가드와 주간 지연을 적용하지 않습니다.
  - 파일은 `data/alfred/<ID>_<YYYYMMDD>.csv`로 저장해 재현할 수 있습니다.
- 수정치 감지: 새로 받은 값과 기존 캐시의 겹치는 관측치를 비교해 건수와 최대 차이를 검증 결과에 INFO로 표시합니다.
- ICE BofA OAS(BAMLH0A0HYM2, BAMLC0A0CM)는 FRED에서 최근 3년만 제공됩니다. 그래서 크레딧 국면은 BAA10Y로 판정하고, HY OAS는 표시용으로만 씁니다.

**[계획]**

- 관측치별로 `(series_id, observation_date, realtime_start, realtime_end, value, fetched_at)`를 저장합니다 (ALFRED API, 키는 Secrets).
- 백테스트 각 시점에 해당 빈티지를 사용합니다.
- 지금 백테스트는 이 방식이 **아닙니다**.

## GitHub Actions [이사 시점 초안 — 현재 구현은 맨 위 "for_dashboard 통합" 표 참고]

- 초안(미검증)은 `docs/HANDOVER.md` §C-4에 있습니다.
- 권한: `permissions: contents: write`
- Secrets: `FRED_API_KEY`(선택, 키리스 CSV로도 동작), `ANTHROPIC_API_KEY`(선택)
- cron은 UTC 기준입니다. 부하가 높을 때(특히 정시) 지연되거나 드롭될 수 있습니다. 공개 저장소는 60일간 활동이 없으면 schedule이 비활성화됩니다 [web: GitHub Docs 인용].
- 수동 트리거 API(`POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches`)는 fine-grained 토큰에 "Actions" write 권한이 필요합니다 [web: docs.github.com/rest/actions/workflows]. 토큰은 저장소와 HTML에 넣지 않습니다.

## Data Validation [현재 — `qpm/validation.py`]

**데이터 검증**

| 대상 | 규칙 | 등급 |
|---|---|---|
| ETF | 마지막 거래일 지연 1영업일 이상 | WARN |
| ETF | 마지막 거래일 지연 5영업일 초과 | ERROR |
| ETF | 최근 252일 결측 5% 초과 | ERROR |
| ETF | 최근 252일 결측 있음 | WARN |
| ETF | 중복 날짜 | ERROR |
| ETF | 일간 변동 20% 초과(분할일 제외) | WARN |
| ETF | 일간 변동 40% 초과(분할일 제외) | ERROR |
| ETF | 음수 분배금 | ERROR |
| ETF | 최근 3년 분배금이 가격의 5% 초과 | WARN |
| ETF | 이력 24개월 미만 | WARN |
| ETF | 20일 평균 거래량 5만 주 미만 | WARN |
| ETF | 종가+분배 재계산 Total Return과 Adj Close 차이 0.5%p 초과 | WARN |
| 기준일 | 거래일이 아님 | WARN |
| 기준일 | 월말 이전(부분 월) | WARN |
| FRED | 필수 시리즈 누락 | ERROR |
| FRED | 최근 관측일이 빈도별 허용치 초과 | WARN |
| FRED | 빈도 불일치 | WARN |
| FRED | 다운로드 실패로 캐시 사용 | WARN |
| FRED | 빈티지 적용 여부 | INFO / WARN |

**모델 검증**

| 규칙 | 등급 |
|---|---|
| 비중 합 ≠ 1, 음수, NaN | ERROR |
| 원 최적화가 한도·하한 위반 | ERROR |
| 밴드 유지로 최종 비중이 한도 이탈 | WARN |
| 공분산 PSD (수축 후 최소 고유값) | INFO / WARN |
| 최적화 수렴 상태 | INFO / WARN |
| 인컴 재계산 불일치 | ERROR |

## Important Design Decisions

| # | 결정 | 근거·출처 |
|---|---|---|
| D1 | 유니버스 25종 고정. 1단계 22종에 v3.0에서 JAAA·JBBB·PFF 추가 | [결정] 2026-09-30 |
| D2 | 인컴 7%는 **소프트 이차 벌점(12개월 평균)**, λ_inc=50 | v3.0 비교에서 코리도·하드보다 우수(`params/backtest_v3.0.json`) |
| D3 | 동적 하한 D3/E2, 밴드 1.5%p, 공분산·CVaR 60개월, L24·cfg A·κ1.0·λ1.5 | v3.0 워크포워드 최빈값 + 동률 처리 |
| D4 | 크레딧 슬리브에 JBBB·PFF 포함. JAAA는 별도 한도 | [결정] |
| D5 | Model Current·Target·Actual 구분. 실보유가 없으면 "Actual Portfolio: Not Provided" | [결정] |
| D6 | 기대수익 κ=1.0(모델값 13.5%)은 OOS 실현치와 분리해 표시 | [결정] |
| D7 | 0% ≠ 투자 부적격. 이유를 Score / Risk / Correlation / Constraint / Band로 구분 | [결정] |
| D8 | 한계 라벨: Computed / Actual / Estimated / Proxy / Insufficient Sample (+ Not modelled) | [결정] |
| D9 | 월간 실행에 ALFRED as-of 빈티지 사용(키 불필요 경로) | System v1.0 |
| D10 | 밴드 규칙을 백테스트와 라이브에 동일하게 적용 | System v1.0 (v3.0 불일치 해소) |
| D11 | 리밸런싱일 = 다음 달 첫 NYSE 거래일 (2026-10-30 → **2026-11-02**) | 스펙 예시의 11-01은 일요일 |
| D12 | 워크포워드 재선정은 제안만 하고 자동 적용하지 않음 | System v1.0 |
| D13 | PFF 금융주 집중도는 데이터 없음 → XLF 베타(Proxy) | 공급사 섹터 데이터가 보통주 부분 약 5%만 반영 |

## Known Issues

| # | 문제 | 상태 |
|---|---|---|
| K-1 | `update_market`이 검증 **전에** 캐시를 덮어씀. 일부 티커 실패 시 NaN 캐시가 남음. CI에서는 "검증 통과 시에만 커밋"으로 보호 가능 | 로컬 위험 |
| K-2 | `detect_as_of`는 **마지막 거래일**을 반환. 월초에 기준일 없이 실행하면 그 날짜가 기준일이 되어 다음 월 목표가 됨 → 월간 자동화는 `--as-of` 필수 | 미수정 |
| K-3 | `submit_actual`(서버 `/api/actual`, `rebalance_cli.py`)가 실보유를 `history/<월>/actual_portfolio.csv`, `rebalancing_order.csv`, **`result.json`, `output/latest.json`, 결과 내장 HTML**에 기록. 클라우드 이전 전 저장 경로 분리 또는 비활성화 필요. 브라우저 정적 모드 계산은 아무것도 저장하지 않음 | P1 |
| K-4 | 같은 월을 다시 실행하면 `history/<월>`을 덮어씀(마감 월 보호 없음) | 미수정 |
| K-5 | v3.0 8월 목표를 이 패키지로 재산출하면 최대 0.98%p(JEPQ) 차이. 원인은 밴드 규칙 통일로 추정했으며 분리 검증은 안 됨 | [uncertain] |
| K-6 | 점수 특이점: 분배성장·분배안정의 결측 채우기가 횡단면 z 계산 **전에** 적용되어 미가용 ETF가 통계에 섞임. 재현성을 위해 유지, v3.1 후보(승인 필요) | 유지 |
| K-7 | 백테스트 매크로는 빈티지를 쓰지 않음(수정치 look-ahead). 라이브는 빈티지 사용 → 데이터 기준이 다름 | 설계 한계 |
| K-8 | 발표일 가드의 통상 발표일은 추정값 | Estimated |
| K-9 | 미검증: Windows, 사내망, FRED API 모드, ALFRED API, AI 해설 호출, 전체 워크포워드, GitHub Actions 러너에서의 yfinance·FRED 접속 | 미검증 |
| K-10 | `requirements.txt`는 하한만 지정. 검증된 조합: Python 3.12.3, pandas 3.0.2, numpy 2.4.4, cvxpy 1.9.3, yfinance 1.7.0, openpyxl 3.1.5 | 고정 필요 |
| K-11 | 스펙 §3의 "Actual Income" 지표 미구현. 목표 인컴과 12개월 평균만 표시 | 미구현 |
| K-12 | 백테스트 수치는 이사 전 스크립트 산출물(정적). 패키지로 전체를 다시 돌려 재현하지 않았음 | 미검증 |
| K-13 | JAAA(2020-10 상장)·JBBB(2022-01 상장) 모두 2020년 위기 미경험 → CLO 스트레스 과소추정 가능 | 표시 중 |
| K-14 | `history/2026-08`은 v3.0 9월 드리프트 비중을 역산해 만든 초기값(seed) | 삭제 금지 |

## Do Not Change (사용자 승인 없이 변경 금지)

**투자 모델**

- `config/universe.json`: 티커, 자산군, 슬리브, proxy, 국면 틸트 규칙
- `config/model_params.json`: 모든 파라미터. 워크포워드 제안도 자동 적용 금지
- 계산 로직: `qpm/scoring.py`, `qpm/engine.py`(목적함수, 제약, 대체 경로, 밴드), `qpm/macro.py`(임계값, 판정 순서), `qpm/etf_stats.py`(지표 정의)

**데이터 무결성**

- Look-ahead 통제: as_of 절단, 발표시차 규칙, 빈티지 교체, 조건부 통계에서 t 이전 달만 사용
- `history/` 기록: 특히 `2026-08` seed, `2026-09` live, `index.json::income_history`
  - Model Current 드리프트와 12개월 롤링 인컴 계산에 필요합니다.

**대시보드**

- seed 마커 `<script id="seed-data" type="application/json">`, `</script><!--/seed-data-->`
- JS 주문 엔진과 `qpm/rebalance.py`의 동일성

**표시 원칙**

- Model Current·Target·Actual 구분
- LLM은 해석만 담당
- Honest OOS와 부분 In-Sample 라벨 구분
- 0% ≠ 부적격
- 한계 라벨
- HTML 파일명 버전 표기

## Future Development

상세 백로그는 `docs/HANDOVER.md` §G-4에 있습니다.

| 우선순위 | 작업 |
|---|---|
| **P1** | 비공개 저장소 구성과 골든 테스트 CI |
| **P1** | `scripts/ci_run.py`(신규): 업데이트 → 검증 → (월간) 모델 실행 → `output/status.json`, 실패 시 non-zero 종료 |
| **P1** | 수동 워크플로(workflow_dispatch) |
| **P1** | 실보유 저장 분리 (K-3) |
| **P1** | 월간 기준일 계산: 직전 월 마지막 거래일 (K-2) |
| **P2** | 월간 스케줄 워크플로 (중복 실행 방지, 마감 월 보호 K-4) |
| **P2** | 대시보드 정적 호스팅 모드: 상대경로로 `output/latest.json`·`status.json` 읽기, Update 버튼(워크플로 페이지 링크) |
| **P2** | 시장 데이터 안전 쓰기 (임시 저장 → 검증 → 교체) |
| **P2** | Actual Income 지표 |
| **P3** | 관측일·발표일 저장소와 빈티지 백테스트 |
| **P3** | 대시보드 원클릭 dispatch (토큰은 사용자 브라우저 세션에만) |
| **P3** | 전체 워크포워드 워크플로 (제안을 PR로) |
| **P3** | 백테스트 재현 스크립트 |
| **P3** | v3.1 모델 수정 (승인 필요) |

## Version History

| 버전 | 시점 | 내용 |
|---|---|---|
| Universe Phase 1 | 2026-09-28 | 10개 자산군 후보 108종을 스크리닝해 22종 선정 (yfinance + Morningstar) |
| Model v1.0 | 2026-09 | 하드 7%가 기본 한도에서 불가(최대 6.60%) → 완화 한도(CC40·Single20·Credit30) 필요 |
| Model v2.0 | 2026-09 | 스펙 v2: 소프트·코리도 인컴, 동적 하한, κ·λ 워크포워드, M0~M6 비교 → M6-Soft |
| Model v3.0 | 2026-09-30 | JAAA·JBBB·PFF 추가로 25종, 최종 파라미터 확정, 2026-09-29 기준 10월 목표 |
| System v1.0 | 2026-09-30 | 월간 Quant PM 시스템(로컬): 패키지화, 검증, 빈티지, 대시보드, 이력, 내보내기. v3.0 재현 확인(목표비중 차이 6.9e-17) |
| Migration kit | 2026-09-30 | CLAUDE.md, README.md, docs/HANDOVER.md, tests/, .gitignore 추가 (코드 변경 없음) |

## Golden Test (회귀 기준)

```bash
python tests/check_golden.py      # 임시 복사본에서 2026-09-29 재실행 → tests/golden_2026-09.json과 비교 (오프라인)
```

**기준값** (2026-09-29, 10월 목표)

- 목표비중

  | ETF | 비중 | ETF | 비중 |
  |---|---|---|---|
  | JEPQ | 13.73% | JAAA | 4.47% |
  | SCHD | 10.67% | QQQM | 4.01% |
  | GPIX | 10.48% | JBBB | 3.99% |
  | DBMF | 10.09% | VGIT | 3.89% |
  | SGOV | 6.75% | USHY | 3.72% |
  | VOO | 5.92% | PDBC | 2.90% |
  | VYMI | 5.38% | VIG | 1.72% |
  | VGSH | 4.84% | SCHP | 1.40% |
  | JEPI | 4.48% | VGLT | 1.14% |
  | | | VEA | 0.43% |

  - 소수점 둘째 자리까지 표시한 값입니다. 정확한 값은 `tests/golden_2026-09.json`에 있습니다.

  - 나머지(IEMG, VCIT, PFF, SCHH, IGF, GLDM)는 0%입니다.

- 지표

  | 지표 | 값 |
  |---|---|
  | 인컴 (TTM) | 5.37% |
  | 인컴 (12개월 평균) | 5.54% |
  | 기대수익 | 13.51% |
  | 변동성 36M / 60M | 5.30% / 6.33% |
  | Sharpe (36M) | 1.78 |
  | 유효 베타 | 0.46 |
  | 듀레이션 | 0.65년 |
  | 커버드콜 | 28.7% |
  | 크레딧 | 7.7% |
  | CLO AAA | 4.5% |
  | 방어 | 16.6% |
  | 순수주식 | 10.4% |

- 제약 구속 순서: DBMF 한도 > 방어 하한(Normal) > 커버드콜 한도 > 주식 하한(Neutral) > 단일 한도
