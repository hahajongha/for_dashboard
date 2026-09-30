# TAA 인컴 월간 Quant PM 시스템 v1.0 (모델 v3.0)

25종 고정 유니버스로 매월 **데이터 업데이트 → 국면 → 점수 → 리스크 → 최적화 → 다음 달 목표 → 실보유 비교 → 주문**을 반복합니다.

| 층 | 역할 |
|---|---|
| HTML (`dashboard/taa_pm_dashboard_v1.0.html`) | 화면 |
| Python (`qpm/`) | 데이터, 퀀트 엔진 |
| 해설 | 해석 전용 — ETF·비중·한도를 바꾸지 않음 |

## 1. 설치 (최초 1회)

1. Python 3.10 이상에서 `pip install -r requirements.txt`를 실행합니다.
2. (선택) `.env.example`을 `.env`로 복사한 뒤 아래 키를 입력합니다.
   - `FRED_API_KEY`: FRED API 모드를 쓸 때만 필요합니다. 키리스 CSV는 키 없이 동작합니다.
   - `ANTHROPIC_API_KEY`: AI 해설을 쓸 때만 필요합니다.
   - 키는 `.env`에만 저장되며 HTML·로그에는 나오지 않습니다.

## 2. 매월 할 일 (예: 10월 말 데이터 → 11월 목표)

**방법 A — 대시보드와 백엔드 (권장)**

1. `run_server.bat`(또는 `python server.py`)를 실행하면 브라우저에서 `http://127.0.0.1:8765`가 열립니다. 이 주소는 내 PC에서만 접속됩니다.
2. 화면의 **이번 달 할 일** 1~6을 순서대로 누릅니다.
   - 업데이트: yfinance, FRED, ALFRED
   - 검증: 오류가 있으면 실행이 중단됩니다.
   - 모델 실행: 기준일을 비우면 마지막 거래일로 자동 설정됩니다.
   - 실보유 입력: CSV 업로드
   - 주문 확인
   - 내보내기: CSV 또는 Excel

**방법 B — 스크립트만 사용**

1. `run_monthly.bat`을 실행합니다. 내부적으로 `python portfolio_engine.py --update`가 돌아가고 `output/taa_pm_dashboard_v1.0_latest.html`이 열립니다.
2. 이 HTML은 서버 없이 열어도 실보유 비교, 주문 생성, CSV 내보내기가 브라우저에서 동작합니다.
3. 필요하면 `python rebalance_cli.py --actual 내보유.csv`를 실행한 뒤 `python export_excel.py`로 Excel을 만듭니다.

## 3. 날짜 규칙

- **Data As Of**: 마지막 확정 종가일입니다. 장이 열려 있는 동안의 당일 데이터는 자동으로 제외합니다.
- **Rebalance Date**: 다음 달 첫 NYSE 거래일입니다.
  - 2026-09-29 기준 → 2026-10-01
  - 2026-10-30 기준 → **2026-11-02** (11/1은 일요일)
- `history/` 폴더 이름은 **데이터 월**입니다. 예를 들어 `history/2026-10`에는 11월 적용 목표가 들어 있습니다.

## 4. Current / Target / Actual

| 구분 | 의미 |
|---|---|
| Model Current (추정) | 직전 월 목표에 이번 달 수익률을 반영한 모델상 드리프트 비중. **실보유가 아닙니다.** |
| Target | 이번 월말 데이터로 새로 산출한 다음 달 목표 |
| Actual | 사용자가 입력한 실제 보유. 입력 전에는 `Actual Portfolio: Not Provided`로 표시하고 주문을 만들지 않습니다. |

- 실보유를 먼저 저장한 뒤 `python portfolio_engine.py --basis actual`로 실행하면 최적화의 회전율 벌점과 밴드가 실보유 기준으로 계산됩니다.

## 5. 실보유 CSV

```
Ticker,Quantity,Price,Market Value,Weight
JEPQ,2650,61.18,,
QQQM,,,40000,
CASH,,,5000,
```

- 수량×가격과 평가금액 중 하나만 있으면 됩니다.
- 비중만 넣을 때는 총 평가금액을 함께 입력해야 합니다.
- `CASH` 행은 미투자 현금으로 처리합니다.
- 유니버스 밖 종목은 전량 매도 대상으로 표시합니다.
- 한글 헤더(종목·수량·현재가·평가금액·비중)도 인식합니다. 예시 파일: `sample/actual_portfolio_sample.csv`

