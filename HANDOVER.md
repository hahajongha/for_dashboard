# HANDOVER — TAA Income Quant PM System: Claude Project → Claude Code + GitHub

> - 작성일: 2026-09-30
> - 기준 코드: `taa_pm_system_v1.0` (System v1.0 · Model v3.0)
> - 근거 자료:
>   - Claude Project 대화 기록과 산출물
>   - 사용자가 명시한 결정
>   - 이 저장소의 실제 코드·데이터 확인 결과 (파일 목록, 함수, 설정값, 실행 결과)
> - 표기
>
>   | 표기 | 의미 |
>   |---|---|
>   | [현재] | 구현되고 실행으로 검증됨 |
>   | [부분] | 구현됐으나 미검증이거나 제한이 있음 |
>   | [계획] | 미구현 |
>   | [결정] | 사용자 확정 사항 |
>   | [미확인] | 근거 없음 |
>
> - 출처 태그: [computed] 이 저장소에서 실행하거나 파일을 읽어 확인 · [web: …] 외부 문서 · [memory] 일반 지식(검증 필요) · [uncertain] 추정

---

## A. Executive Summary

**무엇인가**

- 미국 상장 ETF 25종 고정 유니버스를 대상으로 하는 월간 TAA 인컴 포트폴리오 운용 시스템입니다.
- 목표는 인컴 7%+(소프트), 총수익 10%+(목표, 보장 아님), 월 1회 리밸런싱입니다 [결정].

**어디까지 왔나**

1. **1단계 — 유니버스**: 108종에서 22종을 선정했습니다.
2. **2단계 — 모델**: v1.0 → v2.0 → v3.0으로 발전했고, v3.0에서 25종(JAAA·JBBB·PFF 추가)이 되었습니다.
3. **3단계 — 운용 시스템 v1.0 (로컬 실행형)**
   - 데이터 업데이트, 검증, 모델 실행, 실보유 비교, 주문, 이력, CSV/Excel, 대시보드를 갖췄습니다.
   - v3.0 결과를 그대로 재현합니다: 목표비중 차이 6.9e-17 [computed].

**지금 없는 것**

- GitHub 저장소, GitHub Actions, GitHub Pages, 클라우드 실행, 자동 실행이 모두 없습니다.
- 이 문서와 저장소가 첫 번째 이전입니다.

**이사의 핵심 원칙**

1. 코드와 methodology는 변경 없이 옮깁니다.
2. 클라우드 실행은 GitHub Actions로 새로 구성합니다.
3. 자동 실행(schedule)과 수동 실행(Update/workflow_dispatch)은 분리합니다.
4. 검증을 통과해야만 커밋합니다.
5. 관측일과 이용 가능일(release/vintage)을 구분합니다.
6. 실보유와 비밀값은 저장소에 넣지 않습니다.

**이사 직후 가장 큰 위험 3가지**

1. 실보유 데이터가 결과 파일에 기록되어 커밋될 수 있습니다 (K-3).
2. 월초 자동 실행 때 기준일을 자동으로 잡으면 다음 달 목표가 잘못 계산됩니다 (K-2).
3. GitHub Pages는 공개 사이트입니다. 저장소가 비공개여도 사이트는 공개됩니다. Enterprise Cloud 제외 [web: docs.github.com/pages].

---

## B. Current Architecture (실제 구조, v1.0)

### B-1. 구성요소와 실행 경로 [현재]

| 구성요소 | 파일 | 역할 |
|---|---|---|
| 대시보드 | `dashboard/taa_pm_dashboard_v1.0.html` (647줄, 2026-09-29 결과 내장, 206KB) | UI. 정적 모드와 백엔드 모드 |
| 로컬 서버 | `server.py` | stdlib `ThreadingHTTPServer`, **127.0.0.1:8765 전용**, 한 번에 작업 1개, `/api/*` |
| 엔진 | `qpm/` (16개 모듈) | 데이터, 검증, 국면, 통계, 점수, 최적화, 분석, 주문, 이력, 내보내기 |
| 스크립트 | `update_data.py`, `portfolio_engine.py`, `rebalance_cli.py`, `export_excel.py`, `walkforward_cli.py` | 명령어 실행 |
| 실행 편의 | `run_server.bat/.sh`, `run_monthly.bat/.sh` | 서버 실행 / 업데이트+실행+HTML 열기 |
| 설정 | `config/*.json`, `.env`(로컬 전용, 저장소에 없음) | |

- 실행 흐름은 `update_data` → `validate` → `run_model` → (`submit_actual`) → `export`입니다.
- 산출물은 `history/<데이터월>/`와 `output/`에 저장됩니다.

### B-2. 코드 구조 (모듈별 책임과 주요 함수) [computed: 파일 확인]

| 모듈 | 주요 함수·클래스 | 책임 |
|---|---|---|
| `config.py` | `Config`, `load_env`, `nyse_holidays`, `first_trading_day_next_month`, `last_trading_day_of_month`, `business_days_between`, `jsonable` | 설정, 비밀값, NYSE 캘린더, JSON 직렬화 |
| `data_layer.py` | `DataLayer.update_market / load_market / update_fred / load_fred / fetch_vintages / update_reference` | yfinance·FRED·ALFRED 수집과 캐시 |
| `validation.py` | `Report`, `validate_data`, `validate_model` | 데이터·모델 검증 |
| `macro.py` | `build_macro`, `factor_table`, `composite_label` | 국면 판정 |
| `etf_stats.py` | `build_prices`, `compute_metrics`, `build_context`(→ `Ctx`) | Total Return, 인컴, 롤링 통계, 조건부 통계 |
| `scoring.py` | `rz`, `csz`, `build_scores`, `sample_flag` | 점수 |
| `engine.py` | `covariance`, `regime_overlay`, `expected_returns`, `optimize`, `apply_band`, `max_income` | 리스크 모델과 최적화 |
| `analytics.py` | `factor_betas`, `portfolio_metrics`, `stress`, `constraint_table`, `frontier`, `stability`, `zero_weight`, `special_analysis`, `class_weights` | 분석 |
| `rebalance.py` | `parse_actual_csv`, `normalize_actual`, `compare`, `exposures` | 실보유 비교와 주문. JS와 동일 |
| `history.py` | `History` | 월별 저장, `index.json`, `income_history` |
| `export.py` | `export_excel`, `export_csv_bundle` | 12개 시트 Excel, CSV |
| `backtest.py` | `run_path`, `stats`, `composite_rank`, `walk_forward`, `run_walkforward` | 백테스트와 워크포워드 재선정 제안 |
| `commentary.py` | `build_facts`, `rule_based_commentary`, `llm_commentary` | 해설 (해석 전용) |
| `dashboard.py` | `embed`, `write_dashboard` | 결과 JSON을 HTML에 내장 |
| `pipeline.py` | `update_data`, `validate`, `run_model`, `submit_actual`, `run_walkforward_job`, `detect_as_of`, `ValidationError` | 전체 조율 |

### B-3. 데이터 파일 구조 [computed]

| 경로 | 형식 | 내용 |
|---|---|---|
| `data/market/{adj_close,close,open,high,low,volume,dividends,stock_splits}.csv.gz` | 행=날짜(거래일), 열=티커 32개 | 2009-01-02 ~ 2026-09-29. **매 업데이트마다 전체를 덮어씀** (약 2.5MB) |
| `data/market/_meta.json` | JSON | 다운로드 시각, 요청 기준일, 티커별 마지막 날짜 |
| `data/fred/<SERIES>.csv` | `date,value` | 33개 시리즈 최신 빈티지 (약 3.1MB) |
| `data/fred/_update_report.json` | JSON | 시리즈별 상태(csv/api/cache/fallback/failed), 기간, 수정치 건수 |
| `data/alfred/<SERIES>_<YYYYMMDD>.csv` | `date,value` | 기준일 시점 빈티지 12개 (현재 20260929) |
| `data/reference/PFF_top_holdings.csv` (+meta) | CSV | Yahoo 상위 10개 보유 |
| `data/_last_update.json` | JSON | as_of, fred_mode, 수집 보고서, 빈티지 보고서, 시각 |
| `history/index.json` | JSON | `months`: 월, 기준일, 리밸런싱일, 목표월, 국면, 인컴, source, 자산군비중, 비중<br>`income_history`: 월 → 목표 인컴 |
| `history/<YYYY-MM>/result.json` | JSON | 대시보드 전체 데이터: meta, universe, macro, scores, portfolio, metrics, constraints, frontier, stability, stress, zero_weight, special, backtest, walk_forward, validation, limitations, commentary, actual, rebalance |
| `history/<YYYY-MM>/*.csv` | CSV (utf-8-sig) | target_portfolio, etf_scores, macro_factors, constraints, stress_test, frontier, stability, zero_weight (+actual_portfolio, rebalancing_order) |
| `history/2026-08/` | seed | v3.0 8월 목표. 9월 드리프트 비중에서 역산 (source=`seed_v3.0`) |
| `history/_reference/backtest_chain_weights.csv` | CSV | v3.0 고정 파라미터 백테스트 체인의 최근 24개월 비중. 차트 참고용 |
| `params/backtest_v3.0.json` | JSON | 백테스트 표, 연도별 수익률, 워크포워드 선택, 최종 파라미터 (정적) |
| `output/latest.json`, `output/taa_pm_dashboard_v1.0_latest.html` | | 최신 결과, 결과를 내장한 대시보드 |

