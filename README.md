# test_1 — 금융 대시보드 98 (public)

Windows 98 레트로 감성의 **대시보드 런처(바탕화면)** 와 그 안에서 실행되는
대시보드들로 구성된 정적 사이트입니다.

- **메인 화면**: `index.html` — Win98 스타일 바탕화면. 아이콘을 더블클릭하면
  해당 대시보드가 창으로 열립니다 (시작 메뉴·작업표시줄·창 이동/크기조절 지원)
- **채권·금융시장 대시보드**: `dashboards/bond.html` — 금리·환율·크레딧·헤지 프리미엄 등
  197개 일별 시계열 (바탕화면 아이콘 또는 직접 URL로 접근 가능)
- **데이터**: `data/dashboard_data.json` — private 저장소 `test1_data`의 GitHub Actions가
  자동으로 생성·갱신하는 파생 데이터

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

## 데이터 흐름

```
[private] test1_data                          [public] test_1 (이 저장소)
data/data_info.xlsx  ──push──▶ GitHub Actions ──▶ data/dashboard_data.json ──▶ 대시보드
(벤더 원본, 비공개)      (파생 데이터 생성·발행)      (최근 3년 요약만 공개)
```

원본 데이터는 데이터벤더 제공으로 **비공개 저장소에만 존재**하며,
이 저장소에는 대시보드 표시에 필요한 파생 요약(최근 3년 시계열, 최신값/변화폭,
수익률곡선 스냅샷)만 발행됩니다.

## 채권·금융시장 대시보드 구성

| 섹션 | 내용 |
|---|---|
| KPI 타일 | 국고 3Y/10Y, 기준금리, USDKRW, UST 10Y, VIX — 최신값·1D 변화·스파크라인 |
| 수익률곡선 | 한국/미국/일본/독일/호주 — 최신 vs 1개월 전 vs 1년 전 |
| 시계열 추이 | 197개 시리즈 중 최대 6개 선택 비교, 기간 프리셋(1M~3Y) |
| 전체 시리즈 현황 | 카테고리별 최신값과 1D/1W/1M/3M/YTD/1Y 변화폭 테이블 |

라이트/다크 테마를 지원하며 외부 라이브러리 없이 동작합니다.

## GitHub Pages 설정 (최초 1회)

이 저장소 → Settings → Pages → Source: **Deploy from a branch**,
Branch: 기본 브랜치 / `/ (root)` 선택.
이후 `https://hahajongha.github.io/test_1/` 에서 접속할 수 있습니다.

## 로컬에서 열기

`fetch`를 사용하므로 파일을 직접 열지 말고 간단한 서버로 띄웁니다:

```bash
python3 -m http.server 8000
# http://localhost:8000
```
