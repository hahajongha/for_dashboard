# CLAUDE.md — for_dashboard (금융 대시보드 98)

public GitHub Pages 정적 사이트입니다. 기본 브랜치(`claude/data-sync-workflow-2jfh4w`)의 `/ (root)`가 그대로 배포됩니다
(build 없음, `.nojekyll` 유지). 저장소에 올린 파일은 모두 인터넷에 공개됩니다.

## 구성

| 경로 | 내용 | 규칙 |
|---|---|---|
| `index.html` | Win98 런처. 앱은 `APPS` 배열 항목 = iframe 창 | 새 앱은 `APPS` 항목 추가만. `icon`은 `ICONS` 키, `startmenu:true` 명시 |
| `dashboards/kospi_signal*.{html,js}` | KOSPI 시그널 랩 | TAA 작업 중에는 수정하지 않음 |
| `data/kospi_signal.json` | KOSPI OHLC — private `for_data` 저장소의 Actions가 발행 | **이 저장소의 코드·워크플로가 쓰지 않음** |
| `investment_model/` | TAA 인컴 포트폴리오 (Python 모델 + 대시보드 + 데이터) | **`investment_model/CLAUDE.md`의 규칙을 따름** (방법론 변경 금지, 골든 테스트 등) |
| `.github/workflows/*investment*` | TAA 데이터 갱신·모델 실행·테스트 | `investment_model/` 아래만 커밋 |

## 원칙

- 각 대시보드는 별도 HTML 문서(iframe)입니다. 스크립트·CSS를 합치지 않습니다(전역 이름 `$`, `S`, `.btn` 등이 겹침).
- 모든 앱이 같은 origin(`hahajongha.github.io`)의 localStorage를 공유합니다. 새 키는 앱별 prefix를 씁니다(KOSPI는 `kospiSignal.*`, `theme`).
- Pages 설정(branch deploy)과 기본 브랜치 이름을 바꾸지 않습니다 — for_data의 KOSPI 발행과 TAA 워크플로가 기본 브랜치에 push합니다.
- API 키·토큰을 코드·HTML·커밋에 넣지 않습니다. TAA는 키 없는 FRED CSV 경로를 씁니다.
- 실보유(Actual) 데이터를 커밋하지 않습니다 (`investment_model/CLAUDE.md` K-3). 공개 저장소입니다.

## 확인 방법

```bash
python3 -m http.server 8000                        # http://localhost:8000 — 런처·KOSPI·TAA 화면
python investment_model/scripts/golden_ci.py       # TAA 골든 + 주문엔진 일치 테스트 (requirements.lock 설치 필요)
```