### B-4. Dashboard 구조 [computed: HTML 검사]

- **파일**: HTML, CSS, JS를 모두 담은 단일 파일입니다. 빌드 과정이 없습니다.
- **라이브러리**: 없습니다 (Vanilla JS).
  - 외부 URL 0개, `<link>` 0개, 외부 `<script src>` 0개, `@import`와 `url(` 0개.
  - 폰트는 시스템 한글 폰트 목록으로 지정합니다.
  - localStorage를 쓰지 않습니다.
  - → **폐쇄망에서도 HTML 자체는 열립니다.**
- **CSS**
  - 인라인 `<style>`에 CSS 변수로 색상을 정의합니다. 라이트·다크 모드를 지원합니다.
  - 반응형입니다. 980px 이하에서는 2열로 바뀝니다.
- **JS 구조**
  - 주문 엔진 `RB` (START/END 주석 블록): `qpm/rebalance.py`와 동일한 알고리즘입니다.
  - 상태 객체 `S`
  - `init` → `render` → `renderHeader`, `renderSteps`, `renderSummary`, `renderMacro`, `renderTarget`, `renderExplain`, `renderManual`, `renderRebalance`, `renderCons`, `renderScores`, `renderSpecial`, `renderFrontier`, `renderStab`, `renderStress`, `renderZero`, `renderBT`, `renderWF`, `renderHist`, `renderVal`, `renderLim`, `renderComm`
  - `exportCSV`
- **데이터를 읽는 곳**
  1. 내장 JSON `<script id="seed-data">…</script><!--/seed-data-->` (약 136KB)
  2. 백엔드 모드: `fetch('/api/status' | '/api/result/{월|latest}' | '/api/history' | '/api/jobs/{id}')`
  3. 파일 선택으로 `result.json`을 직접 읽기
- **화면**
  - 헤더
  - 이번 달 할 일 1~6단계
  - 한눈에 보기 (타일 8개)
  - 시장 국면 7개 요인
  - 다음 달 목표: 자산군 막대 차트, 목표 표, 결정 과정 설명
  - 실보유 입력과 주문: 타일, 주문 표, 노출 비교 2종
  - 제약 진단
  - 상세 분석 (펼침 12개)
- **차트**
  - SVG를 직접 생성합니다.
  - 종류: 자산군 누적 막대(목표/Model Current/실보유/거래 후), 월별 이력 누적 막대, 스트레스 막대, 제약 구속 강도 막대
- **사용자 입력**
  - CSV 업로드, 직접 입력 표, 총 평가금액, 추가 입금·출금
  - 백엔드 모드 전용: FRED 모드 라디오, 기준일 날짜, 조회 월 선택
- **대시보드에서 하는 계산**
  - 주문 계산만 합니다 (정규화, 밴드 판정, 거래금액·주수, 합계, 노출).
  - 나머지 수치는 모두 Python 결과를 표시합니다.
- **데이터 업데이트 방식**
  - 백엔드 모드: 버튼 → `/api/jobs/update|validate|run` → 1초 간격으로 진행 상황 조회
  - 정적 모드: 업데이트할 수 없습니다. 새 결과를 보려면 파일을 다시 생성해야 합니다.
- **GitHub Pages**: 사용하지 않습니다. **GitHub 저장소 자체가 아직 없습니다.**
- **폐쇄망에서 문제가 될 부분**
  - Python 수집 경로: `query*.finance.yahoo.com`(yfinance), `fred.stlouisfed.org`, `alfred.stlouisfed.org`, `api.stlouisfed.org`, `api.anthropic.com`(선택), PyPI(설치)
  - 클라우드로 옮긴 뒤에는 `github.com`, `*.github.io` 접근 가능 여부
  - 사내망 프록시 환경은 미검증입니다.

### B-5. 로컬 서버 API [computed: server.py]

| 메서드 | 경로 | 기능 |
|---|---|---|
| GET | `/` | 대시보드 HTML |
| GET | `/api/status` | 백엔드 여부, 버전, fred_mode, 키 존재 여부(값은 반환 안 함), 최신 월, 실행 중 작업, 마지막 업데이트 |
| GET | `/api/history` | `history/index.json` |
| GET | `/api/result/{YYYY-MM\|latest}` | `result.json` |
| GET | `/api/jobs/{id}` | 작업 상태와 로그 |
| GET | `/api/validation/latest` | `output/validation_latest.json` |
| GET | `/api/export/excel?month=` | Excel 파일 다운로드 |
| POST | `/api/config` `{fred_mode}` | `config/settings.local.json`에 저장. API 모드는 키가 없으면 400 |
| POST | `/api/jobs/{update\|validate\|run\|walkforward}` | 작업 시작. 다른 작업이 실행 중이면 409 |
| POST | `/api/actual` `{month, csv\|rows, portfolio_value, extra_cash}` | 실보유 저장과 주문 생성 (**실보유가 파일에 기록됨**) |

### B-6. 주요 설정값 [computed: config]

- **`settings.json`**

  | 키 | 값 |
  |---|---|
  | fred_mode | `csv` |
  | use_alfred_vintage | `true` |
  | market_start | `2009-01-01` |
  | eval_start | `2011-12-31` |
  | backtest_start | `2014-12-31` |
  | 서버 | `127.0.0.1:8765` |
  | llm_model | `claude-sonnet-5-5` (기본 비활성) |

- **검증 임계값**

  | 항목 | 값 |
  |---|---|
  | 가격 지연 | WARN 1 / ERROR 5 영업일 |
  | 일간 변동 | WARN 20% / ERROR 40% |
  | 분배금 | 가격의 5% |
  | 거래량 | 20일 평균 5만 주 |
  | Total Return 재계산 차이 | 0.5%p |
  | 최소 이력 | 24개월 |
  | FRED 최근 관측 허용치 | 일간 10일 / 주간 21일 / 월간 3개월 / 분기 8개월 |

- **`model_params.json`**: v3.0 값입니다. 전체 목록은 E-1.
- **`fred_series.json`**: 33개 시리즈. 시리즈마다 `freq`, `lag_months`, `release_day`, `revisable`, `required`, `weekly_lag_days`가 있습니다.

### B-7. 스펙·설명과 실제 코드가 다른 부분

