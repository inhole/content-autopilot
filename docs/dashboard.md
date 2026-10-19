# 웹 대시보드

읽기 전용 현황 페이지다. Telegram을 열지 않고도 폰에서 파이프라인 상태, 체험단 진행, 최근 Threads 글을 볼 수 있다. DB에는 쓰지 않는다. 승인·패스·재시도 같은 조작은 계속 Telegram에서 한다.

워커 안에서 뜬다. 별도 프로세스나 의존성 없이 `node:http`로 같은 워커 안에서 돈다 (`src/web/`).

## 켜기

| 환경 변수 | 설명 |
|---|---|
| `DASHBOARD_PASSWORD` | 설정하면 대시보드가 켜진다. 비어 있으면 시작하지 않고 로그만 남긴다. |
| `PORT` | 수신 포트. Railway가 자동으로 주입하고, 없으면 8080이다. |

로그인은 HTTP Basic 인증이다. 사용자 이름은 아무 값이나 되고, 비밀번호가 `DASHBOARD_PASSWORD`와 같아야 한다. 긴 무작위 문자열을 쓴다 (예: `openssl rand -base64 24`).

## Railway 설정

1. 클라우드 워커 서비스의 Variables에 `DASHBOARD_PASSWORD`를 추가한다.
2. Settings > Networking에서 **Generate Domain**으로 공개 도메인을 만든다. 대상 포트는 Railway가 주입한 `PORT`를 따른다.

HTTPS는 Railway가 처리한다. Basic 인증은 비밀번호가 평문으로 가므로 반드시 HTTPS 주소로만 접속한다.

로컬에서 확인할 때는 `DASHBOARD_PASSWORD=test npm start` 후 http://localhost:8080 을 연다.

## React 앱과 JSON API

화면은 `web/`의 React + Vite + shadcn/ui 앱이고, 서버(`src/web/`)는 JSON API와 빌드 결과 서빙만 맡는다. 서버는 여전히 읽기 전용이다.

화면 구성: 왼쪽 사이드바(데스크톱은 아이콘으로 접기, 모바일은 슬라이드)에 현황·체험단·Threads 글·성과가 있고, 위쪽 헤더에 경로, 마지막 갱신 시각, 라이트/다크/시스템 테마 전환이 있다. 테마 선택은 브라우저 localStorage에 저장하고 기본은 시스템 설정을 따른다. 체험단 목록은 정렬(마감·경쟁률·점수)·검색·20건 단위 쪽 나누기를 지원하고, 행을 누르면 목록 위에 상세 시트가 열린다(`/campaigns/:id`로 바로 들어가면 전체 페이지). 성과는 7/30/90일 영역 차트를 쓴다.

### 빌드와 서빙

- 로컬 빌드: `npm run build:web` (`web/`에서 `npm ci` 후 `vite build`, 결과는 `web/dist`). 루트 `npm run build`도 같은 일을 한다. 루트 패키지에는 의존성이 늘지 않는다.
- `web/dist/index.html`이 있으면 워커가 `web/dist`를 서빙한다. `/assets/*`는 해시 파일이라 `Cache-Control: public, max-age=31536000, immutable`, 그 밖의 파일과 `index.html`은 `no-store`다. `/api`가 아닌 나머지 GET 경로는 모두 `index.html`로 돌려준다 (SPA 라우팅). 확장자가 있는데 없는 파일과 없는 `/assets/*`는 404다.
- 빌드 폴더가 없으면 예전 서버 렌더링 페이지(아래 「페이지」)를 같은 경로에서 그대로 서빙한다. 그래서 빌드 없이도 워커가 동작한다. 빌드 여부는 요청마다 확인한다.
- 빌드 폴더 위치는 기본 `<repo>/web/dist`이고, 환경 변수 `WEB_DIST_DIR`로 바꿀 수 있다.
- Railway는 배포 때 빌드 스크립트(`npm run build`)를 실행해야 한다. Railpack이 `build` 스크립트를 자동으로 돌리는지는 배포해서 확인해야 한다 (미검증). 돌리지 않으면 Settings에서 Build Command를 `npm run build`로 지정한다.
- 인증은 기존 Basic 인증 그대로다. `/healthz`만 인증 없이 열려 있고, `/api/*`와 정적 파일도 모두 인증이 필요하다. 경로에 `..`나 `%2e%2e`, 역슬래시, NUL이 있으면 400으로 막고 `web/dist` 밖의 파일은 읽지 않는다.
- CSP: React 앱 응답은 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: <이미지 호스트>; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`이다. 서버 렌더링 페이지는 기존 CSP(인라인 스타일·스크립트 허용)를 쓴다. API 응답은 `default-src 'none'; frame-ancestors 'none'`이다.

### 개발

- `cd web && npm run dev`: Vite 개발 서버. `/api`는 `http://localhost:8080`(워커의 대시보드)으로 프록시한다.
- `cd web && npm run dev:mock`: 백엔드 없이 `web/src/mocks/`의 예시 데이터로 화면을 띄운다.
- 검사: `npm run test:web`(루트) 또는 `cd web && npm run typecheck && npm test`. CI는 `web/`의 타입 검사, 테스트, 빌드까지 돌린다. 루트 `npm test`는 `web/`을 건너뛴다(앱 테스트는 jsdom과 `@/` 경로 별칭이 필요하다).
- 브라우저 주소에 `https://아이디:비번@…`처럼 인증 정보를 넣어 열면 브라우저가 `fetch`를 막아 데이터를 못 불러온다. 주소에는 넣지 말고, 브라우저가 묻는 창에 비밀번호를 넣는다.

