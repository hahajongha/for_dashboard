# dashboards/vendor — Knowledge Graph 은하 보기용 3D 번들

`kg3d.min.js`는 Knowledge Graph 창(`kg.html`)의 **은하** 보기만 쓰는 3D 라이브러리 묶음입니다.
CDN 대신 이 저장소에 고정 버전으로 두어 kg.html의 콘텐츠 보안 정책(`script-src 'self'`)을 그대로 지킵니다.
은하 보기를 처음 열 때만 받고, kg.js가 하위 리소스 무결성(SRI) 해시로 확인합니다.

| 패키지 | 버전 |
|---|---|
| 3d-force-graph | 1.80.1 |
| three | 0.186.1 |
| three-forcegraph | 1.43.6 |
| three-render-objects | 1.43.0 |

포함된 패키지 전체와 라이선스(MIT·ISC·BSD-3-Clause)는 `kg3d.LICENSES.txt`에 있습니다.
하위 의존성까지 모든 버전은 `kg3d-src/package-lock.json`에 고정되어 있습니다.

## 다시 만들기

저장소 밖의 빈 폴더에서 `kg3d-src/`의 세 파일(`package.json`·`package-lock.json`·`entry.js`)로 만듭니다.
`npm ci`는 잠금 파일의 버전 그대로 설치하므로 지금의 `kg3d.min.js`와 같은 바이트가 나옵니다.

```bash
cp <저장소>/dashboards/vendor/kg3d-src/{package.json,package-lock.json,entry.js} .
npm ci
npx esbuild entry.js --bundle --minify --format=iife --target=es2020 --legal-comments=eof --outfile=kg3d.min.js
```

버전을 올릴 때는 `kg3d-src/package.json`을 고치고 `npm install`로 `package-lock.json`을 다시 만든 뒤, 위 표와 `kg3d.LICENSES.txt`를 함께 바꿉니다.
그리고 `kg.js`의 `KG3D_SRI`를 새 파일의 sha384로 바꿉니다
(`openssl dgst -sha384 -binary kg3d.min.js | openssl base64 -A`). 해시가 다르면 브라우저가 파일을 실행하지 않습니다.