| # | 스펙·설명 | 실제 구현 |
|---|---|---|
| M-1 | Rebalance Date 예시 "2026-11-01" | 다음 달 첫 NYSE 거래일 → **2026-11-02** (11/1은 일요일) |
| M-2 | 헤더 지표 "Actual Income" | **미구현.** 목표 인컴(TTM)과 12개월 평균만 표시 |
| M-3 | PFF 금융주 집중도 표시 | **Data unavailable.** XLF 베타·상관(Proxy)으로 대체 |
| M-4 | 월간 단계 ⑨ "Walk-forward Parameter Selection" | 고정 파라미터를 로드하고 "재선정 필요"만 표시. 재선정은 별도 수동 작업이며 제안만 저장 |
| M-5 | Total Return, Distribution, TTM Yield "업데이트" | 파일로 저장하지 않음. Adj Close·Close·Dividends를 저장하고 실행 시 계산 |
| M-6 | HTML에서 FRED 연결 설정 | 백엔드 모드에서만 표시·동작. 정적 모드에는 없음 |
| M-7 | 검증 "상장일" | 가격 시작일 기준 이력 길이(24개월) 검사. `universe.json`의 inception은 표시용 |
| M-8 | 백테스트 대시보드 | 재계산하지 않고 `params/backtest_v3.0.json`(정적)을 표시 |
| M-9 | 워크포워드 파라미터 목록(λ_income, 인컴 목표, CC/Credit/Single 한도 등) | 이 값들은 연도별로 선택되지 않은 **고정값**. 표에는 상수로 표시 |
| M-10 | 스펙 v2 "소프트 코리도(선호 6.5~7.5%, 소프트 플로어 6.0%)" | 최종 모델은 **코리도가 아닌 소프트 이차 벌점**(12개월 평균, λ_inc=50). 코리도 모드는 코드에 있지만 기본값이 아님 |
| M-11 | Credit 레벨 예시 3.02% (HY OAS) | 레벨은 HY OAS를 표시하지만 z·백분위·국면은 BAA10Y 기준. FRED의 ICE BofA OAS는 3년 이력만 있음 |
| M-12 | Dollar (DXY) | FRED Broad Dollar(DTWEXBGS) 사용. 국면 라벨이 v3.0의 Strengthening/Weakening에서 Rising/Falling로 바뀜 |
| M-13 | 실행 방식 우선순위 3순위 Pyodide | 사용하지 않음 (1순위 백엔드, 2순위 스크립트만 구현) |
| M-14 | "JBBB는 2020년 위기 미경험" 명시 | JAAA(2020-10 상장)도 미경험이라 **두 종목 모두** 표시 |
| M-15 | 과거 요약 "7%는 40/30/20 한도 필요" | System v1.0 LP 결과(2026-09): 최소 **CC40 + Single20**으로 7.04% 가능, 세 가지 모두 완화 시 7.10% [computed] |

### B-8. 과거 설계 → 현재 구현 → 향후 계획

| 주제 | 과거 설계·논의 | 현재 실제 구현 | 향후 (계획) |
|---|---|---|---|
| 인컴 7% 처리 | v1.0 하드 제약. 기본 한도로는 불가(최대 6.60%) | 소프트 이차 벌점(12개월 평균, λ_inc 50) | 변경 금지 |
| 유니버스 | 1단계 22종 | 25종 고정(+JAAA, JBBB, PFF) | 변경하려면 사용자 재승인 |
| 한도 | 스펙 v2 CC ≤30%(최대 40), Credit ≤25%(최대 30), Single ≤15%(최대 20) | 30/25/15 적용. 40/30/20은 민감도·완화 분석에만 사용 | — |
| 동적 하한 | "국면별 동적" | D3(15/20/30), E2(15/10/5) | — |
| 밴드 처리 | v3.0 백테스트는 잔여 재배분, v3.0 8월 라이브는 정규화 | 단일 규칙으로 통일 | K-5 영향 분리 검증 |
| 매크로 시차 | v3.0 월간 1개월 lag | + 발표일 가드, 주간 지연, ALFRED as-of 12종 | 관측일·발표일 저장소, 빈티지 백테스트 |
| 실행 환경 | 스펙: HTML+Python 백엔드 | 로컬 서버와 스크립트 | GitHub Actions와 대시보드 연동 |
| 실보유 | "Current Weight unavailable" 명시 | "Actual Portfolio: Not Provided" | 커밋하지 않는 저장 방식 |
| 워크포워드 | 매월 단계에 포함 | 연 1회 수동 제안 | Actions 수동 실행과 PR |
| AI | 해석 레이어 | 규칙 기반 해설(항상) + LLM(선택, 미검증) | 동일 |

---

## C. Target Architecture [계획 — 전부 미구현]

### C-1. 목표 구조

```
                        ┌────────────── GitHub (private repo 권장) ──────────────┐
[수동] 대시보드 Update 버튼 ──(링크 또는 API)──┐                                     │
[수동] Actions 화면 "Run workflow" ───────────┼─> manual_update.yml (workflow_dispatch)
[자동] cron (UTC) ────────────────────────────┴─> scheduled_monthly.yml (schedule)   │
                                                   │ (공통 concurrency 그룹)          │
                                   ubuntu 러너: checkout → setup-python → pip install  │
                                   → python scripts/ci_run.py (신규)                   │
                                      ├ update_data(as_of)   yfinance·FRED·ALFRED      │
                                      ├ validate  ─ ERROR → exit≠0 → 커밋 안 함        │
                                      ├ run_model (월간 작업일 때)                     │
                                      └ output/status.json 작성                        │
                                   → git commit/push (성공 시에만)                     │
                                   → (선택) Pages 배포 / 결과 HTML                      │
                        └────────────────────────────────────────────────────────────┘
```

### C-2. 자동 실행과 수동 실행 분리 (별개 기능) [결정 반영]

| 구분 | 트리거 | 기본 작업 | 기준일 | 커밋 대상 |
|---|---|---|---|---|
| ① 수동 업데이트 | `workflow_dispatch` (Actions 화면 또는 대시보드 버튼) | `data_only` 또는 `model_run` (입력으로 선택) | 입력값. 비우면 data_only는 마지막 거래일, model_run은 직전 월 마지막 거래일 | 데이터와 상태 (+결과) |
| ② 자동 월간 실행 | `schedule` (매월 1~5일) | `model_run` + 중복 방지 가드 | 직전 월 마지막 NYSE 거래일 (**반드시 명시**, K-2) | history, output, 상태 (+월간 데이터 스냅샷) |
| ③ (선택) 자동 일간 데이터 | `schedule` (평일) | `data_only` | 마지막 거래일 | 상태만 권장 (D-6 용량) |
| ④ 회귀 테스트 CI | `push`, `pull_request` | `tests/check_golden.py` | 2026-09-29 고정 | 없음 |

### C-3. 실행 시간 설계

- **미국 정규장 마감**: 16:00 ET
  - EDT 기간: 20:00 UTC = 05:00 KST(+1일)
  - EST 기간: 21:00 UTC = 06:00 KST(+1일)
  - [memory]
- **cron 기준**: GitHub cron은 **UTC** 기준입니다. 정시(:00)는 부하가 높아 지연되거나 드롭될 수 있으므로 정시를 피합니다 [web: GitHub Docs 인용, community discussion].
- **제안 시각**: `17 22 * * *` (UTC 22:17)
  - ET: 18:17(EDT) / 17:17(EST)
  - KST: 07:17 (+1일)
  - 두 경우 모두 장 마감 후입니다.
- **월간 실행**
  - cron: `17 22 1-5 * *`
  - 가드: `history/<직전월>`이 `source=live`로 이미 있으면 건너뜁니다.
  - 며칠 늦게 실행되어도 대부분 시점 정합성이 유지됩니다. as_of 절단과 ALFRED as-of 덕분입니다. Adj Close의 사후 재조정은 비율을 보존하므로 수익률에 영향이 없습니다.
  - **예외**: 빈티지를 쓰지 않는 주간 시리즈(ICSA 등)는 as_of 이후 수정치가 반영될 수 있습니다 [uncertain: 영향 미측정].
- **FRED 일간 시리즈 게시 시점**: 다음 영업일에 게시되는 경우가 있어 as_of 당일 값이 없을 수 있습니다. 이때 코드는 as_of 이하의 최신 값을 사용합니다 [memory, 구현 시 확인].
- **주의**
  - 공개 저장소는 60일간 활동이 없으면 schedule이 비활성화됩니다 [web].
  - 서드파티 자료에 따르면 2026-03부터 cron `timezone:` 필드를 지원합니다 → **공식 문서 확인 전에는 UTC만 사용** [web: 3rd-party, 미확인].

### C-4. 워크플로 초안 (미구현·미검증 — Claude Code가 구현할 때 검토)

```yaml
# .github/workflows/manual_update.yml  (초안)
name: manual-update
on:
  workflow_dispatch:
    inputs:
      task:      { description: "data_only | model_run", type: choice, options: [data_only, model_run], default: data_only }
      as_of:     { description: "YYYY-MM-DD (비우면 자동: data_only=마지막 거래일, model_run=직전 월 마지막 거래일)", required: false }
      fred_mode: { type: choice, options: [csv, api], default: csv }
permissions:
  contents: write
concurrency:
  group: taa-pm-data
  cancel-in-progress: false
jobs:
  update:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4          # 액션 버전은 구현 시점 최신 확인
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - name: Pipeline (검증 ERROR면 non-zero 종료 → 이후 커밋 단계 미실행)
        env:
          FRED_API_KEY: ${{ secrets.FRED_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: python scripts/ci_run.py --task "${{ inputs.task }}" --as-of "${{ inputs.as_of }}" --fred-mode "${{ inputs.fred_mode }}"
      - name: Commit
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data history output params
          git diff --cached --quiet || git commit -m "data(${{ inputs.task }}): as_of=${{ inputs.as_of || 'auto' }}"
          git push
```