### API

모두 GET/HEAD만 되고(그 밖의 메서드는 JSON 405), 응답은 `application/json; charset=utf-8`, `Cache-Control: no-store`다. 날짜는 ISO 8601 문자열이다. 오류는 `{ "error": "..." }`이며 400/404/405/500이고 스택은 담지 않는다. 응답 모양은 `src/web/api-types.ts`가 정의한다.

| 경로 | 설명 |
|---|---|
| `/api/overview` | 현황 (Threads 검수 대기·발행 예정·24시간 발행·실패, 체험단 상태별·출처별 개수, 마지막 수집) |
| `/api/campaigns?status=active\|all\|<STATUS>&source=kakao-gift\|musinsa` | 체험단 목록. 알 수 없는 값은 `active`와 전체 출처로 본다. 행마다 `next_deadline`(현재 단계의 마감, 선물하기 신청 마감은 `estimated: true`)과 `competition`(신청자/모집 인원, 모르면 null)을 더한다. |
| `/api/campaigns/<id>` | 체험단 상세와 보낸 리마인더. 숫자가 아니거나 없는 id는 404 |
| `/api/posts?limit=50` | 최근 Threads 글과 최신 반응 수치, `origin`(news / revived / digest). `limit`은 1~200 |
| `/api/insights?days=30` | 최근 `days`일(7~90) 안에 발행한 글의 반응. `daily`는 글마다 가장 최근 스냅샷을 KST 발행일별로 합산(오래된 날부터, 글이 있는 날만), `top`은 조회수 상위 10개 |

## 페이지 (서버 렌더링, 빌드가 없을 때)

- `/` 현황: Threads 검수 대기, 발행 예정, 최근 24시간 발행, 실패와 체험단 단계별 개수(검수 대기, 신청함·결과 대기, 선정·리뷰 전, 리뷰 초안, 최근 30일 리뷰 완료)를 보여준다. 체험단 마지막 수집 시각과 그때 확인한 체험단 수(가장 최근 `last_seen_at`에서 10분 이내)도 함께 나온다. 「출처별」 카드는 출처마다 진행 중 개수(검수 대기, 신청함, 선정, 초안 검수의 합)와 전체 개수를 보여주고, 누르면 그 출처의 목록(`/campaigns?source=…`)으로 간다.
- `/campaigns?status=active|all|<STATUS>&source=kakao-gift|musinsa` 체험단 목록. 상태 칩 위에 출처 칩(전체 / 선물하기 / 무신사)이 있어 출처로 거를 수 있다. 알 수 없는 `source` 값은 전체로 본다. 상태 필터와 출처 필터는 함께 걸린다. 제목(상세 링크), 출처, 브랜드, 상태, 경쟁률(`1,234:1`, 모르면 `-`. 무신사는 인원이 없어 항상 `-`), 마감 D-n, 점수를 보여준다. 신청 전·결과 대기 단계는 신청 마감, 선정·리뷰 초안 단계는 리뷰 마감을 쓴다. 선물하기 신청 마감은 남은 일수로 추정한 값이라 `추정`이라고 표시하고, 무신사는 정확한 값이라 표시하지 않는다. 마감이 가까운 순으로 정렬하고 마감이 없는 행은 뒤로 간다. 최대 300건.
- `/campaigns/<id>` 체험단 상세: 썸네일, 제목, 출처, 브랜드, 상품 ID, 모집·신청 인원과 경쟁률(선물하기만. 무신사는 대신 정가, 상품 수, 리뷰 형식 영상/사진), 남은 일수, 신청 마감(선물하기는 추정), 처음·마지막으로 본 시각, 점수와 이유, 제외·패스 사유, 신청·선정·결과·리뷰 완료 시각, 리뷰 마감, 보낸 리마인더, 메모, 리뷰 초안, 출처 링크(`선물하기에서 열기` / `무신사에서 열기`).
- `/posts` 최근 Threads 글 50개와 최신 반응 수치.
- `/healthz` 인증 없이 `ok`를 돌려준다. 헬스체크용이다.

목록 페이지는 60초마다 자동으로 새로고침된다.

## 보안

- GET/HEAD만 허용하고 나머지는 405를 돌려준다.
- 비밀번호는 양쪽을 해시한 뒤 `timingSafeEqual`로 비교한다.
- 모든 동적 텍스트는 HTML 이스케이프하고, `http(s)` URL만 링크로 만든다.
- 썸네일은 `https`이고 호스트가 `st.kakaocdn.net`, `t1.daumcdn.net`, `img1.kakaocdn.net`, `gift-s.kakaocdn.net`(선물하기), `image.msscdn.net`(무신사)인 URL만 그린다. CSP `img-src`도 같은 호스트만 허용한다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보낸다.

## 알려진 한계

- Threads 글의 permalink는 DB에 없어서 표시하지 않는다.
- 인증 실패 횟수 제한이 없다. 비밀번호를 충분히 길게 둔다.
