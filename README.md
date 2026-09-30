# TAA Income Quant PM System

미국 상장 ETF 25종으로 구성한 멀티에셋 **인컴·배당 포트폴리오**를 매월 운용하기 위한 퀀트 시스템입니다.

- 매월 월말 데이터로 다음 달 목표 비중(Target)을 계산합니다.
- 실제 보유(Actual)와 비교해 리밸런싱 주문을 만듭니다.

| 항목 | 값 |
|---|---|
| 시스템 버전 | v1.0 |
| 모델(엔진) 버전 | v3.0 |
| 기준 결과 | 2026-09-29 데이터 → 2026-10 목표 (적용일 2026-10-01) |
| 현재 실행 방식 | **로컬 PC** (Python + HTML) |
| 이전 목표 | GitHub Actions 기반 클라우드 실행 — 진행 예정, 아래 로드맵 참고 |

> Claude Code로 작업할 때는 [`CLAUDE.md`](CLAUDE.md)를 먼저 읽으세요.
> 상세 인수인계 문서는 [`docs/HANDOVER.md`](docs/HANDOVER.md)입니다.

---

## 1. 주요 기능

**현재 구현됨 (System v1.0)**

1. **데이터**
   - yfinance에서 가격·분배금·분할 정보를 받습니다.
   - FRED에서 매크로 시리즈 33개를 받습니다 (키 없는 CSV / API / 로컬 캐시 중 선택).
   - 발표 후 수정되는 12개 시리즈는 ALFRED에서 **기준일 시점 값(빈티지)**으로 받습니다.
2. **검증**
   - ETF: 지연, 결측, 중복, 이상치, 분배금, Total Return 재계산
   - FRED: 최근 관측일, 빈도, 수정치
   - 모델: 비중 합, 제약, PSD, 수렴
   - 오류가 하나라도 있으면 실행을 중단합니다.
3. **모델 (v3.0)**
   - 7개 요인 매크로 국면
   - ETF 점수: 모멘텀, 위험조정수익, 인컴, 매크로 적합도, 위험 벌점
   - 수축 공분산과 CVaR로 위험을 측정합니다.
   - 최적화는 cvxpy로 하며, 인컴 7%는 소프트 벌점으로 반영합니다.
   - 국면에 따라 주식·방어자산 하한이 바뀌고, 1.5%p 리밸런스 밴드를 적용합니다.
4. **분석**
   - 제약 진단 (어떤 제약이 비중을 결정했는지)
   - 인컴–리스크 프론티어와 한도 완화 분석
   - 파라미터 민감도, 7개 스트레스 시나리오
   - 0% 종목 분석, CLO·우선주 별도 분석
5. **실보유 비교**
   - CSV 업로드 또는 직접 입력으로 실보유를 넣습니다.
   - 목표와 비교해 BUY / SELL / HOLD, 거래금액, 현금 수요, 회전율, 거래비용을 계산합니다.
   - 자산군과 리스크 노출도 함께 비교합니다.
6. **이력·내보내기**
   - 월별 결과를 `history/<데이터월>/`에 저장합니다.
   - CSV와 Excel(12개 시트)로 내보낼 수 있습니다.
7. **대시보드**
   - 단일 HTML 파일이며 외부 라이브러리·CDN이 없어 오프라인에서도 열립니다.
   - 로컬 서버와 연결하면 업데이트·검증·실행 버튼을 쓸 수 있습니다.

**아직 없음 (계획)**

- GitHub Actions 자동·수동 실행
- GitHub Pages 대시보드
- 대시보드에서 클라우드 작업을 실행하는 Update 버튼
- 관측일·발표일 기반 빈티지 백테스트

---

## 2. 시스템 구조

**현재 (로컬)**

```
대시보드 HTML ──(정적 모드: 결과 내장, 브라우저에서 주문 계산)
      └──(백엔드 모드) server.py @127.0.0.1:8765 ── qpm 패키지 ── data/ · history/ · output/
```

**목표 (클라우드, 계획)**

```
대시보드 Update 버튼 / Actions "Run workflow" (수동) ─┐
schedule (자동, UTC cron)                           ─┴─> GitHub Actions ─> Python(qpm)
   ─> yfinance · FRED · ALFRED ─> 검증 ─(통과 시)─> commit/push ─> 대시보드 반영
```

- 자동 실행과 수동 실행은 별개의 워크플로로 만듭니다.
- 검증을 통과하지 못하면 커밋하지 않습니다. 따라서 기존 데이터가 보존됩니다.

---

## 3. 데이터 흐름 (월간)

1. 시장 데이터 수집
2. FRED 수집과 ALFRED 빈티지 적용
3. 검증
4. 국면 판정
5. ETF 통계 계산
6. 점수 계산
7. 공분산 추정
8. 리스크 모델
9. 파라미터 로드 (v3.0 고정)
10. 최적화
11. 다음 달 목표 산출
12. 실보유 입력
13. 목표 vs 실보유 비교
14. 주문 생성
15. 내보내기

**Look-ahead 방지**

- as_of 이후의 가격·지표는 쓰지 않습니다.
- 월간 지표는 관측월 다음 달 말부터 사용합니다. 통상 발표일 이전이면 추가로 제외합니다.
- 주간 지표는 발표 지연 1~5일을 반영합니다.
- 수정되는 지표는 기준일 시점 빈티지를 씁니다.

---

## 4. 사용 데이터