```yaml
# .github/workflows/scheduled_monthly.yml  (초안)
name: scheduled-monthly
on:
  schedule:
    - cron: "17 22 1-5 * *"   # UTC. 매월 1~5일 (첫 거래일 판단은 스크립트 가드)
permissions: { contents: write }
concurrency: { group: taa-pm-data, cancel-in-progress: false }
jobs:
  monthly:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # checkout / setup-python / pip install — manual_update와 동일
      - run: python scripts/ci_run.py --task model_run --auto-month-end --skip-if-exists
      # Commit 단계 동일
```

### C-5. `scripts/ci_run.py` 사양 [계획 — 새 파일, 기존 함수만 호출]

- **입력**: `--task {data_only, model_run}`, `--as-of`, `--auto-month-end`, `--skip-if-exists`, `--fred-mode`
- **처리 순서**
  1. 기준일을 정합니다: `--auto-month-end`면 `config.last_trading_day_of_month(직전 월)`
  2. `pipeline.update_data(as_of, fred_mode)`
  3. `pipeline.validate(as_of)` → ERROR가 있으면 status.json에 기록하고 `exit 2`
  4. `model_run`이면 `pipeline.run_model(as_of)`. `ValidationError`면 `exit 2`
  5. `output/status.json`을 작성합니다 (C-7)
- **가드**: `--skip-if-exists`이고 `history/<월>`이 `source=live`면 `exit 0`으로 건너뜁니다 (K-4 보호).
- **변경 금지**: 모델 계산 코드는 수정하지 않습니다. 호출만 합니다.

### C-6. 대시보드 호스팅과 Update 버튼 선택지 (사용자 결정 필요)

**호스팅**

| 선택지 | 내용 | 장점 | 주의 |
|---|---|---|---|
| A. GitHub Pages (공개 사이트) | 워크플로가 결과 내장 HTML을 배포 | 브라우저로 바로 조회 | Pages 사이트는 저장소가 비공개여도 **인터넷에 공개**. 비공개 저장소에서 Pages를 쓰려면 Pro/Team/Enterprise 필요 [web: docs.github.com] → 목표 비중 공개 여부 확인 필요 |
| B. Pages + 접근 제어 | Enterprise Cloud 조직의 비공개 게시 | 비공개 조회 | Enterprise Cloud 조직에서만 가능 [web] |
| C. 결과 HTML 다운로드 | 워크플로가 `output/taa_pm_dashboard_v1.0_latest.html`을 갱신. 사용자는 받아서 로컬에서 열기 | **코드 변경 0**, 비공개. 정적 모드로 주문 계산 가능 | 클릭 한 번으로 조회는 불가 |
| D. Codespaces에서 `server.py` | 클라우드 VM에서 백엔드 모드 그대로 사용 | 기능 100% | 비용·한도 확인 필요 [미확인] |

- **권장 순서**: C로 먼저 운영 → A/B/D 중 결정.

**Update 버튼**

| 방식 | 내용 | 비고 |
|---|---|---|
| ① 링크 | 버튼이 Actions 워크플로 페이지를 열고 사용자가 "Run workflow"를 누름 | 토큰 불필요. **권장 MVP** |
| ② API 직접 호출 | `POST /repos/{owner}/{repo}/actions/workflows/manual_update.yml/dispatches` | fine-grained 토큰에 "Actions" write 권한 필요 [web: docs.github.com/rest/actions/workflows]. 토큰은 사용자가 입력하고 브라우저 세션에만 보관(저장소·HTML에 저장 금지). CORS 동작은 구현 시 확인 [memory] |
| ③ 프록시 | 서버리스 함수가 Secret으로 대신 호출 | 인프라 추가 |

### C-7. 상태 정보 `output/status.json` 스키마 [계획]

```json
{
  "run_id": "…", "trigger": "manual|schedule", "task": "data_only|model_run",
  "started_at": "UTC ISO", "finished_at": "UTC ISO", "result": "success|validation_failed|error",
  "as_of": "YYYY-MM-DD", "market_last_date": "YYYY-MM-DD",
  "fred": {"mode": "csv|api", "series_ok": 33, "fallback": [], "failed": [], "last_obs": {"DGS10": "YYYY-MM-DD"}},
  "vintage": {"date": "YYYY-MM-DD", "series": 12, "missing": []},
  "validation": {"status": "PASS|WARN|FAIL", "errors": 0, "warnings": 0, "error_items": []},
  "model": {"month": "YYYY-MM", "target_month": "YYYY-MM", "rebalance_date": "YYYY-MM-DD", "income": 0.0537},
  "commit": "sha"
}
```

- 대시보드에는 다음을 표시합니다: Last Update, Market Data 기준일, FRED 기준일, 성공/실패, 수집 오류, 검증 결과.
- 현재는 이 정보가 흩어져 있습니다: `data/_last_update.json`, `output/validation_latest.json`, `result.meta`, `/api/status`(백엔드 전용).

### C-8. Secrets와 보안

- **Secrets**
  - `FRED_API_KEY`: 선택. 키리스 CSV로도 동작합니다.
  - `ANTHROPIC_API_KEY`: 선택.
  - 코드가 환경변수를 읽으므로 **코드 변경이 필요 없습니다** (`qpm/config.py::load_env`) [computed].
- **저장소**
  - 비공개(private)를 권장합니다.
  - 목표 비중, 운용 정보, 실보유는 회사 정보보호·컴플라이언스 기준을 먼저 확인하세요.
- **데이터 약관**
  - Yahoo 데이터와 ICE BofA 지수(FRED 제공분)의 재배포 조건은 사용자가 확인해야 합니다.
  - 공개 저장소에 원천 데이터를 커밋하지 않는 것을 권장합니다 [memory, 법률 판단 아님].

---

## D. Data Pipeline

### D-1. yfinance

| 항목 | 현재 [현재] | 목표 [계획] |
|---|---|---|
| 티커 | 25 ETF + BIL, IAU, HYG, QQQ, SPY (proxy) + ^IRX + XLF (32개) | 동일 |
| 자산군 매핑 | `config/universe.json` (CLAUDE.md §Investment Universe) | 동일 |
| 가격 기준 | Adj Close(= auto_adjust Close) → Total Return / Close + Dividends → 인컴 | 동일 |
| 빈도·기준일 | 일간 → 월말. 기준일(as_of) = 마지막 확정 종가일 | 동일. 월간 실행은 직전 월 마지막 거래일로 명시 |
| 시간대 | 날짜는 거래소 현지. 미완성 세션은 뉴욕 16:30 전 당일 행 제거 | Actions 러너(UTC)에서도 동일 함수 사용 |
| 휴장일 | yfinance가 거래일만 반환. NYSE 규칙 캘린더(특별 휴장 미반영) | 동일 |
| 결측·중복 | NaN 유지 → 검증에서 ERROR/WARN | 동일 |
| merge | **전체 재다운로드 후 덮어쓰기** (Adj Close 소급 재조정 때문) | 전체 재다운로드는 유지. 임시 파일 → 검증 → 교체 (K-1) |
| 기존 데이터 보호 | 로컬: 없음 (K-1) | CI: 검증 통과 시에만 커밋 → git이 원본 보존 |

### D-2. FRED — 관측일과 이용 가능일

**원칙** [결정]

- 경제지표는 `observation date`(관측 대상 기간), `release/vintage date`(공개된 날), `value`(그 시점 값)를 구분합니다.
- 판단 시점 t에는 **release ≤ t인 값만** 씁니다.

**현재 구현** [현재]

| 시리즈 유형 | 처리 | 시점 정합성 |
|---|---|---|
| 일간 (금리, 스프레드, VIX, BEI, 달러) | as_of 이후 절단 | 정확 |
| 월간 수정형 12종 | ALFRED `vintage_date=as_of`로 교체 | **라이브 실행 시점 기준으로 정확** |
| 월간·주간 기타 | 관측월 + lag 라벨, 발표일 가드(추정값), 주간 지연 일수 | 근사 |
| 과거 백테스트 구간 | 최신 빈티지 + 위 규칙 | **수정치 look-ahead 존재** (K-7) |

