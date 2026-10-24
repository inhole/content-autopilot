# 웹 대시보드

Telegram을 열지 않고도 폰이나 PC에서 파이프라인 상태, 체험단 진행, 최근 Threads 글과 성과를 보는 화면이다. 관리자 콘솔로 넓히는 중이다(roadmap.md 3절). 1단계(Telegram 1회용 코드 로그인), 2단계(체험단 조작), 3단계(Threads 글 검수·예약과 만료 초안)까지 있고, 수집 실행 같은 운영 버튼(4단계)은 아직 Telegram과 CLI에서 한다.

워커 안에서 뜬다. 별도 프로세스 없이 `node:http`로 같은 워커 안에서 돈다 (`src/web/`).

## 켜기

| 환경 변수 | 설명 |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | 둘 다 있으면 대시보드가 켜진다. 로그인 코드를 이 채팅으로 보내므로, 없으면 시작하지 않고 로그만 남긴다. |
| `PORT` | 수신 포트. Railway가 자동으로 주입하고, 없으면 8080이다. |
| `PUBLIC_BASE_URL` | 선택. 대시보드의 공개 https 주소(경로 없이). 있으면 카카오톡 카드가 `/go/gift/<ID>`로 카카오톡 앱을 연다. 로그인 요청의 출처 검사에도 이 주소를 허용한다. |

예전 `DASHBOARD_PASSWORD`(Basic 인증)는 더 이상 쓰지 않는다. 남아 있어도 무시한다.

## 로그인

비밀번호는 없다. Telegram 계정을 가진 사람만 들어올 수 있으므로 Telegram 계정 보안이 곧 대시보드 보안이다.

1. 로그인 화면에서 `Telegram으로 코드 받기`를 누르면 봇이 `TELEGRAM_CHAT_ID`로 6자리 코드를 보낸다(`🔐 관리자 콘솔 로그인 코드`, 요청 IP 포함).
2. 코드를 넣으면 로그인된다. 원래 보려던 페이지로 돌아간다.

| 규칙 | 값 |
|---|---|
| 코드 유효 시간 | 5분, 한 번만 쓴다. 새 코드를 받으면 이전 코드는 바로 무효가 된다. |
| 틀린 입력 | 코드당 5번까지. 5번 틀리면 그 코드는 막히고 Telegram으로 알린다. |
| 코드 요청 | 1분에 1번, 한 시간에 5번. 시간당 한도에 처음 걸리면 Telegram으로 알린다. |
| 세션 | 30일. 쿠키 `ca_session`(`HttpOnly; Secure; SameSite=Strict`)에 무작위 토큰만 두고, DB(`admin_sessions`)에는 그 해시만 둔다. |
| 로그인 성공 | Telegram으로 `🔐 관리자 콘솔 로그인`(시각, IP)을 보낸다. |

- 코드도 해시(`admin_login_codes.code_hash`)로만 저장한다. 코드 원문은 Telegram 메시지에만 있다.
- 사이드바 아래 `로그아웃`은 이 브라우저의 세션을, `모든 세션 끊기`(확인 창을 거친다)는 모든 기기의 세션을 끊는다. 모두 끊으면 Telegram으로 알린다.
- 세션이 끝나면(만료, 다른 곳에서 모두 끊음) 다음 데이터 요청이 401을 받고 화면이 로그인으로 돌아간다.
- 모든 로그인 관련 동작(코드 요청, 로그인 성공·실패, 로그아웃)은 `admin_actions`에 시각, IP, 결과와 함께 남는다.
- 서버는 `X-Forwarded-For`의 첫 주소를 IP로 기록한다(Railway 프록시). 기록과 알림용이고 접근 제어에는 쓰지 않는다.

## Railway 설정