**주문 규칙**

- 실보유 − 목표 > +1.5%p → SELL
- 실보유 − 목표 < −1.5%p → BUY
- 그 외 → HOLD
- 거래금액 = (목표 − 실보유) × 평가금액
- 거래비용 = (매수 + 매도) × 10bp
- 브라우저(JavaScript)와 Python이 같은 알고리즘을 씁니다. 동일 입력으로 대조한 결과 차이는 0이었습니다.

## 6. FRED 연결과 빈티지

- **FRED 연결 모드**: API(키 필요), Keyless CSV(기본), Local Cache(오프라인). 대시보드의 1단계에서 전환합니다.
- **ALFRED as-of 빈티지 (키 불필요)**: 수정이 발생하는 12개 시리즈(고용·물가·생산·소비·GDP·NFCI 등)를 **기준일 시점에 공개된 값**으로 대체합니다. 파일은 `data/alfred/`에 저장되어 재현할 수 있습니다.
- **발표시차 규칙**:
  - 월간 지표: m월 값은 m+1월 말부터 사용합니다. 기준일이 통상 발표일보다 앞서면 추가로 제외합니다.
  - 주간 지표: 발표 지연 1~5일을 반영합니다.
  - 과거 백테스트 구간은 빈티지 대신 이 규칙만 적용합니다.

## 7. 자동 검증 (ERROR가 하나라도 있으면 실행 중단)

| 대상 | 점검 항목 |
|---|---|
| ETF | 마지막 거래일 지연, 결측, 중복 날짜, 일간 가격 이상치(분할일 제외), 최근 3년 분배금 이상치, 상장 기간, 20일 거래량, 종가+분배 기준 Total Return 재계산 |
| FRED | 최근 관측일, 빈도, 다운로드 실패 시 캐시 대체, 수정치(revision) 감지, 빈티지 적용 여부 |
| 모델 | 비중 합 100%, 음수·NaN, 제약 위반(원 최적화는 ERROR, 밴드 유지분은 WARN), 공분산 PSD, 최적화 수렴, 인컴 재계산 |

## 8. 워크포워드 (연 1회)

- 기본값은 v3.0 고정 파라미터입니다 (`config/model_params.json`).
- `python walkforward_cli.py`(수 분 소요)를 실행하면 제안이 `params/wf_proposal_YYYY-MM.json`에 **저장만** 됩니다.
- 적용하려면 `model_params.json`을 직접 수정하고 `last_selection_year`를 갱신합니다.

## 9. 폴더

```
config/     universe.json · model_params.json · fred_series.json · settings.json
qpm/        data_layer · macro · etf_stats · scoring · engine · analytics · rebalance · validation · history · export · backtest · commentary · pipeline
dashboard/  taa_pm_dashboard_v1.0.html  (v3.0 2026-09-29 결과 내장)
data/       market(*.csv.gz) · fred · alfred · reference   ← 캐시
history/    YYYY-MM/result.json·CSV · index.json · _reference(백테스트 체인)
params/     backtest_v3.0.json · wf_proposal_*.json
output/     latest.json · taa_pm_dashboard_v1.0_latest.html · Excel/CSV
```

## 10. 한계 (대시보드 "모델 한계" 참고)

- **Insufficient Sample**
  - JAAA는 약 6년, JBBB는 약 4.7년 이력입니다. **두 ETF 모두 2020년 위기를 경험하지 않았으므로** CLO 스트레스 손실이 과소추정될 수 있습니다.
- **Proxy**
  - PFF 듀레이션은 FPE 5.42를 대용합니다. 실증 금리 민감도는 약 4.9년입니다.
  - PFF 금융주 집중도는 XLF 베타로 대체합니다. 공급사 섹터 데이터가 보통주 부분(약 5%)만 반영하기 때문입니다.
- **Estimated**
  - κ=1.0 기대수익은 낙관적일 수 있으므로 OOS 실현치와 별도로 표시합니다.
- **Not modelled**
  - 세금, ROC·ELN 분배금 과세, 환율(USD 기준)은 반영하지 않습니다.
- **Computed**
  - 2026-09 기준 현재 한도의 최대 인컴은 6.55%입니다.
  - 7% 달성에 필요한 최소 완화는 CC 40% + Single 20%입니다(7.04%, 크레딧 25% 유지). 세 가지를 모두 완화하면 7.10%입니다.