- 관측치별 발표일(realtime_start)은 **저장하지 않습니다.** 빈티지 파일은 "그날 기준 전체 시계열"입니다.
- 수정치 감지: 새로 받은 값과 기존 캐시를 비교해 건수와 최대 차이를 INFO로 기록합니다.

**목표 스키마** [계획]

| 열 | 뜻 |
|---|---|
| `series_id` | 시리즈 ID |
| `observation_date` | 관측 대상 기간 |
| `realtime_start` | 이 값이 공개된 날 (= 발표·수정일) |
| `realtime_end` | 이 값이 유효한 마지막 날 |
| `value` | 값 |
| `fetched_at` | 수집 시각 |

- 수집: ALFRED API `realtime_start=1776-07-04&realtime_end=9999-12-31`, 시리즈당 1회. 키는 Secrets로 관리합니다.
- 조회: `value_at(series, obs, t)` = realtime_start ≤ t ≤ realtime_end 인 값
- 백테스트: 각 결정 시점의 빈티지를 사용하는 옵션을 추가합니다.
- 비교: 기존 결과(v3.0)와 비교하는 경로는 유지합니다. methodology 변경이므로 **사용자 승인이 필요**합니다.

### D-3. 검증과 커밋 게이트

- **현재**: 검증에서 ERROR가 나면 `ValidationError`로 실행을 중단합니다. 다만 시장 캐시는 이미 덮어쓴 뒤입니다.
- **목표**: CI에서 ERROR가 나면 커밋하지 않습니다. 실패 상태는 `status.json`에 기록합니다. 상태 파일만 커밋할지는 결정이 필요합니다.

### D-4. 투자모델 데이터 무결성

| 위험 | 현재 대응 [현재] | 남은 공백 | 목표 [계획] |
|---|---|---|---|
| Look-ahead | as_of 절단, 월말 격자, lag·가드·주간 지연, 라이브 빈티지, 점수 rz shift(1), 조건부 통계에서 t 이전 달만 사용, 결정 t → t+1 수익률 | 백테스트 빈티지 없음, 발표일 추정 | D-2 스키마 |
| Survivorship·선택 편향 | 없음 (유니버스를 2026-09에 사후 선정) | 백테스트가 낙관적일 수 있음 | 문서화 (구조적 한계) |
| 데이터 revision | 수정치 감지(INFO), 라이브 빈티지 | 백테스트 미반영 | 빈티지 저장소 |
| 가격 수정(배당·분할 재조정) | 매번 전체 재다운로드, Total Return 재계산 검증 | 과거 스냅샷 없음 | 월간 실행 때 원천 스냅샷 커밋 또는 아카이브 |
| 티커 변경 | 없음 (고정 티커) | 변경 시 "데이터 없음·지연" ERROR로만 감지 | 매핑 표 + 사용자 승인 절차 |
| 상장폐지 | 지연 5영업일 초과 ERROR로 실행 중단 | 대체 규칙 없음 | 알림 + 사용자 결정 (유니버스 변경은 승인 필요) |
| 휴장일 | NYSE 규칙 캘린더 | 특별 휴장 미반영 | 필요 시 예외일 목록 |
| 결측 | 252일 결측률 검사, 가용 마스크 | — | 동일 |
| 중복 | 중복 날짜 ERROR, 라벨 중복 제거 | — | 동일 |
| API 오류 | FRED 시리즈별 캐시 대체(WARN), 필수 시리즈 실패 ERROR, yfinance 빈 응답은 예외 | yfinance 부분 실패 시 NaN 캐시 | 재시도 + 임시 저장 |
| 부분 업데이트 | — | 로컬 캐시 오염 가능 (K-1) | 원자적 교체, CI 커밋 게이트 |
| 잘못된 덮어쓰기 | — | `history/<월>` 재실행 시 덮어씀 (K-4) | 마감 월 보호(`--force`) |
| 백테스트 vs 라이브 분리 | `history/` = 라이브(`source=live`/`seed_v3.0`), `params/backtest_v3.0.json` = 정적 백테스트 | 데이터 기준 차이(빈티지) | 디렉터리와 메타데이터로 명시 분리 |

### D-5. Backtest와 Live 구분 규칙

1. `history/<월>/`은 **그 시점에 알 수 있었던 정보로 만든 기록**입니다. 이후 데이터가 수정되어도 다시 계산해 덮어쓰지 않습니다.
2. 백테스트 산출물은 `params/`(또는 향후 `backtest/`)에 버전을 붙여 분리하고, 라이브 기록과 섞지 않습니다.
3. 대시보드 라벨을 유지합니다: Honest OOS / Fixed params (partial in-sample) / Benchmark.

### D-6. 저장소 용량과 데이터 커밋 정책 (결정 필요)

- 현재 캐시 용량: 시장 약 2.5MB(gzip), FRED 약 3.1MB, ALFRED 약 0.26MB [computed].
- 시장 파일은 매번 전체가 다시 쓰입니다. **매일 커밋하면 저장소가 누적해서 커집니다** [memory: git은 gzip 바이너리 차분이 비효율].
- **권장안**
  - 원천 데이터는 월간 실행 때만 스냅샷으로 커밋합니다.
  - 일간 자동 업데이트를 한다면 상태 파일만 커밋합니다.
  - 대안: Actions artifact, Releases, Git LFS [결정 필요].

---

## E. Investment Model

### E-1. 핵심 파라미터 (v3.0, `config/model_params.json`) [현재]

| 영역 | 값 |
|---|---|
| 신호 | 룩백 L=24개월, 가중치 cfg A (모멘텀·위험조정·인컴·매크로 각 0.25, 위험 벌점 −0.25), 매크로 표본 24개월 미만이면 비례 축소 |
| 기대수익 | κ=1.0, 과거 120개월 평균(최소 36개월)을 50% 수축 |
| 리스크 | λ=1.5, λ_cvar=0.5, λ_conc=0.5, 공분산·CVaR 창 60개월, 수축 0.3, CVaR α=5% |
| 인컴 | 소프트, 목표 7%, λ_income=50, λ_utility=0.5, 12개월 롤링 (코리도 파라미터 floor 6%, cap 7.5%, λ_floor 5000은 미사용) |
| 한도 | 단일 15%, 커버드콜 30%, 크레딧 25%, JAAA 15%, DBMF 10%, 순수주식 45%, 배당 35%, 실물 25%, SGOV ≥3% |
| 하한 | 방어 Normal/HighRisk/Crisis = 15/20/30% · 주식 RiskOn/Neutral/RiskOff = 15/10/5% |
| 리밸런싱 | 밴드 1.5%p, 회전율 벌점 0.001, 거래비용 10bp |
| 워크포워드 | 연 1회 수동, 마지막 선정 2026, 창 36개월 |

- 수식과 판정 규칙 전체는 CLAUDE.md §Model Methodology·§Optimization에 있습니다.

### E-2. 백테스트 결과 (`params/backtest_v3.0.json`, 2017-01 ~ 2026-08, 비용 10bp) [computed: 파일]

