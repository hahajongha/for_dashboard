# CLAUDE.md — for_dashboard (금융 대시보드 98)

public GitHub Pages 정적 사이트입니다. 기본 브랜치(`claude/data-sync-workflow-2jfh4w`)의 `/ (root)`가 그대로 배포됩니다
(build 없음, `.nojekyll` 유지). 저장소에 올린 파일은 모두 인터넷에 공개됩니다.

## 구성

| 경로 | 내용 | 규칙 |
|---|---|---|
| `index.html` | Win98 런처. 앱은 `APPS` 배열 항목 = iframe 창 | 새 앱은 `APPS` 항목 추가만. `icon`은 `ICONS` 키, `startmenu:true` 명시 |
| `dashboards/kospi_signal*.{html,js}` | KOSPI 시그널 랩 — 번호 붙은 **전략 묶음**(1 BOP·이격도, 2 업종 2등주 `kospi_signal_tiger.js`, …) → 묶음 안의 탭 | TAA 작업 중에는 수정하지 않음. 새 아이디어는 `GROUPS`에 다음 번호 묶음으로 추가하고 기존 묶음의 계산 로직은 바꾸지 않음 (README "새 전략 묶음 추가"). 탭 id는 랩 전체에서 고유 |
| `dashboards/kg.{html,js}` | Knowledge Graph — 비공개 `for_kg`의 `vault/_build/`를 열람용 PAT로 GitHub API에서 직접 읽는 화면. 장력(평면) 보기와 은하(3D) 보기 — 은하 묶음·이름·위치는 graph.json의 `galaxy` 블록(for_kg가 계산)을 그대로 그림 | **노트·그래프 데이터를 이 저장소에 커밋하지 않음** (화면 코드만). kg.html의 연결은 `api.github.com`으로만 (CSP). 저장된 토큰(`kg.token`)은 같은 출처의 모든 페이지가 읽을 수 있으므로 **다른 앱 코드에서 `kg.*` 키를 읽거나 저장소 전체를 훑지 않음** |
| `dashboards/vendor/` | 은하 보기용 3D 엔진 번들 `kg3d.min.js`(3d-force-graph 1.80.1·three 0.186.1, 고정 버전), 라이선스 고지, 다시 만들 때 쓰는 `kg3d-src/`(package.json·package-lock.json·entry.js) | 손으로 고치지 않음. 다시 만들 때는 `vendor/README.md` 절차(`npm ci`)를 따르고 kg.js의 `KG3D_SRI`(sha384)를 함께 바꿈 — 다르면 브라우저가 실행하지 않음 |
| `data/kospi_signal.json` · `data/kospi_tiger.json` | KOSPI OHLC · 업종 2등주용 TIGER ETF 4종 종가 — private `for_data` 저장소의 Actions가 발행 | **이 저장소의 코드·워크플로가 쓰지 않음** |
| `investment_model/` | TAA 인컴 포트폴리오 (Python 모델 + 대시보드 + 데이터) | **`investment_model/CLAUDE.md`의 규칙을 따름** (방법론 변경 금지, 골든 테스트 등) |
| `.github/workflows/*investment*` | TAA 데이터 갱신·모델 실행·테스트 | `investment_model/` 아래만 커밋 |

## 원칙

- 각 대시보드는 별도 HTML 문서(iframe)입니다. 스크립트·CSS를 합치지 않습니다(전역 이름 `$`, `S`, `.btn` 등이 겹침).
- 모든 앱이 같은 origin(`hahajongha.github.io`)의 localStorage를 공유합니다. 새 키는 앱별 prefix를 씁니다(KOSPI는 `kospiSignal.*`, TAA는 `taaPm.*`, Knowledge Graph는 `kg.*` — 토큰은 기본 `sessionStorage`). 화면 테마 `theme`(`dark`/`light`)는 KOSPI와 Knowledge Graph가 함께 쓰는 공용 키입니다.
- Pages 설정(branch deploy)과 기본 브랜치 이름을 바꾸지 않습니다 — for_data의 KOSPI 발행과 TAA 워크플로가 기본 브랜치에 push합니다.
- API 키·토큰을 코드·HTML·커밋에 넣지 않습니다. TAA는 키 없는 FRED CSV 경로를 씁니다.
- 실보유(Actual) 데이터를 커밋하지 않습니다 (`investment_model/CLAUDE.md` K-3). 공개 저장소입니다.

## 확인 방법

```bash
python3 -m http.server 8000                        # http://localhost:8000 — 런처·KOSPI·TAA 화면
python investment_model/scripts/golden_ci.py       # TAA 골든 + 주문엔진 일치 테스트 (requirements.lock 설치 필요)
```
