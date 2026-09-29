# for_dashboard — 금융 대시보드 98 (public)

Windows 98 레트로 감성의 **대시보드 런처(바탕화면)** 와 그 안에서 실행되는
대시보드들로 구성된 정적 사이트입니다. → <https://hahajongha.github.io/for_dashboard/>

- **메인 화면**: `index.html` — Win98 스타일 바탕화면. 아이콘을 더블클릭하면
  해당 대시보드가 창으로 열립니다 (시작 메뉴·작업표시줄·창 이동/크기조절 지원)
- **KOSPI 시그널 랩**: `dashboards/kospi_signal.html` — Balance of Power(BOP) 매수 신호와
  50일 이동평균 이격도 매도 신호가 KOSPI 변곡점을 잡는지 검증하는 백테스트 대시보드
  (계산 엔진: `dashboards/kospi_signal_engine.js`)
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

- **매수(B)**: BOP(14일 평균)가 임계치(기본 −0.20, −0.20~−0.25 구간 검토) 아래로 내려서는 날
  — BOP = (종가 − 시가) / (고가 − 저가) (엑셀 `Bulls − Bears` 수식과 동일)
- **매도(S)**: 종가 / 50일 이동평균 × 100 (이격도)이 임계치(기본 120%, 120~130% 구간 검토) 이상으로 올라서는 날
- 모든 탭 위의 공통 설정 바에서 **기간**, **지표별 임계치·평균 기간**, 보유/회피 일수, 체결 시점,
  거래비용 등을 직접 입력해 비교합니다. 누적 성과는 **기준가 1000**으로 KOSPI Buy & Hold와 비교합니다.

| 탭 | 내용 |
|---|---|
| 차트 & 시그널 | KPI 타일, KOSPI 종가 차트 위 **B / S 신호 표시(ON·OFF 토글)**, BOP·이격도 보조 차트, 신호 내역 |
| 시그널 검증 | 신호 후 5·20·60·120일 수익률 vs 무조건부 평균, 적중률, 순열검정 p-value, 판정 |
| 전략 백테스트 | 신호 단독·조합 전략 6종 vs Buy & Hold — 누적 NAV(기준 1000), 낙폭, 초과수익·알파·IR, 연도별 성과, 매매 내역 |
| 임계치 비교 | BOP·이격도 임계치 목록별 성과, BOP × 이격도 히트맵 |
| 최적 조합 | 두 지표 조합 전략을 표본 내(IS) 최적화 → 표본 외(OOS) 검증으로 과최적화 점검 |
| 데이터 & 방법론 | 엑셀 업로드, 파싱 리포트, CSV 내보내기, 계산식·가정·한계 |

- **데이터 범위**: 기본 데이터(`data/kospi_signal.json`)는 원본 파일의 **전체 기간**(2000년~)을 포함합니다.
  공개 범위는 for_data 저장소 `scripts/build_kospi_signal_data.py`의 `PUBLIC_LOOKBACK_DAYS`로 조정합니다.
- **엑셀 업로드로 바로 분석**: 대시보드의 [엑셀 업로드]로 벤더 원본(`BOP` 시트 포함)을 올리면
  발행을 기다리지 않고 그 파일로 바로 분석합니다. 파일은 **브라우저 안에서만** 처리되며
  어디에도 전송되지 않습니다 (그 브라우저에만 보관, "기본 데이터로 복원"으로 삭제).
  엑셀 해석용 SheetJS 라이브러리만 첫 업로드 때 CDN에서 불러오며, 그 외 외부 라이브러리는 쓰지 않습니다.

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