| 모델 | 구분 | CAGR | 변동성 | Sharpe | Sortino | MDD | CVaR95(월) | 인컴 | 회전율(연) |
|---|---|---|---|---|---|---|---|---|---|
| M0 Buy&Hold | Benchmark | 9.48% | 9.9% | 0.711 | 1.13 | -19.9% | -6.44% | 2.48% | 0.00x |
| M1 Monthly EW | Benchmark | 8.38% | 8.3% | 0.714 | 1.12 | -13.8% | -5.42% | 3.48% | 0.30x |
| M2 Rolling Z (WF) | Honest OOS (annual walk-forward) | 7.49% | 6.8% | 0.738 | 1.18 | -10.5% | -4.32% | 3.84% | 1.28x |
| M3 Macro+Z (WF) | Honest OOS (annual walk-forward) | 7.50% | 6.7% | 0.752 | 1.22 | -9.7% | -4.11% | 3.77% | 1.38x |
| M4 Opt hard 7% (WF) | Honest OOS (annual walk-forward) | 6.38% | 6.9% | 0.568 | 0.84 | -14.5% | -5.02% | 5.37% | 2.52x |
| M5 Opt corridor (WF) | Honest OOS (annual walk-forward) | 7.46% | 9.1% | 0.548 | 0.79 | -22.1% | -6.54% | 5.26% | 2.19x |
| M6 corridor+floors (WF) | Honest OOS (annual walk-forward) | 7.67% | 8.7% | 0.600 | 0.87 | -20.1% | -6.27% | 5.21% | 2.11x |
| M6-Soft structure (WF over soft grid) | Honest OOS (annual walk-forward) | 6.43% | 6.2% | 0.635 | 0.96 | -10.4% | -4.28% | 4.67% | 2.18x |
| COST: Unconstrained (no income term) | Fixed params (partial in-sample) | 7.05% | 6.1% | 0.747 | 1.22 | -7.9% | -3.54% | 4.01% | 2.73x |
| COST: Hard 7% (base caps 30/25/15) | Fixed params (partial in-sample) | 6.53% | 6.8% | 0.593 | 0.89 | -12.7% | -4.79% | 5.25% | 2.58x |
| COST: Hard 7% (relaxed 40/30/20) | Fixed params (partial in-sample) | 6.66% | 6.9% | 0.605 | 0.92 | -12.6% | -4.77% | 5.65% | 2.93x |
| COST: Soft 7% (quadratic, 12M avg) | Fixed params (partial in-sample) | 6.84% | 6.2% | 0.707 | 1.13 | -7.9% | -3.84% | 4.54% | 2.66x |
| COST: Soft 7% lam_inc=50 | M6-Soft Fixed Parameter Reference (final, partial in-sample) | 7.08% | 6.1% | 0.756 | 1.23 | -7.9% | -3.69% | 4.49% | 2.68x |
| COST: Soft 7% lam_inc=200 | Fixed params (partial in-sample) | 6.94% | 6.3% | 0.713 | 1.14 | -8.1% | -3.95% | 4.65% | 2.62x |
| COST: Soft 7% spot (no rolling) | Fixed params (partial in-sample) | 6.70% | 6.8% | 0.621 | 0.94 | -12.7% | -4.79% | 5.12% | 2.45x |
| COST: Corridor 6.5-7.5 (floor 6.0 near-hard) | Fixed params (partial in-sample) | 7.33% | 7.8% | 0.625 | 0.91 | -16.3% | -5.66% | 5.20% | 2.37x |
| COST: Corridor soft floor (lam_floor=200) | Fixed params (partial in-sample) | 6.50% | 7.0% | 0.572 | 0.86 | -13.9% | -5.11% | 4.99% | 2.50x |
| COST: Soft 6.5% target | Fixed params (partial in-sample) | 6.89% | 6.2% | 0.716 | 1.15 | -8.1% | -3.85% | 4.51% | 2.58x |
| COST: No floors (soft 7%) | Fixed params (partial in-sample) | 6.88% | 6.1% | 0.727 | 1.18 | -7.3% | -3.69% | 4.63% | 2.69x |

- 총수익 목표 10% 대비 실현 CAGR은 6.4%(OOS)~7.1%(고정)입니다. 모델 기대수익 13.5%(κ=1)와 큰 차이가 있습니다 [결정: 분리 표시].

### E-3. 워크포워드 연도별 선택 (1단계는 저장값, 2·3단계는 실행 로그 전사)

| 연도 | L | cfg | κ | λ | 방어 하한 | 주식 하한 | 공분산·CVaR 창 | 밴드 | 종합순위 |
|---|---|---|---|---|---|---|---|---|---|
| 2017 | 24 | C | 0.5 | 1.5 | 15/20/30% | 15/10/5% | 60 | 1.5% | 1.0 |
| 2018 | 24 | C | 0.5 | 1.5 | 5/10/15% | 15/10/5% | 60 | 1.5% | 1.0 |
| 2019 | 24 | C | 1.0 | 1.5 | 5/10/15% | 10/5/0% | 60 | 1.5% | 3.0 |
| 2020 | 12 | A | 0.0 | 1.5 | 15/20/30% | 10/5/0% | 60 | 1.5% | 5.5 |
| 2021 | 24 | A | 1.0 | 1.5 | 15/20/30% | 15/10/5% | 36 | 0.5% | 2.25 |
| 2022 | 24 | A | 1.0 | 1.5 | 15/20/30% | 15/10/5% | 36 | 0.5% | 1.25 |
| 2023 | 24 | A | 1.0 | 1.5 | 15/20/30% | 10/5/0% | 36 | 1.0% | 1.5 |
| 2024 | 24 | C | 1.0 | 1.5 | 15/20/30% | 10/5/0% | 60 | 1.0% | 5.0 |
| 2025 | 24 | C | 0.5 | 1.5 | 15/20/30% | 10/5/0% | 36 | 1.0% | 3.75 |
| 2026 | 12 | A | 0.0 | 1.5 | 15/20/30% | 15/10/5% | 36 | 1.5% | 5.25 |

- **최종 선택** (1단계 최빈값, 동률은 전 기간 종합순위): L24 · A · κ1.0 · λ1.5 · λ_inc 50 · D3/E2 · 밴드 1.5% · 창 60개월
- **표에서 확인한 최빈값과 동률 처리** [computed: 위 표 집계]
  - 1단계: (L24·A·κ1.0·λ1.5)와 (L24·C·κ0.5·λ1.5)가 각 3회로 동률 → 전 기간 종합순위로 전자를 선택했습니다.
  - 방어 하한: D3가 7회로 최다입니다.
  - 주식 하한: E2와 E1이 각 5회로 동률 → E2를 선택했습니다.
  - 밴드·창: (1.5%, 60개월)이 4회로 최다입니다.
- 동률 처리에 전 기간 정보를 썼으므로 최종 파라미터는 **부분 In-Sample**입니다.

### E-4. 2026-09 실행 요약 (2026-09-29 → 10월 목표) [computed]

- **국면**: Growth + Disinflation + Rising Rates / 위험 상태 Neutral / 방어 상태 Normal
  - Rates Rising: 10년물 5.24%, 3개월 +80bp
  - Inflation Falling, Liquidity Loose
- **목표 인컴**: 5.37% (12개월 평균 5.54%)
  - 현재 한도에서 최대 인컴 6.55%
  - 7% 달성: CC40 + Single20이면 7.04%, CC40·Credit30·Single20이면 7.10%
- **프론티어**: 목표 5.5~6.5%는 가능, **7.0~8.0%는 현재 한도로 불가**
- **민감도**: Stable. 파라미터 한 개 변경 시 원 최적화 최대 변화 3.5%p (공분산 36개월 변형)
- **스트레스**

  | 시나리오 | 손실 |
  |---|---|
  | Recession | −12.5% |
  | Equity Crash | −9.2% |
  | Credit Stress | −6.7% |
  | Liquidity Shock | −5.6% |
  | Inflation Shock | −3.6% |
  | Rate Shock | −2.9% |
  | USD Shock | −0.4% |

- **0% 종목**: IEMG·VCIT·PFF·IGF·GLDM (점수 요인), SCHH (중복)
- **검증**: WARN 2건 — 부분 월(9/30 이전), DBMF 최종 10.09% (밴드 유지분)

### E-5. 미해결 모델 이슈

- K-5: 밴드 통일 영향 [uncertain]
- K-6: 점수 특이점 (v3.1 후보, 승인 필요)
- K-7: 백테스트 빈티지 미적용
- K-11: Actual Income 미구현
- K-13: CLO 짧은 표본
- κ=1 기대수익 낙관 가능성
- 총수익 10% 목표 미달

---

## F. Dashboard

### F-1. 현재 기능 [현재]

**정적 모드** (파일만 열어도 동작)

- 조회 전체: 국면, 목표, 설명, 제약, 점수, CLO·PFF, 프론티어, 민감도, 스트레스, 0%, 백테스트, 워크포워드, 이력, 검증, 한계, 해설
- 실보유 CSV 업로드·직접 입력으로 주문 계산
- CSV 5종 내보내기: 목표, 주문, 실보유, 점수, 매크로
- 결과 파일(`result.json`) 열기

**백엔드 모드** (추가 기능)

- 업데이트, 검증, 모델 실행 (진행 로그 표시)
- 워크포워드 제안 실행
- FRED 모드 전환
- 조회 월 선택
- Excel 내보내기
- 실보유 저장

### F-2. 향후 기능 [계획]

- 정적 호스팅 모드: 상대 경로로 `output/latest.json`, `history/index.json`, `output/status.json`을 읽고, 실패하면 내장 seed를 사용합니다.
- 상태 패널: Last Update, Market 기준일, FRED 기준일, 성공/실패, 오류, 검증 결과
- Update 버튼 (C-6 ① 링크 → 이후 ②)
- Actual Income 지표 (K-11)
- 모든 변경은 사용자 선호를 유지합니다: 탭·표 최소화, 쉬운 설명, 파일명 버전 표기