1. 클라우드 워커 서비스에 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`가 있는지 확인한다(봇 검수에 이미 쓰고 있다).
2. Settings > Networking에서 **Generate Domain**으로 공개 도메인을 만든다. 대상 포트는 Railway가 주입한 `PORT`를 따른다.

HTTPS는 Railway가 처리한다. 세션 쿠키에 `Secure`가 붙으므로 HTTPS 주소로만 로그인된다(브라우저는 `localhost`만 예외로 둔다).

로컬에서 확인할 때는 Telegram 값을 넣은 `.env`로 `npm start` 후 http://localhost:8080 을 연다.

## React 앱과 JSON API

화면은 `web/`의 React + Vite + shadcn/ui 앱이고, 서버(`src/web/`)는 JSON API와 빌드 결과 서빙만 맡는다. 데이터 조회 API는 읽기 전용이다. 쓰기 요청은 로그인·로그아웃, 체험단 조작(아래 「체험단 조작」), Threads 조작(아래 「Threads 조작」)뿐이다.

화면 구성: 왼쪽 사이드바(데스크톱은 아이콘으로 접기, 모바일은 슬라이드)에 현황·체험단·Threads 글·만료 초안·성과가 있고, 위쪽 헤더에 경로, 마지막 갱신 시각, 라이트/다크/시스템 테마 전환이 있다. 테마 선택은 브라우저 localStorage에 저장하고 기본은 시스템 설정을 따른다. 체험단 목록은 정렬(마감·경쟁률·점수)·검색·20건 단위 쪽 나누기를 지원하고, 행을 누르면 목록 위에 상세 시트가 열린다(`/campaigns/:id`로 바로 들어가면 전체 페이지). Threads 글 목록도 같은 방식으로 `/posts/:id` 상세 시트를 연다. 성과는 7/30/90일 영역 차트를 쓴다.

### 빌드와 서빙

- 로컬 빌드: `npm run build:web` (`web/`에서 `npm ci` 후 `vite build`, 결과는 `web/dist`). 루트 `npm run build`도 같은 일을 한다. 루트 패키지에는 의존성이 늘지 않는다.
- `web/dist/index.html`이 있으면 워커가 `web/dist`를 서빙한다. `/assets/*`는 해시 파일이라 `Cache-Control: public, max-age=31536000, immutable`, 그 밖의 파일과 `index.html`은 `no-store`다. `/api`가 아닌 나머지 GET 경로는 모두 `index.html`로 돌려준다 (SPA 라우팅). 확장자가 있는데 없는 파일과 없는 `/assets/*`는 404다.
- 빌드 폴더가 없으면 화면 경로는 503(`npm run build:web` 안내)을 돌려준다. API, `/healthz`, `/go/gift/<ID>`와 워커의 다른 일은 그대로 돈다. 빌드 여부는 요청마다 확인한다. 예전 서버 렌더링 페이지는 로그인 화면이 없어 지웠다.
- 빌드 폴더 위치는 기본 `<repo>/web/dist`이고, 환경 변수 `WEB_DIST_DIR`로 바꿀 수 있다.
- Railway는 배포 때 빌드 스크립트(`npm run build`)를 실행해야 한다. Railpack이 `build` 스크립트를 자동으로 돌리는지는 배포해서 확인해야 한다 (미검증). 돌리지 않으면 Settings에서 Build Command를 `npm run build`로 지정한다.
- 화면 파일(`index.html`, `/assets/*` 등)은 데이터가 없으므로 로그인 없이 내려준다. 앱이 `/api/auth/session`으로 세션을 확인하고 없으면 로그인 화면을 띄운다. `/api/*` 데이터는 세션이 있어야 하고 없으면 JSON 401이다. 경로에 `..`나 `%2e%2e`, 역슬래시, NUL이 있으면 400으로 막고 `web/dist` 밖의 파일은 읽지 않는다.
- CSP: React 앱 응답은 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: <이미지 호스트>; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`이다. API와 그 밖의 응답은 `default-src 'none'; frame-ancestors 'none'`이다.

### 개발

- `cd web && npm run dev`: Vite 개발 서버. `/api`는 `http://localhost:8080`(워커의 대시보드)으로 프록시한다.
- `cd web && npm run dev:mock`: 백엔드 없이 `web/src/mocks/`의 예시 데이터로 화면을 띄운다.
- 검사: `npm run test:web`(루트) 또는 `cd web && npm run typecheck && npm test`. CI는 `web/`의 타입 검사, 테스트, 빌드까지 돌린다. 루트 `npm test`는 `web/`을 건너뛴다(앱 테스트는 jsdom과 `@/` 경로 별칭이 필요하다).
- `npm run dev:mock`은 로그인된 상태(`sessionFixture`)로 뜬다.

### API

데이터 API는 모두 GET/HEAD만 되고(그 밖의 메서드는 JSON 405) 세션이 있어야 한다(없으면 `{ "error": "로그인이 필요해요" }` 401). 응답은 `application/json; charset=utf-8`, `Cache-Control: no-store`다. 날짜는 ISO 8601 문자열이다. 오류는 `{ "error": "..." }`이며 400/404/405/500이고 스택은 담지 않는다. 응답 모양은 `src/web/api-types.ts`가 정의한다.

| 경로 | 설명 |
|---|---|
| `/api/overview` | 현황 (Threads 검수 대기·발행 예정·24시간 발행·실패, 체험단 상태별·출처별 개수, 마지막 수집) |
| `/api/campaigns?status=active\|all\|<STATUS>&source=kakao-gift\|musinsa` | 체험단 목록. 알 수 없는 값은 `active`와 전체 출처로 본다. 행마다 `price`(정가 원 단위, 모르면 null; 카카오톡은 수집 때 읽은 `detail.price.basic`, 무신사는 대표 상품 정가)와 `next_deadline`(현재 단계의 마감, 카카오톡 체험단 신청 마감은 `estimated: true`)과 `competition`(신청자/모집 인원, 모르면 null)을 더한다. |
| `/api/campaigns/<id>` | 체험단 상세와 보낸 리마인더. 숫자가 아니거나 없는 id는 404 |
| `/api/posts?limit=50` | 최근 Threads 글과 최신 반응 수치, `origin`(news / revived / digest). `limit`은 1~200 |
| `/api/posts/<id>` | Threads 글 상세: 본 글과 답글 조각(`post_parts`의 상태·시도·오류·조각 링크), 주제, 확인 필요, `revision`·`regen_seq`, 재활용 판정과 살리기 전 원문, 묶음 글 id, 글자 수 한도(`limits`: 500, 마지막 답글은 CTA 자리를 뺀 값). 숫자가 아니거나 없는 id는 404 |
| `/api/revivable` | 다시 살릴 수 있는 만료 초안(`/revive` 목록과 같다: 30일 안의 `EXPIRED` 뉴스 초안 중 살리지도 묶지도 않은 것, 최신순 20개)과 저장된 판정 |
| `/api/insights?days=30` | 최근 `days`일(7~90) 안에 발행한 글의 반응. `daily`는 글마다 가장 최근 스냅샷을 KST 발행일별로 합산(오래된 날부터, 글이 있는 날만), `top`은 조회수 상위 10개 |

인증 API (`src/web/server.ts`, 모양은 `api-types.ts`의 `AuthSessionResponse`, `AuthCodeResponse`):

| 경로 | 설명 |
|---|---|
| `GET /api/auth/session` | `{ authenticated: true, csrf, expiresAt }` 또는 `{ authenticated: false }`. 세션이 없어도 200이다. |
| `POST /api/auth/code` | 코드를 Telegram으로 보낸다. 200 `{ expiresAt }`, 한도에 걸리면 429 `{ error, retryAfter }`(+ `Retry-After`), Telegram 전송 실패는 502(그 코드는 바로 무효). |
| `POST /api/auth/login` | 본문 `{ code: "123456" }`. 성공하면 세션 쿠키와 `{ authenticated: true, csrf, expiresAt }`. 형식이 틀리면 400, 틀린 코드 401(남은 횟수), 5번 틀리면 429, 유효한 코드가 없으면 400. |
| `POST /api/auth/logout` | 이 세션을 끊고 쿠키를 지운다. |
| `POST /api/auth/logout-all` | 모든 세션을 끊는다. `{ ok: true, revoked }` |

모든 POST는 `Content-Type: application/json`이고 `Origin`이 이 서버(`Host`, `X-Forwarded-Host` 또는 `PUBLIC_BASE_URL`)여야 하며, `Sec-Fetch-Site`가 있으면 `same-origin`이어야 한다. 아니면 403이다. 로그아웃 두 개는 세션과 `X-CSRF-Token` 헤더(세션 응답의 `csrf`)도 맞아야 한다. 본문은 4KB까지 받는다.

## 체험단 조작

체험단 상세 화면(시트와 전체 페이지 모두)의 `작업` 카드에서 Telegram 버튼이 하던 일을 한다. 상태별로 보이는 조작이 다르다.

| 상태 | 조작 | API |
|---|---|---|
| `PENDING_REVIEW` | `신청함` | `apply` |
| | `패스` (사유 선택, 확인 창) | `reject` |
| `APPLIED` | `선정` | `result` `{ selected: true }` |
| | `미선정` (확인 창) | `result` `{ selected: false }` |
| `SELECTED`, `DRAFT_REVIEW` | 리뷰 기한 (`/due`와 같은 형식, 그날 끝까지) | `deadline` |
| | 사용 메모 입력 → 초안 만들기 (`DRAFT_REVIEW`에서는 메모 저장하고 다시 쓰기) | `memo` |
| `DRAFT_REVIEW` | 다시 쓰기 (피드백은 선택) | `regenerate` |
| | 초안 직접 수정 (`수정:` 답장과 같다. 협찬 문구는 코드가 맨 앞에 맞춘다) | `draft` |
| | `리뷰 올림` (확인 창) | `posted` |

초안은 `메모·초안` 카드에 복사 버튼과 함께 보인다(`navigator.clipboard`가 막히면 직접 복사하라는 안내를 띄운다). 끝난 상태(`POSTED`, `REJECTED` 등)에는 작업 카드가 없다.

**API** (`POST /api/campaigns/<id>/<조작>`, 본문은 `api-types.ts`의 `CampaignActionRequests`):

| 조작 | 본문 | 기준 |
|---|---|---|
| `apply` | `{ revision }` | `PENDING_REVIEW`이고 카드 revision이 같을 때 |
| `reject` | `{ revision, reason }` (`category` / `competition` / `brand` / `other`) | 위와 같다 |
| `result` | `{ selected }` | 상태가 `APPLIED`일 때 (Telegram 결과 버튼과 같다) |
| `deadline` | `{ status, date }` | 화면이 본 상태와 같을 때. `date`는 `10/30`, `10-30`, `10.30`, `2026-10-30` |
| `memo` | `{ status, revision, memo }` (2000자까지) | 상태와 revision이 같을 때. 메모를 저장하고 `review-draft` 작업을 큐에 넣는다 |
| `regenerate` | `{ revision, feedback? }` | `DRAFT_REVIEW`이고 revision이 같을 때. 큐에 넣는다 |
| `draft` | `{ revision, text }` | `DRAFT_REVIEW`이고 revision이 같을 때. 새 초안과 컨트롤 메시지를 Telegram에도 다시 보낸다 |
| `posted` | `{ revision }` | `DRAFT_REVIEW`이고 revision이 같을 때 |

- 응답: 200 `{ ok: true, telegramSynced, detail }` (`detail`은 처리 뒤 상세, 앱이 캐시에 바로 넣는다), 400 본문·날짜·글자 수 오류, 404 없는 캠페인, **409 `{ error: "이미 처리됐거나 내용이 바뀌었어요. 새로 고침했어요", stale: true }`**.
- 모든 쓰기는 Telegram 버튼이 부르는 **같은 조건부 함수**를 부른다 (`src/campaigns/actions.ts`). 전환 SQL을 새로 만들지 않았다. 화면이 본 `revision`과 `status`를 같이 보내므로, 그 사이 Telegram에서 먼저 처리했거나 초안이 바뀌었으면 아무것도 바꾸지 않고 409를 돌려주고, 앱은 상세를 다시 받는다. 웹은 컨트롤 메시지가 없어도 쓸 수 있게 `markPosted(id, revision, { control: false })`와 `replaceDraftGuarded(id, { revision }, text)`로 revision에만 묶는다 (Telegram 쪽 호출은 그대로 컨트롤 메시지에 묶인다).
- **LLM은 큐로만.** `memo`와 `regenerate`는 `enqueueReviewDraft`로 `regen_seq`를 올리고 `review-draft` 작업을 넣을 뿐, 웹 요청 안에서 기다리지 않는다. `startDashboard()`가 `enqueueDraft`를 주입받는다. 초안이 쓰이면 워커가 Telegram에 초안과 컨트롤 메시지를 보낸다.
- **초안 작성 중 표시.** `campaigns.draft_seq`(migration `020`)는 현재 초안이 쓰인 `regen_seq`다. `regen_seq > draft_seq`이면 요청이 진행 중이라 화면이 `초안 작성 중` 안내를 띄우고 3초마다 상세를 다시 받는다. 10분이 지나도 안 오면 오래 걸린다는 안내와 함께 다시 요청할 수 있게 한다(작업이 최종 실패하면 Telegram으로 알림이 간다). 직접 수정(`draft`)은 `regen_seq`와 `draft_seq`를 함께 올려 대기 중이던 재생성이 덮어쓰지 못하게 한다.
- **Telegram과 맞추기** (best effort, 실패하면 로그만 남기고 조작은 성공으로 돌려준다. `telegramSynced: false`로 알린다): `apply`는 카드 키보드를 지우고 결과 버튼(`🎉 선정` / `😢 미선정`) 메시지를 보낸다. `reject`는 카드 키보드를 지우고 `🙅 패스했어요`를 보낸다. `result`는 선정이면 `📝 리뷰 초안 쓰기` 버튼 메시지를, 미선정이면 안내를 보낸다. `draft`는 `수정:` 답장처럼 `sendDraft`로 새 초안과 컨트롤 메시지를 보내고 이전 컨트롤 메시지의 키보드를 지운다. `posted`는 컨트롤 메시지 키보드를 지우고 `🎉 리뷰 완료로 기록했어요`를 보낸다. 메시지 문구는 봇과 같은 함수를 쓴다. `deadline`은 Telegram에 보내지 않는다.
- 결과 버튼 메시지(`apply` 뒤에 보낸 것)의 ID는 저장하지 않으므로, 웹에서 선정·미선정을 처리해도 그 메시지의 버튼은 남는다. 나중에 누르면 `이미 처리됐어요`로 끝난다(결과 전환은 상태로만 막는다).
- 세션, 같은 출처 JSON, `X-CSRF-Token`을 모두 검사한다 (`server.ts`의 `authorizeWrite`, 로그아웃도 같은 함수). 본문은 이 경로에서만 16KB까지 받는다(메모·초안이 한글이라 4KB로는 모자란다).
- **감사 기록**: 세션이 확인된 쓰기는 `admin_actions`에 `campaign.<조작>`, `campaign:<id>`, 결과(`ok` / `stale` / `invalid` / `not_found` / `error`), IP, `detail`(사유·글자 수·`telegramSynced` 등)로 남는다. 메모와 초안 본문은 남기지 않는다. 세션이 없거나 CSRF가 틀린 요청은 기록 없이 401/403으로 끝난다(비인증 요청으로 테이블이 불어나지 않게).

## Threads 조작

Threads 글 상세(시트와 전체 페이지)의 `작업` 카드에서 Telegram 검수 메시지의 버튼과 답장이 하던 일을 한다. 글 목록 위의 `URL로 초안 만들기`는 `/add`를, 사이드바의 `만료 초안` 페이지는 `/revive`와 `/digest`를 대신한다.

| 상태 | 조작 | API |
|---|---|---|
| `PENDING_REVIEW` | `승인` (확인 창, 다음 빈 발행 시각) | `approve` |
| | 조각별 수정 (글자 수를 세고 한도를 넘으면 저장을 막는다) | `edit` |
| | 답글 조각 삭제 (2·3번, 확인 창, 뒤 조각은 번호가 당겨진다) | `deletePart` |
| | `재생성` (피드백은 선택) | `regenerate` |
| | `폐기` (사유 선택, 확인 창) | `reject` |
| `SCHEDULED` | `예약 취소` (검수 대기로 되돌림) | `unschedule` |
| | `지금 발행` (확인 창, 5분 주기의 발행 확인 때 나간다) | `publishNow` |
| `PUBLISHED` + 실패한 답글 | `답글 다시 시도` | `retryParts` |
| `EXPIRED` (뉴스, 살리거나 묶지 않음) | `♻️ 살리기` | `revive` |

**API** (`POST /api/posts/<id>/<조작>`, 본문은 `api-types.ts`의 `PostActionRequests`):

| 조작 | 본문 | 기준 |
|---|---|---|
| `approve` | `{ revision }` | `PENDING_REVIEW`이고 revision이 같을 때. `approvePost(id, { revision })` |
| `reject` | `{ revision, reason }` (`fact` / `boring` / `topic` / `dup` / `other`) | 위와 같다. `rejectPost`에 revision 조건을 붙였다 |
| `regenerate` | `{ revision, feedback? }` (피드백 1000자까지) | 위와 같다. `enqueueRegeneration`으로 큐에 넣는다 |
| `edit` | `{ revision, idx, text }` (`idx` 1~3, 1이 본 글) | 위와 같다. `applyReviewEdit(id, { revision }, …)`. `수정<idx>:` 답장과 같은 검사(500자, 마지막 답글은 CTA 자리) |
| `deletePart` | `{ revision, idx }` (`idx` 2~3) | 위와 같다. `삭제<idx>` 답장과 같다 |
| `unschedule` | `{ scheduledAt }` (ISO) | `SCHEDULED`이고 화면이 본 발행 시각이 같을 때 (`⏪` 버튼처럼 그 시각에 묶인다) |
| `publishNow` | `{ scheduledAt }` | 위와 같다. 시각만 지금으로 옮기고, 발행은 `publish-due`와 claim이 한다 |
| `retryParts` | `{}` | 발행된 글에 `FAILED` 답글이 있을 때 (`retryFailedParts`) |
| `revive` | `{}` | `EXPIRED` 뉴스 초안이고 살리거나 묶지 않았을 때. `revive` 작업을 큐에 넣는다 |

그 밖의 쓰기:

| 경로 | 설명 |
|---|---|
| `POST /api/posts/add` | 본문 `{ url, note? }` (http(s) 주소, 의견 500자까지). `/add`와 같은 `addTopicFromUrl`로 주제를 만들고 초안 작업을 넣는다. 200 `{ ok, topicId }`, 이미 다룬 기사면 409 `{ error, postId }` |
| `POST /api/revivable/check` | 만료 초안 판정(`revive-check`)을 큐에 넣는다. 202 `{ ok: true }`. 결과 목록은 Telegram으로 가고, 저장된 판정은 화면 목록에도 보인다 |
| `POST /api/digest` | 주간 묶음(`weekly-digest`)을 지금 만든다. 202 `{ ok: true }`. 묶음 글은 검수로 간다 |

- 응답과 충돌 처리는 체험단 조작과 같다: 200 `{ ok: true, telegramSynced, detail }`, 400, 404, **409 `{ error, stale: true }`**. 조작은 `src/pipeline/post-actions.ts`에 있고, Telegram 버튼·답장이 부르는 같은 조건부 함수(`approvePost`, `rejectPost`, `applyReviewEdit`, `unschedulePost`, `publishNow`, `retryFailedParts`)를 부른다. `applyReviewEdit`은 Telegram에서는 지금처럼 검수 메시지 id에, 웹에서는 화면이 본 revision에 묶인다.
- **LLM은 큐로만.** 재생성·살리기·판정·묶음은 큐에 넣고 바로 답한다. 화면은 재생성·살리기 뒤 3초마다 글을 다시 받아, `revision`이나 상태가 바뀌면 끝난 것으로 본다. 10분이 지나면 오래 걸린다고 알린다. 이 대기 표시는 브라우저에만 있어서 새로 고치면 사라진다. 판정 요청 뒤에는 3분 동안 5초마다 목록을 다시 받는다.
- **Telegram과 맞추기** (best effort, `telegramSynced`): `approve`는 검수 메시지 키보드를 지우고, 봇과 같은 `✅ 승인 · 발행 예정` 메시지를 `⏪ 예약 취소` / `🚀 지금 발행` 버튼과 함께 보낸다(`Reviewer.notifyApproved`). `reject`와 `regenerate`는 검수 메시지 키보드를 지우고 봇과 같은 문구를 보낸다(재생성 결과는 새 검수 메시지로 온다). `edit`·`deletePart`는 답장했을 때처럼 새 검수 메시지를 보낸다. `unschedule`은 안내와 새 검수 메시지를, `publishNow`·`retryParts`는 안내를 보낸다. `revive`는 작업이 검수 메시지를 보낸다. 웹에서 예약을 바꾸면 Telegram의 예전 `⏪`/`🚀` 버튼은 남지만, 시각이 달라져 누르면 `이미 처리된 예약이에요`로 끝난다. 메시지 문구는 봇과 같은 함수(`approvedText` 등)를 쓴다.
- 세션·같은 출처·`X-CSRF-Token` 검사와 16KB 본문 한도는 체험단 조작과 같다. 감사 기록은 `post.<조작>`(`post:<id>`), `post.add`, `revive.check`, `digest.build`이다. 본문·피드백·의견은 남기지 않고 글자 수, 조각 번호, 사유, 예약 시각만 남긴다.

## 인증 없이 열리는 경로

- `/healthz` 인증 없이 `ok`를 돌려준다. 헬스체크용이다.
- `/go/gift/<캠페인 ID>` (GET/HEAD) **인증 없이** 열리는 중계 페이지다. 선물하기 체험단은 카카오톡 앱 안의 브라우저에서 로그인된 상태로만 볼 수 있는데, 폰의 일반 브라우저나 Telegram 앱 브라우저는 카카오 로그인이 없고 Telegram 버튼은 http(s) 주소만 받는다. 그래서 Telegram 카드의 `📱 카카오톡에서 열기` 버튼이 이 https 페이지를 열고, 페이지가 `kakaotalk://inappbrowser?url=<인코딩된 https 주소>`로 넘긴다(자동 이동 + `카카오톡에서 열기` 큰 링크 + `웹 브라우저로 열기` 보조 링크, JavaScript 없음). 폰의 브라우저에는 대시보드 세션이 없으므로 인증을 걸 수 없다.
  - 받는 값은 소문자 16진수 24자(선물하기 캠페인 ID 형식)뿐이다. 그 밖의 값(`../`, 대문자, 길이가 다른 값, 하위 경로)은 404다. 쿼리 문자열은 무시한다.
  - 이동 대상은 서버가 검증한 ID로 만든 `https://gift.kakao.com/giftbox/trial-campaign/<ID>` 하나뿐이다. 요청에 담긴 주소로 보내는 일(open redirect)은 없다.
  - 응답에는 `Content-Security-Policy`(스크립트 불가), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`가 붙는다. 무신사용 중계는 없다(무신사 카드는 `link.musinsa.com`을 직접 연다).
  - 이 버튼은 `PUBLIC_BASE_URL`(https 주소, 경로 없이)이 있고 대시보드가 켜져 있을 때(Telegram 설정이 있을 때)만 쓰인다. 대시보드가 꺼져 있으면 중계 페이지가 없으므로 버튼은 같은 이름(`📱 카카오톡에서 열기`)의 직접 gift.kakao.com 링크로 돌아간다.

화면의 데이터는 60초마다 다시 받는다.

## 보안

- 데이터 조회 API는 GET/HEAD만 허용하고 나머지는 405를 돌려준다. 쓰기는 인증 API 다섯 개, 체험단 조작 여덟 개(`POST /api/campaigns/:id/<조작>`), Threads 조작 아홉 개(`POST /api/posts/:id/<조작>`)와 `POST /api/posts/add`, `/api/revivable/check`, `/api/digest`뿐이고, 모두 같은 출처 JSON + 세션 + CSRF 토큰을 요구한다.
- 코드와 세션 토큰은 sha256 해시로만 저장하고 `timingSafeEqual`로 비교한다. CSRF 토큰은 세션 토큰에서 파생해 따로 저장하지 않는다.
- 코드 요청과 확인은 DB advisory lock으로 순서를 맞춰, 동시에 들어온 요청이 한도나 1회 사용 규칙을 넘지 못한다.
- React가 모든 동적 텍스트를 이스케이프하고, `http(s)` URL만 링크로 만든다.
- 썸네일은 `https`이고 호스트가 `st.kakaocdn.net`, `t1.daumcdn.net`, `img1.kakaocdn.net`, `gift-s.kakaocdn.net`(선물하기), `image.msscdn.net`(무신사)인 URL만 그린다. CSP `img-src`도 같은 호스트만 허용한다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보낸다.

## 알려진 한계

- Threads 글의 permalink는 DB에 없어서 표시하지 않는다.
- 한도는 IP별이 아니라 전체 기준이다(사용자가 한 명). 누가 코드 요청을 계속 보내면 그동안 나도 코드를 못 받는다. 이때는 Telegram 알림을 보고 판단한다.
- 감사 기록(`admin_actions`)을 보는 화면은 아직 없다. DB에서 직접 본다.
- 수집 실행, 리마인더 확인 같은 운영 버튼은 아직 웹에 없다(roadmap.md 3절 4단계).
- Threads 글 목록은 최근 50개만 보여 준다. 더 오래된 글은 `/posts/<id>` 주소로 직접 연다.
