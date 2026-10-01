# for_dashboard — 금융 대시보드 98 (public)

Windows 98 레트로 감성의 **대시보드 런처(바탕화면)** 와 그 안에서 실행되는
대시보드들로 구성된 정적 사이트입니다. → <https://hahajongha.github.io/for_dashboard/>

- **메인 화면**: `index.html` — Win98 스타일 바탕화면. 아이콘을 더블클릭하면
  해당 대시보드가 창으로 열립니다 (시작 메뉴·작업표시줄·창 이동/크기조절 지원)
- **KOSPI 시그널 랩**: `dashboards/kospi_signal.html` — Balance of Power(BOP) 매수 신호와
  50일 이동평균 이격도 매도 신호가 KOSPI 변곡점을 잡는지 검증하는 백테스트 대시보드
  (계산 엔진: `dashboards/kospi_signal_engine.js`, 엑셀 읽기: `dashboards/kospi_xlsx_lite.js`)
- **TAA 인컴 포트폴리오**: `investment_model/` — 미국 ETF 25종 월간 인컴/배당 포트폴리오 모델(Python)과 대시보드.
  데이터 갱신·모델 실행은 이 저장소의 GitHub Actions가 합니다 (아래 [TAA 인컴 포트폴리오](#taa-인컴-포트폴리오-investment_model) 참고)
- **데이터**: `data/kospi_signal.json` — private 저장소 `for_data`에 엑셀을 올리면
  GitHub Actions가 자동으로 생성·발행하는 KOSPI 일별 OHLC (원본 파일의 전체 기간)

## 데이터 갱신 (엑셀 업로드 → 자동 반영)

```
[private] for_data                                     [public] for_dashboard (이 저장소)
data/kospi/*.xlsx ──push──▶ GitHub Actions ──▶ data/kospi_signal.json ──▶ KOSPI 시그널 랩
(벤더 원본, 비공개)          (파생 데이터 생성·발행)    (KOSPI 일별 OHLC 전체 기간 공개)
```

1. github.com → `hahajongha/for_data` → `data/kospi` 폴더 → **Add file → Upload files**
2. 벤더 엑셀(양식 그대로, `BOP` 시트 포함)을 끌어다 놓고 **Commit changes**
3. 약 2분 뒤 사이트에 반영됩니다 (for_data → Actions 탭에서 진행 상황 확인)

원본 데이터는 데이터벤더 제공으로 **비공개 저장소에만 존재**하며,
이 저장소에는 대시보드 표시에 필요한 KOSPI 일별 시가·고가·저가·종가만 발행됩니다 (원본의 다른 시트는 발행하지 않음).
자세한 규칙은 for_data 저장소의 README를 참고하세요.

## KOSPI 시그널 랩 구성

두 지표로 KOSPI 변곡점을 확인합니다.

- **매수(B)**: BOP(14일 평균)가 기준선(기본 −0.20, −0.20~−0.25 구간 검토) 아래로 내려서는 날
  — BOP = (종가 − 시가) / (고가 − 저가) (엑셀 `Bulls − Bears` 수식과 동일)
- **매도(S)**: 종가 / 50일 이동평균 × 100 (이격도)이 기준선(기본 120%, 120~130% 구간 검토) 이상으로 올라서는 날
- **B⁺(이중 확인)**: B 조건과 "이격도 ≤ 상한(기본 95%)"이 함께 처음 충족된 날
- 같은 신호는 **최소 간격**(기본 10거래일) 안에 다시 내지 않습니다 (1로 두면 모든 진입 — 이전 버전과 같은 신호)
- 왼쪽 **설정 패널**에서 기간, 기준선·평균 기간, 보유/대기 일수, B 최대 대기, 이중 확인 상한,
  세부 가정(최소 간격·체결 시점·비용·현금 수익률)을 입력하면 모든 탭에 적용되고 이 브라우저에 저장됩니다.
  누적 성과는 **기준가 1000**으로 KOSPI Buy & Hold와 비교합니다.

| 탭 | 내용 |
|---|---|
| 차트·신호 | 현재 상태 판정 문장, KOSPI·BOP 평균·이격도 차트 위 **B / S / B⁺ 신호(ON·OFF)**, 전략 매매 표시(보유 구간 음영·체결점), 신호 내역(행을 누르면 그 날짜로 이동) |
| 성과·최적 조합 | 누적 성과(기준 1000)·낙폭, 전략 7종 성과표(평가 기준 선택·규칙 설명), **임계치 조합표**(칸을 누르면 그 기준선 적용), 연도별 수익률, 매매 내역, 과최적화 점검(IS → OOS) |
| 신호 검증 | B·B⁺·S 판정 문장, 신호 후 0~60일 평균 경로, 신호 후 수익률 vs 평상시(p-value·방향 판정), 기준선별 비교 |
| [데이터 · 계산 방법] 창 | 엑셀 업로드, 데이터 점검 결과, CSV 내보내기, 계산식·가정·유의사항 |

- **차트 조작** (보기만 바뀌고 분석 기간은 그대로 — [이 구간으로 분석]을 누를 때만 기간이 바뀜)
  - 드래그: 구간 확대 · Shift+드래그 또는 차트 아래 미니맵 끌기: 이동(미니맵 양 끝은 폭 조절)
  - Ctrl(⌘)+휠·트랙패드 핀치·두 손가락 핀치: 확대/축소 · 더블클릭 또는 [전체 보기]: 처음 화면
  - 차트를 누른 뒤 ←/→ 날짜 이동(Shift는 10일), +/− 확대, 0 전체 · 터치 한 손가락: 값 확인
  - 성과 탭의 누적 성과 차트는 차트·신호 탭과 보기 범위가 연동됩니다(‘보기 연동’ 칩으로 끄기)

- **데이터 범위**: 기본 데이터(`data/kospi_signal.json`)는 원본 파일의 **전체 기간**(2000년~)을 포함합니다.
  공개 범위는 for_data 저장소 `scripts/build_kospi_signal_data.py`의 `PUBLIC_LOOKBACK_DAYS`로 조정합니다.
- **엑셀 업로드로 바로 분석**: 대시보드의 [엑셀 업로드]로 벤더 원본(`BOP` 시트 포함)을 올리면
  발행을 기다리지 않고 그 파일로 바로 분석합니다. 파일은 **브라우저 안에서만** 처리되며
  어디에도 전송되지 않습니다 (그 브라우저에만 보관, "기본 데이터로 되돌리기"로 삭제).
  엑셀은 자체 해석기(`kospi_xlsx_lite.js`)로 읽어 외부 라이브러리를 받지 않습니다 (.xlsx · .xlsm, 예전 .xls는 .xlsx로 저장 후 업로드).
  외부에서 받는 것은 글꼴(IBM Plex Sans KR, Google Fonts)뿐이며, 받지 못하면 기본 글꼴로 표시됩니다.

## TAA 인컴 포트폴리오 (`investment_model/`)

Claude Project에서 개발한 TAA Income Quant PM System v1.0(Model v3.0)을 옮긴 모듈입니다.
모델·방법론·운용 규칙은 **`investment_model/CLAUDE.md`**, 사용 설명은 `investment_model/README.md`,
상세 인수인계는 `investment_model/docs/HANDOVER.md`에 있습니다.

- **화면**: `investment_model/output/taa_pm_dashboard_v1.0_latest.html` (바탕화면 "TAA 인컴 포트폴리오").
  결과 JSON이 HTML에 내장되어 있어 서버 없이 표시되고, 실보유 비교·주문 계산·CSV 내보내기는 브라우저 안에서만 동작합니다.
  **실보유 입력**(수량·평균매입단가·현금 → 평가금액·손익·비중 자동 계산)과 **내 포트폴리오 기록**(원금 투입·월말 평가금액·수익률)은 그 브라우저의 localStorage(`taaPm.holdings.v1`, `taaPm.ledger.v1`)에만 저장되고 저장소로 올라가지 않습니다 — 백업·다른 기기는 [CSV 내보내기]/[CSV 불러오기], [백업 내보내기](JSON)를 쓰세요.
- **데이터 갱신 (수동)**: 화면 1단계 **[Update Data ↗]** → GitHub Actions *Update investment data* → **Run workflow**
  - `data_only`: yfinance·FRED·ALFRED 데이터만 갱신 / `model_run`: 데이터 갱신 + 모델 실행 (`as_of` 비우면 자동 인식)
  - 데이터 갱신마다 `investment_model/output/latest_prices.json`(유니버스 최신 종가)도 갱신 → 실보유 표의 평가금액을 월 중간에도 최신 종가로 볼 수 있습니다(목표·주문 계산은 모델 기준일 종가 그대로).
- **자동 실행**: 매월 1~5일 22:17 UTC, 기준일 = 직전 월 마지막 NYSE 거래일. 이미 기록된 월은 건너뜁니다.
- **안전장치**: 임시 복사본에서 다운로드 → 데이터 가드(이력 잘림·티커 누락·관측치 소실·빈티지 누락 등) →
  패키지 검증 → 모델 실행이 **모두 통과할 때만** `investment_model/data·history·output`을 교체합니다.
  실패하면 기존 데이터는 그대로이고 `investment_model/output/status.json`에 실패 사유만 기록됩니다.
- **워크플로**: `.github/workflows/update-investment-data.yml`(수동), `investment-model-monthly.yml`(예약),
  `_investment-model-pipeline.yml`(공통), `investment-model-tests.yml`(골든·주문엔진 회귀 테스트)
- **KOSPI 데이터와의 관계**: TAA 워크플로는 `investment_model/` 아래만 커밋합니다. `data/kospi_signal.json`은 계속 for_data 저장소만 씁니다.

## 새 대시보드 추가하기

1. `dashboards/` 폴더에 새 HTML 파일을 만듭니다 (예: `dashboards/fx.html`).
   데이터는 `../data/...` 상대 경로로 읽습니다.
2. `index.html`의 `APPS` 배열에 항목을 하나 추가합니다:

```js
{ id: "fx", name: "환율 대시보드", icon: "chart", type: "iframe",
  url: "dashboards/fx.html", desktop: true, startmenu: true, w: 1200, h: 760 },
```

바탕화면 아이콘과 시작 메뉴에 자동으로 등록됩니다.
(아이콘은 `ICONS`에 정의된 픽셀 SVG 키를 사용하며, 새 아이콘을 추가해도 됩니다.)
원본 엑셀은 for_data 저장소의 `data/<대시보드>/` 폴더에 두고 빌드 스크립트를 추가합니다 (for_data README 참고).

## GitHub Pages 설정 (최초 1회)

이 저장소 → Settings → Pages → Source: **Deploy from a branch**,
Branch: 기본 브랜치 / `/ (root)` 선택.
이후 `https://hahajongha.github.io/for_dashboard/` 에서 접속할 수 있습니다.

## 로컬에서 열기

`fetch`를 사용하므로 파일을 직접 열지 말고 간단한 서버로 띄웁니다:

```bash
python3 -m http.server 8000
# http://localhost:8000
```