---

## G. GitHub / Claude Code Migration Guide

### G-1. Claude Code 첫 세션 절차

1. `CLAUDE.md` → 이 문서 → `docs/LOCAL_RUN_v1.0.md` 순서로 읽습니다.
2. `pip install -r requirements.txt` 후 `python tests/check_golden.py`를 실행해 **PASS**를 확인합니다. 오프라인에서 동작하며 기준값은 `tests/golden_2026-09.json`입니다.
3. (Node가 있으면) `python tests/check_rebalance_parity.py`를 실행해 JS와 Python의 차이가 0인지 확인합니다.
4. 이후 G-4의 P1 작업을 **각각 별도 PR로** 진행합니다. PR마다 골든 테스트를 통과해야 합니다.

### G-2. 반드시 알아야 할 함정

1. **`run_model`의 부수효과**: `history/<월>`, `history/index.json`, `output/*`에 씁니다. 테스트는 복사본에서 실행합니다 (`check_golden.py`가 그렇게 동작).
2. **Model Current 계산**: 직전 월 `target_portfolio.csv`와 `index.json`의 `as_of`로 드리프트합니다. `history/2026-08`, `2026-09`를 지우면 연속성이 끊깁니다.
3. **12개월 인컴**: `index.json`의 `income_history`에 의존합니다.
4. **FRED 요청**: custom User-Agent를 보내면 503이 발생합니다. requests 기본 헤더를 유지합니다 [computed].
5. **seed 마커**: 대시보드의 seed 마커를 바꾸면 결과 내장이 실패합니다.
6. **JS 주문 엔진**: `qpm/rebalance.py`와 함께 수정하고 parity 테스트로 확인합니다.
7. **pandas 버전**: pandas ≥ 2.2가 필요합니다 (`ME`·`QE` 별칭). `pct_change` 대신 `x/x.shift(1)-1`을 쓰고 있습니다(버전 호환 목적). 이 형태를 유지합니다.

### G-3. 사용자 결정 필요 사항

| # | 결정 사항 | 권장 |
|---|---|---|
| Q1 | 저장소 공개 범위, GitHub 요금제 | 비공개 |
| Q2 | 대시보드 조회 방식 (C-6 A/B/C/D) | C부터 |
| Q3 | Update 버튼 방식 (링크 / API / 프록시) | 링크 |
| Q4 | 데이터 커밋 정책 (월간 스냅샷 / 일간 / artifact / LFS) | — |
| Q5 | 일간 자동 데이터 업데이트 필요 여부 | — |
| Q6 | 월간 실행 시각과 실제 거래 시점 (리밸런싱일 미국 장중) | — |
| Q7 | FRED API 키, AI 해설 사용 여부 | — |
| Q8 | 실보유 이력 보관 여부와 위치 (비커밋 로컬 / 미보관) | — |
| Q9 | 과거 산출물(v1~v3 워크북·zip) 보관 위치 (예: Releases, `archive/`) | — |
| Q10 | K-6 점수 특이점 수정 여부 (v3.1). 2027-01 워크포워드 재선정 일정 | — |

### G-4. 백로그 (우선순위 · 완료 기준)

| ID | 우선 | 작업 | 완료 기준 |
|---|---|---|---|
| T1 | P1 | 비공개 저장소 + CI(push 시 골든 테스트) | Actions에서 `check_golden.py` PASS |
| T2 | P1 | 의존성 고정 (lock 파일) | 검증 조합(K-10)으로 CI 재현 |
| T3 | P1 | `scripts/ci_run.py` (C-5) | data_only·model_run 동작, 검증 ERROR면 exit 2, status.json 작성, 모델 코드 무변경 |
| T4 | P1 | `manual_update.yml` | Run workflow → 성공 시 커밋, 실패 시 데이터 커밋 없음 |
| T5 | P1 | 실보유 저장 분리 (K-3) | 커밋 대상 파일에 실보유가 없음. 정적 모드 계산 유지. `.gitignore` 반영 |
| T6 | P1 | 월간 기준일 헬퍼 (K-2) | 2026-11-02 실행 시 as_of=2026-10-30, 월=2026-10 |
| T7 | P2 | 마감 월 보호 (K-4) | `source=live`인 월은 `--force` 없이 재실행 거부 |
| T8 | P2 | `scheduled_monthly.yml` | 가드로 중복 없음. 2026-11 첫 실행 성공 |
| T9 | P2 | 대시보드 정적 호스팅 모드와 상태 패널 | JSON 상대 로드, 실패 시 seed 대체, parity PASS |
| T10 | P2 | 시장 데이터 안전 쓰기 (K-1) | 실패 시 기존 캐시 유지 |
| T11 | P2 | Actual Income (K-11) | Python·JS 동일 값 |
| T12 | P3 | 관측일·발표일 저장소, 빈티지 백테스트 (D-2) | 스키마와 조회 함수. 기존 결과와의 차이 보고 |
| T13 | P3 | 원클릭 dispatch (C-6 ②) | 토큰 비저장, 최소 권한 |
| T14 | P3 | 전체 워크포워드 워크플로 | 제안 JSON + PR (자동 적용 금지) |
| T15 | P3 | 백테스트 재현 스크립트 (K-12) | 핵심 수치 재현 또는 차이 설명 |

### G-5. 현재 상태와 목표 상태

| 항목 | 현재 상태 | 목표 상태 | 우선순위 |
|---|---|---|---|
| Dashboard | 단일 HTML v1.0. 정적 모드(내장 결과, 브라우저 주문 계산, CSV) + 로컬 백엔드 모드. GitHub Pages 미사용 | 정적 호스팅 모드(상대 JSON), 상태 패널, Update 버튼. 호스팅 방식은 결정 필요 | P2 |
| Market Data | 로컬에서 2009~ 전체 재다운로드 후 `data/market/*.csv.gz` 덮어쓰기 | Actions에서 수집 → 검증 통과 시에만 커밋. 월간 스냅샷 | P1 |
| yfinance | 구현 (샌드박스 Linux에서 검증) | Actions 러너에서 접속 검증, 재시도, 부분 실패 처리 | P1 |
| FRED | 키리스 CSV(검증), API(미검증), 캐시. ALFRED as-of 12종(검증). 발표일은 추정 규칙 | Secrets 키 사용 가능. 관측일·발표일 저장. 빈티지 백테스트 | P1 (수집) / P3 (빈티지) |
| Python | `qpm` v1.0, 명령어 스크립트 5종, 서버. v3.0 재현 확인 | 동일 코드를 Actions에서 실행 (+`ci_run.py`) | P1 |
| GitHub Actions | 없음 | 수동(workflow_dispatch)과 자동(schedule) 분리. 검증 통과 시 커밋. 골든 테스트 CI | P1 |
| Update Button | 로컬 백엔드 모드에서만 (`/api/jobs/update`) | 정적 대시보드 → 워크플로 실행 (링크 → API) | P2 |
| Data Validation | 구현 (ERROR 시 중단). 시장 캐시는 쓰기 후 검증 | 쓰기 전 검증, 커밋 게이트, status.json | P1 |
| Backtest | `run_path` 구현. 표시값은 v3.0 정적 JSON (패키지로 전체 재현 미검증) | 재현 스크립트, 결과 버전 관리, 빈티지 옵션 | P3 |
| Walk-forward | 수동 제안만 (2개 조합 축소 검증) | Actions 수동 장시간 실행 → 제안 PR | P3 |
| Optimization | cvxpy/CLARABEL, v3.0 재현 확인, 골든 테스트 | **변경 없음** (회귀 테스트로 고정) | 유지 |

### G-6. 프로젝트 규칙 (사용자가 명시한 규칙과 선호)

**모델·운용 규칙**

1. 유니버스는 25종 고정입니다. 임의 확장이나 코드·HTML에서의 재선정을 금지합니다. 변경하려면 재승인을 받습니다 [결정].
2. 목표: 인컴 7%+, 총수익 10%+(목표, 보장 아님), 월 1회 리밸런싱(월말 컷오프 → 익월 첫 거래일 적용), 밴드·거래비용 반영, 커버드콜 과다 편입 관리 [결정].
3. 파라미터는 워크포워드/OOS로 검증하고 look-ahead를 방지합니다. 10월 말 데이터로 11월 목표를 만들 때 11월 발표 지표는 쓰지 않습니다 [결정].
4. v3.0 기본값을 유지합니다: 인컴 소프트 7%, CC 30%, Credit 25%, Single 15%, JAAA 15%, DBMF 10%, 동적 하한, 밴드 1.5%p, 창 60개월, L 24개월, κ 1.0, λ 1.5, λ_income 50 [결정].
5. Credit 노출에는 JBBB·PFF를 VCIT·USHY와 합산합니다. JAAA는 별도로 관리합니다 [결정].