| 구분 | 내용 |
|---|---|
| ETF 25종 (고정) | JEPQ GPIX JEPI · SCHD VYMI VIG · VOO QQQM VEA IEMG · SGOV · VGSH VGIT VGLT SCHP VCIT USHY · JAAA · JBBB · PFF · DBMF · PDBC SCHH IGF GLDM |
| 상장 전 대용 | SGOV←BIL, GLDM←IAU, USHY←HYG, QQQM←QQQ, VOO←SPY |
| 기준 티커 | ^IRX (무위험수익률), XLF (PFF 금융 민감도) |
| 매크로 | 성장, 물가, 금리, 크레딧, 변동성, 유동성, 달러 요인의 FRED 시리즈 33개. 목록은 `config/fred_series.json` |

---

## 5. 실행 방법 (현재: 로컬)

```bash
pip install -r requirements.txt            # Python 3.10+ (검증: 3.12.3)
cp .env.example .env                        # 선택: FRED_API_KEY / ANTHROPIC_API_KEY
python server.py                            # 대시보드 + 백엔드 → http://127.0.0.1:8765
# 또는 스크립트만 사용
python portfolio_engine.py --update                      # 데이터 업데이트 + 모델 실행 (기준일 자동)
python portfolio_engine.py --as-of 2026-10-30            # 월간 실행은 기준일을 명시하는 것을 권장
python rebalance_cli.py --actual my_holdings.csv         # 실보유 비교·주문 (주의: 결과 파일에 실보유가 기록됨)
python export_excel.py                                   # Excel·CSV
python tests/check_golden.py                             # 회귀 테스트 (오프라인)
```

- 자세한 로컬 사용법은 [`docs/LOCAL_RUN_v1.0.md`](docs/LOCAL_RUN_v1.0.md)에 있습니다.

**날짜 규칙**

- Data As Of = 마지막 확정 종가일
- Rebalance Date = 다음 달 첫 NYSE 거래일. 예: 2026-10-30 기준 → 2026-11-02
- `history/2026-10`에는 **11월 적용 목표**가 저장됩니다.

---

## 6. 개발 환경

- **검증된 조합**: Python 3.12.3, pandas 3.0.2, numpy 2.4.4, cvxpy 1.9.3 (CLARABEL), yfinance 1.7.0, openpyxl 3.1.5
- **추가 요구사항**
  - `tzdata`: Windows에서 필요합니다.
  - Node: JS 주문 엔진 대조 테스트에만 필요합니다.
- **미검증**
  - Windows·사내망 환경
  - FRED API 모드
  - AI 해설 호출
  - GitHub Actions 러너에서의 데이터 접속

---

## 7. 저장소 구조

```
CLAUDE.md                 Claude Code 지침 (먼저 읽기)
README.md                 이 파일
docs/HANDOVER.md          상세 인수인계 (현재 vs 목표, 데이터 무결성, 이사 체크리스트)
docs/LOCAL_RUN_v1.0.md    v1.0 로컬 실행 설명서 (원본)
config/                   universe · model_params · fred_series · settings (JSON)
qpm/                      Python 패키지 (데이터·검증·국면·점수·최적화·분석·주문·이력·내보내기)
dashboard/                taa_pm_dashboard_v1.0.html (2026-09-29 결과 내장)
data/                     시장·FRED·ALFRED 캐시
history/                  월별 결과 · index.json (월별 목표·인컴 이력)
params/                   backtest_v3.0.json (정적 백테스트·워크포워드 결과)
output/                   latest.json · 결과 내장 대시보드
sample/                   실보유 CSV 예시 (가상 데이터)
tests/                    골든 테스트 · JS/Python 주문 계산 대조
*.py                      server · update_data · portfolio_engine · rebalance_cli · export_excel · walkforward_cli
```

---

## 8. 주의사항

- **저장소는 비공개(private)로 운영하는 것을 권장합니다.**
  - GitHub Pages 사이트는 저장소가 비공개여도 인터넷에 공개됩니다 (접근 제어는 Enterprise Cloud 조직만 가능).
  - 목표 비중이나 운용 정보를 공개해도 되는지 먼저 확인하세요.
- **실보유 데이터는 커밋하지 마세요.**
  - 현재 코드는 실보유를 결과 JSON·HTML에도 기록합니다 (`CLAUDE.md` K-3).
- **API 키는 `.env`(로컬) 또는 GitHub Secrets에만 저장합니다.**
- 이 시스템은 분석 도구이며, 결과는 투자 권유가 아닙니다.
  - 모델 기대수익(κ=1.0)은 낙관적일 수 있습니다.
  - 백테스트 OOS 실현치와 구분해서 보세요.

---

## 9. 향후 개발 계획

| 우선순위 | 내용 |
|---|---|
| P1 | 비공개 저장소 + 골든 테스트 CI |
| P1 | 수동 실행 워크플로 (workflow_dispatch) |
| P1 | 실보유 저장 분리 |
| P1 | 월간 기준일 명시 로직 |
| P2 | 월간 자동 실행 (schedule) |
| P2 | 대시보드 상태 표시 (Last Update, 데이터 기준일, 검증 결과) |
| P2 | 정적 호스팅 모드 |
| P2 | 안전한 데이터 쓰기 |
| P3 | 관측일·발표일 저장과 빈티지 백테스트 |
| P3 | 원클릭 Update |
| P3 | 전체 워크포워드 워크플로 |

- 상세 내용은 `docs/HANDOVER.md` §G-4를 참고하세요.