**데이터·표시 규칙**

6. 데이터가 없으면 추정하지 않고 Data unavailable / Estimated / Proxy로 표시합니다. 수치마다 기준일, 출처, 빈도, 계산 방법을 명시합니다 [결정].
7. Model Current·Target·Actual을 구분합니다. 실보유가 없으면 "Actual Portfolio: Not Provided"로 표시하고 Model Current를 Actual로 간주하지 않습니다 [결정].
8. 정직한 OOS와 부분 In-Sample을 구분합니다. κ=1.0 기대수익은 OOS 실현치와 분리해 표시합니다 [결정].
9. 0% ≠ 투자 부적격입니다. 한계 라벨(Computed / Actual / Estimated / Proxy / Insufficient Sample)을 씁니다 [결정].
10. 검증에서 문제가 발견되면 실행을 중단하고 오류를 표시합니다 [결정].

**시스템 규칙**

11. HTML = UI, Python = 데이터·엔진, LLM = 해석 전용입니다. LLM은 ETF 추가·삭제, 비중·한도 변경을 하지 않습니다 [결정].
12. API 키를 하드코딩하지 않습니다 (.env, 로컬 설정 → 클라우드에서는 GitHub Secrets) [결정].
13. 매월 코드 수정 없이 기준일만 바꾸거나 자동 인식해서 반복 실행합니다 [결정].

**사용자 선호** [결정: 선호]

14. HTML 파일명에 버전을 표기합니다.
15. HTML 화면은 단순하게 만듭니다: 탭·표 최소화, 계산 과정을 쉬운 말로 설명.
16. 산출물은 간결하고 구조화된 한국어 보고서체로 작성합니다.
17. 수치와 코드는 실행으로 검증하고 출처를 표기합니다. 확인할 수 없으면 추측하지 않습니다.

**이번 이사 요청** [결정]

18. 추측 금지
19. 현재와 계획을 구분
20. methodology 임의 변경 금지
21. secret 기록 금지
22. 관측일과 발표일 구분
23. 자동 업데이트와 수동 업데이트를 별개 기능으로 구현

### G-7. 이사 파일 목록

**반드시 이동** (이 저장소에 이미 포함)

- 코드: `qpm/*.py`(16개), `server.py`, 명령어 스크립트 5종, `run_*.bat/.sh`, `requirements.txt`
- 설정: `config/*.json`(4개), `.env.example`
- 대시보드: `dashboard/taa_pm_dashboard_v1.0.html`
- 연속성에 필요한 데이터·기록
  - `history/`: `index.json`, `2026-08` seed, `2026-09` live, `_reference`
  - `params/backtest_v3.0.json`
  - `data/` 캐시: 오프라인 골든 테스트와 재현에 필요
- 문서·테스트: `CLAUDE.md`, `README.md`, `docs/HANDOVER.md`, `docs/LOCAL_RUN_v1.0.md`, `tests/*`, `.gitignore`

**선택 이동** (Claude Project 산출물 — 참고·근거 자료)

- 1단계 스크리닝: `etf_screening_metrics_2026-09-28.csv`, `etf_universe_correlation_5y_monthly.csv`, `etf_candidates_correlation_5y_monthly.csv`
- 월간 최적화 v1~v3: `taa_income_monthly_run_2026-09_v{1.0,2.0,3.0}.xlsx`, `target_weights_2026-10_v{1.0,2.0,3.0}.csv`, `taa_income_pipeline_v{1.0,2.0,3.0}.zip` (이전 파이프라인, 참고용)
- 재생성 가능한 결과: `output/` 내 Excel·CSV
- 권장 위치: `archive/` 폴더 또는 GitHub Releases (Q9)

**이동하지 않음**

- `.env`, `config/settings.local.json`, 모든 API 키·토큰·비밀번호
- 실보유 파일
- `__pycache__`, 임시 테스트 복사본
- Claude 작업 환경의 중간 산출물 (`final_run2.pkl`, `stage2.pkl`, `report3.pkl`, `etf_data.pkl` 등 — 사용자 PC에는 없으며 저장소에도 불필요)

---

## H. CLAUDE.md

- 저장소 루트의 `CLAUDE.md`가 완성본입니다.
- 구성
  - Working Rules
  - Project Overview, Objective
  - Current Architecture, Repository Structure
  - Data Sources, Data Pipeline, Investment Universe
  - Model Methodology, Optimization, Backtest, Walk-forward
  - Dashboard, Data Update Architecture, yfinance, FRED, GitHub Actions, Data Validation
  - Important Design Decisions, Known Issues, Do Not Change
  - Future Development, Version History, Golden Test

## I. README.md

- 저장소 루트의 `README.md`가 완성본입니다 (GitHub 첫 화면용).
- v1.0 로컬 실행 설명서는 `docs/LOCAL_RUN_v1.0.md`로 옮겼고 내용은 그대로입니다.

---

## J. Migration Checklist (사용자가 실제로 할 일)

**준비**

- [ ] 1. 회사 정보보호·컴플라이언스 기준을 확인합니다: 외부 클라우드(GitHub)에 모델 결과·목표 비중을 저장해도 되는지, 실보유는 제외.
- [ ] 2. GitHub 계정과 요금제를 확인하고 Q1(비공개), Q2(조회 방식)를 결정합니다.
- [ ] 3. Claude Project 산출물을 PC에 백업합니다: `taa_pm_repo_v1.0.zip`과 선택 이동 파일.

**저장소 만들기**

- [ ] 4. zip을 풀고 `.env`가 **없는지** 확인합니다. `.gitignore`가 있는지 확인합니다.
- [ ] 5. GitHub에서 **Private** 저장소를 새로 만듭니다 (이름 자유).
- [ ] 6. 첫 커밋을 푸시합니다.
  ```bash
  cd taa_pm_repo_v1.0
  git init -b main
  git add .
  git commit -m "Import TAA PM System v1.0 (Model v3.0) + migration docs"
  git remote add origin https://github.com/<계정>/<저장소>.git
  git push -u origin main
  ```
- [ ] 7. (선택) Settings → Secrets and variables → Actions에 `FRED_API_KEY`, `ANTHROPIC_API_KEY`를 등록합니다.

**Claude Code 연결과 확인**

- [ ] 8. Claude Code에서 저장소를 엽니다 (설치·연결 방법은 공식 문서: docs.claude.com/en/docs/claude-code/overview).
- [ ] 9. Claude Code에 요청합니다: "CLAUDE.md와 docs/HANDOVER.md를 읽고 현재 상태와 P1 작업을 요약해줘" → 요약이 이 문서와 일치하는지 확인합니다.
- [ ] 10. Claude Code에서 `python tests/check_golden.py`를 실행해 PASS를 확인합니다.

**P1 작업 지시와 확인**

- [ ] 11. P1 작업을 지시합니다: T1(CI) → T2 → T5(실보유 분리) → T6(기준일) → T3(`ci_run.py`) → T4(수동 워크플로). PR마다 골든 테스트 결과를 확인합니다.
- [ ] 12. Actions 화면에서 manual-update를 수동 실행합니다 (`data_only`). 커밋 내용과 `status.json`을 확인합니다.
- [ ] 13. 검증 실패를 일부러 만들어 **커밋이 생기지 않는지** 확인합니다. Claude Code에 테스트 브랜치에서 하도록 요청합니다.

**첫 자동 운영**

- [ ] 14. T8(월간 스케줄)을 적용합니다. **첫 자동 실행 대상**: 2026-10 데이터(as_of 2026-10-30) → 11월 목표 (리밸런싱 2026-11-02). 11월 초에 결과를 모니터링합니다.
- [ ] 15. Q2·Q3 결정에 따라 대시보드 조회 방식과 Update 버튼을 구현하도록 지시합니다 (T9).

**마무리**

- [ ] 16. 과거 산출물 보관 위치를 결정합니다 (Q9).
- [ ] 17. 60일 이상 커밋이 없으면 공개 저장소의 schedule이 멈출 수 있습니다. 월간 커밋으로 자연스럽게 해소되지만, 비공개 저장소도 동작 여부를 모니터링합니다.
