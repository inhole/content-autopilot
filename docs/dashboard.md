# 웹 대시보드

Telegram을 열지 않고도 폰이나 PC에서 파이프라인 상태, 체험단 진행, 최근 Threads 글과 성과를 보는 화면이다. 관리자 콘솔로 넓히는 중이다(roadmap.md 3절). 1단계(Telegram 1회용 코드 로그인), 2단계(체험단 조작), 3단계(Threads 글 검수·예약과 만료 초안), 4단계(운영: 작업 지금 실행, 설정·프로필 보기)와 영상(숏폼 목록·검수·발행, 직접 만든 영상 올리기)까지 있다.

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

화면 구성: 왼쪽 사이드바(데스크톱은 아이콘으로 접기, 모바일은 슬라이드)에 현황·체험단·Threads 글·만료 초안·성과·운영이 있고, 위쪽 헤더에 경로, 마지막 갱신 시각, 라이트/다크/시스템 테마 전환이 있다. 테마 선택은 브라우저 localStorage에 저장하고 기본은 시스템 설정을 따른다. 체험단 목록은 정렬(마감·경쟁률·점수)·검색·20건 단위 쪽 나누기를 지원하고, 행을 누르면 목록 위에 상세 시트가 열린다(`/campaigns/:id`로 바로 들어가면 전체 페이지). Threads 글 목록도 같은 방식으로 `/posts/:id` 상세 시트를 연다. 성과는 7/30/90일 영역 차트를 쓴다.

### 빌드와 서빙

- 로컬 빌드: `npm run build:web` (`web/`에서 `npm ci` 후 `vite build`, 결과는 `web/dist`). 루트 `npm run build`도 같은 일을 한다. 루트 패키지에는 의존성이 늘지 않는다.
- `web/dist/index.html`이 있으면 워커가 `web/dist`를 서빙한다. `/assets/*`는 해시 파일이라 `Cache-Control: public, max-age=31536000, immutable`, 그 밖의 파일과 `index.html`은 `no-store`다. `/api`가 아닌 나머지 GET 경로는 모두 `index.html`로 돌려준다 (SPA 라우팅). 확장자가 있는데 없는 파일과 없는 `/assets/*`는 404다.
- 빌드 폴더가 없으면 화면 경로는 503(`npm run build:web` 안내)을 돌려준다. API, `/healthz`, `/go/gift/<ID>`와 워커의 다른 일은 그대로 돈다. 빌드 여부는 요청마다 확인한다. 예전 서버 렌더링 페이지는 로그인 화면이 없어 지웠다.
- 빌드 폴더 위치는 기본 `<repo>/web/dist`이고, 환경 변수 `WEB_DIST_DIR`로 바꿀 수 있다.
- Railway는 배포 때 빌드 스크립트(`npm run build`)를 실행해야 한다. Railpack이 `build` 스크립트를 자동으로 돌리는지는 배포해서 확인해야 한다 (미검증). 돌리지 않으면 Settings에서 Build Command를 `npm run build`로 지정한다.
- 화면 파일(`index.html`, `/assets/*` 등)은 데이터가 없으므로 로그인 없이 내려준다. 앱이 `/api/auth/session`으로 세션을 확인하고 없으면 로그인 화면을 띄운다. `/api/*` 데이터는 세션이 있어야 하고 없으면 JSON 401이다. 경로에 `..`나 `%2e%2e`, 역슬래시, NUL이 있으면 400으로 막고 `web/dist` 밖의 파일은 읽지 않는다.
- CSP: React 앱 응답은 `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: <이미지 호스트>; media-src 'self' <SUPABASE_URL 출처> blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`이다. API와 그 밖의 응답은 `default-src 'none'; frame-ancestors 'none'`이다.

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
| `/api/ops` | 운영 화면: 작업 5개의 큐·일정(cron)·마지막 실행(상태, 시각, 실패 오류 300자)·`busy`, 파이프라인 설정(하루 초안 수, 발행 시각, 연결 글, dry-run, 체험단 하루 최대, 선별 방식, 시간대), 체험단 프로필(읽지 못하면 null). 비밀값은 담지 않는다 |
| `/api/videos?status=active\|all` | 숏폼 영상 목록. active는 진행 중(`UPLOADING`~`APPROVED`)이거나 최근 7일에 바뀐 영상. 행마다 출처(`post_id`, 직접 올림이면 null), 길이, 해상도, 발행 행 요약 |
| `/api/videos/<id>` | 영상 상세: 제목·캡션·해시태그·발행 캡션(`full_caption`), 원고(생성 영상), 파일 정보와 `video_url`, 발행 행(상태, 시각, 시도, `claim_seq`, 오류, 링크), 원본 글, 한도. 숫자가 아니거나 없는 id는 404 |
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

## 영상

사이드바의 `영상`은 숏폼 영상(Reels·Shorts)의 목록·상세와 직접 만든 영상 올리기다. 설계는 [plans/video-upload.md](plans/video-upload.md)다. 목록 행을 누르면 상세 시트가 열리고, `https` 저장소(Supabase)에 있는 파일은 미리보기가 나온다.

**올리기** (`/videos/new`): 파일(mp4·mov, 3초~3분, `VIDEO_UPLOAD_MAX_MB` 기본 50MB), 제목(필수, 100자), 캡션, 해시태그(5개), 출처 주소(선택), `올리면서 바로 승인`(기본 켬). 파일을 고르면 브라우저가 크기·방향·길이를 먼저 보고 경고한다.

1. `POST /api/videos` `{ title, caption, hashtags, sourceUrl?, originalName? }` → `videos` 행(`origin 'upload'`, `UPLOADING`). 200 `{ id, revision }`.
2. `POST /api/videos/<id>/file?approve=0|1`, 본문은 파일 자체(`Content-Type: video/mp4` 또는 `video/quicktime`, `Content-Length` 필수, 세션·같은 출처·`X-CSRF-Token`). 서버가 임시 폴더로 받아 ffprobe로 Reels·Shorts 규격(H.264/HEVC 4:2:0, 세로, 가로 1920px 이하, 23~60fps, 25Mbps, AAC 48kHz·128kbps·2채널)을 검사하고, 다시 인코딩하지 않고 MP4로 다시 묶어(faststart, edit list 없음) 저장한다. 200 `{ approval, telegramSynced, detail }`(`approval`은 같은 요청에서 한 승인의 결과, 실패해도 파일은 들어가 검수 대기로 남는다), 400 규칙 위반(행은 `UPLOADING`에 남아 다른 파일을 다시 보낼 수 있다), 409 이미 파일이 있거나 만료(`status` 포함), 411/413/415, 429 다른 업로드 처리 중(한 번에 하나).
3. 화면은 XHR 진행률을 보여 주고, 연결이 끊기면 행을 다시 읽어 `UPLOADING`이면 같은 행으로 다시 보내고, 검수 대기·승인이면 완료로, 만료면 새 행으로 시작한다. 파일이 오지 않은 `UPLOADING` 행은 마지막 시도부터 1시간 뒤 만료된다.

**상세의 조작** (화면이 본 `revision`·시도·예약 시각에 묶인다. 맞지 않으면 409 `{ error, stale: true }`):

| 상태 | 조작 | API |
|---|---|---|
| `PENDING_REVIEW` | `승인`(다음 빈 영상 슬롯), `폐기`, `다시 만들기`(생성 영상만, 피드백 선택), 제목·캡션·해시태그 저장(한 번에, revision 한 번) | `POST /api/videos/<id>/<approve\|reject\|rescript\|edit>` `{ revision, … }` |
| `APPROVED` | `승인 취소`(발행 행이 모두 한 번도 시도되지 않았을 때만), `직접 올림 완료`(발행 행이 없을 때) | `unapprove`, `manualDone` `{ revision }` |
| `UPLOADING` | 파일 다시 올리기 | `POST /api/videos/<id>/file` |
| 발행 행 `SCHEDULED` | `지금 발행`(그 예약 시각일 때만, 5분 주기 확인 때 나간다) | `POST /api/publications/<id>/publishNow` `{ scheduledAt }` |
| 발행 행 `FAILED` | `다시 시도`(다음 빈 슬롯), `중단`(`CANCELLED`; 발행 행이 모두 끝나면 하나라도 나갔으면 영상 `PUBLISHED`, 아니면 `FAILED`) | `retry`, `cancel` `{ claimSeq, confirmedNotOnChannel? }` |

- 결과를 모르는 Shorts 실패(업로드 세션 만료)는 "채널에 올라가지 않은 것을 확인했어요"를 체크해야 다시 시도·중단할 수 있다(`confirmedNotOnChannel`, 없으면 400 `{ confirm: true }`). Telegram 실패 알림의 버튼도 같은 시도(`claim_seq`)에 묶인다.
- Telegram과 맞추기(최선 노력, `telegramSynced`): 승인은 검수 버튼을 지우고 봇과 같은 승인 안내(자동 플랫폼이 없으면 직접 올리기 안내)를 보낸다. 폐기·다시 만들기는 버튼을 지우고 알린다. 수정과 승인 취소는 새 검수 메시지를 보낸다. 다시 시도·중단·직접 올림은 알린다.
- 감사 기록은 `video.create`, `video.file`(크기, 결과, 거절 사유), `video.<조작>`(`video:<id>`), `publication.<조작>`(`publication:<id>`)이다. 제목·캡션·피드백 원문은 남기지 않는다.

## 운영

사이드바 `운영` 페이지(`/ops`)에서 정해진 시각에 도는 작업을 지금 한 번 돌리고, 수집 일정·발행 시각·하루 수량과 체험단 프로필을 고친다. 그 밖의 설정(연결 글, dry-run, 선별 방식, 시간대)은 읽기 전용이다(`.env`를 고쳐 재배포한다). 편집은 아래 「일정과 수량 편집」, 「체험단 프로필 편집」을 본다.

| 작업 (`<name>`) | 큐 | 일정 | 하는 일 |
|---|---|---|---|
| `threads-daily` | `daily-pipeline` | `COLLECT_CRON` | 뉴스 수집 → 선별 → 초안 생성(LLM 호출, 초안은 Telegram 검수로 간다) |
| `gift-collect` | `gift-collect` | `GIFT_COLLECT_CRON` | 카카오톡 선물하기 체험단 수집·선별·카드 |
| `musinsa-collect` | `musinsa-collect` | `MUSINSA_COLLECT_CRON` | 무신사 체험단 수집·선별·카드 |
| `campaign-maintenance` | `campaign-maintenance` | 매시 정각 | 신청 마감 지난 카드 만료, 리마인더(09~21시에만 보낸다) |
| `collect-insights` | `collect-insights` | 매일 5시 | Threads 성과 스냅샷 |

- `POST /api/ops/<name>/run` (본문 `{}`): 큐에 `boss.send`로 작업 하나를 넣는다. 202 `{ ok: true, queued: true }`. 그 큐에 대기·재시도·실행 중인 작업이 있으면 보내지 않고 200 `{ ok: true, queued: false }`이고, 큐 정책(`stately`/`singleton`)이 중복을 버린 경우도 같다. `singleton`은 실행 중인 작업만 하나로 막으므로, 확인과 전송을 큐별 advisory lock(`ops-run:<큐>`)으로 묶어 동시에 누른 요청이 작업을 두 번 넣지 못하게 한다. 모르는 이름은 404, 본문이 객체가 아니면 400, GET은 405다. 세션·같은 출처·`X-CSRF-Token` 검사는 다른 쓰기와 같고, 감사 기록은 `ops.<name>`(`detail: { queued }`)이다.
- 작업 상태는 pg-boss 테이블 `pgboss.job`을 직접 읽는다. 큐마다 가장 최근 작업(`created_on` 기준)의 상태와 시각, 실패하면 `output->>'message'`(스택은 읽지 않는다)를 보여 준다. `pgboss` 스키마가 아직 없으면 실행 기록이 없는 것으로 본다.
- 일정 문자열은 작업을 등록하는 코드와 같은 상수(`HOURLY_CRON`, `INSIGHTS_CRON`, `MAINTENANCE_CRON`, `config`의 cron)를 읽으므로 화면과 실제 일정이 어긋나지 않는다. 화면은 단순한 cron을 `매일 9·15·21시`처럼 풀어 쓰고, 그 밖의 식은 그대로 보여 준다.
- 화면은 실행 확인 창(Threads 수집은 LLM 호출과 초안 생성을 경고)을 거친다. 실행 중인 작업이 있으면 3초마다(최대 5분) 다시 읽고, 아니면 60초마다 읽는다.

### 일정과 수량 편집

`일정과 수량` 카드의 `편집`으로 아래 여섯 값을 고친다(마이그레이션 `023`). 저장한 값은 DB의 한 행짜리 테이블 `runtime_settings`에 들어가고, 있으면 환경변수보다 우선한다. 쓰는 곳이 부를 때마다 이 행을 다시 읽으므로 재배포나 재시작이 필요 없다.

| 값 | 환경변수(기본값) | 반영 시점 |
|---|---|---|
| Threads 뉴스 수집 일정 | `COLLECT_CRON` | 저장 즉시 pg-boss 일정을 다시 등록 |
| 카카오톡 선물하기 수집 일정 | `GIFT_COLLECT_CRON` | 저장 즉시 다시 등록 |
| 무신사 수집 일정 | `MUSINSA_COLLECT_CRON` | 저장 즉시 다시 등록 |
| 하루 초안 수 (1~10) | `DAILY_POST_COUNT` | 다음 Threads 수집부터 |
| 발행 시각 (`HH:MM`, 1~10개) | `PUBLISH_SLOTS` | 다음 승인부터(이미 예약된 글은 시각이 그대로다) |
| 체험단 하루 카드 수 (출처별, 1~20) | `CAMPAIGN_DAILY_MAX` | 다음 선별부터 |

- 수집 일정은 "매일, 고른 시각들의 몇 분"만 고를 수 있다(cron `<분> <시,시> * * *`). 화면은 0~23시 칸에서 시각을 여러 개 고르고 분을 넣는다. 환경변수 cron이 이보다 복잡하면 화면에 그대로 보여 주고, 저장하면 고른 일정으로 바뀐다.
- 카드에 출처가 `페이지에서 수정함` 또는 `기본값(환경변수)`로 보이고, 값이 기본값과 다르면 기본값을 함께 보여 준다. 발행 시각이 하루 초안 수보다 적으면 안내만 한다(남는 글은 다음 날 시각으로 넘어간다).
- `POST /api/ops/schedule` `{ revision, schedule }`, `POST /api/ops/schedule/reset` `{ revision }`: 프로필 편집과 같은 방식이다. 화면이 본 `revision`에서만 바뀌고(편집 폼은 열 때의, 되돌리기는 확인 창을 열 때의 `revision`을 보낸다), 되돌려도 `revision`은 계속 오른다. 409 stale, 400 `{ error, fields }`(`giftCollect.hours`, `publishSlots.2` 같은 경로). 시각과 발행 시각은 중복을 빼고 정렬하며, `8:00`은 `08:00`으로 맞춘다.
- 일정 등록(`applySchedules`, `src/schedules.ts`)은 advisory lock(`ops-schedule`) 안에서 그 순간 DB에 있는 값을 읽어 `boss.schedule`로 등록한다. 그래서 두 저장이 겹쳐도 마지막에 저장한 값이 등록된다. pg-boss 일정은 DB에 있어 한 번 등록하면 모든 인스턴스에 적용되고, 워커가 시작할 때도 같은 함수로 저장된 값을 등록한다(재시작해도 환경변수로 돌아가지 않는다). 저장은 됐는데 등록이 실패하면 로그를 남기고 `applied: false`로 답하며, 화면은 다음 워커 시작 때 적용된다고 알린다.
- 저장된 값이 스키마에 맞지 않으면 오류 로그를 남기고 환경변수를 쓴다(그 행의 `revision`으로 다시 저장할 수 있다).
- 감사 기록은 `ops.schedule`, `ops.schedule.reset`이고 `detail`은 `{ revision, applied }`다.

### 체험단 프로필 편집

프로필 카드의 `편집`으로 관심사, 선호·제외 키워드, 제외 브랜드, 최대 경쟁률, 최소 정가, 리뷰 말투·글자 수·포인트, 협찬 문구를 고친다(마이그레이션 `021`). 저장한 사본은 DB의 한 행짜리 테이블 `campaign_profile`에 들어가고, 있으면 `config/campaign-profile.json`보다 우선한다. 선별과 리뷰 초안은 프로필을 부를 때마다 이 행을 다시 읽으므로, 저장하면 재배포나 재시작 없이 다음 수집·선별과 리뷰 초안부터 반영된다. 이미 나간 카드와 초안은 바뀌지 않는다.

- 카드에 출처가 `페이지에서 수정함`(DB 사본) 또는 `기본 파일`로 보인다. 목록 칸은 한 줄에 하나씩 쓰고, 최대 경쟁률·최소 정가는 비우면 제한 없음, 협찬 문구는 비우면 없음이다.
- `POST /api/ops/profile` `{ revision, profile }`: 화면이 본 `revision`에서만 저장한다(한 번도 저장하지 않았으면 0, 저장하거나 되돌릴 때마다 1씩 오르고 줄지 않는다. 그래서 옛 화면이 되돌린 뒤 새로 저장한 사본을 덮어쓰지 못한다). 편집 폼은 열 때의 `revision`을 보내므로, 편집하는 사이 다른 곳에서 저장했으면 덮어쓰지 않고 409 `{ error, stale: true }`가 되고 화면이 다시 읽는다. 문자열과 목록 항목은 앞뒤 공백을 떼고, 빈 항목과 중복은 버린다. 한도는 소개 500자, 말투·협찬 문구 200자, 목록마다 50개·항목 50자, 최대 경쟁률은 0보다 큰 수, 최소 정가는 양의 정수, 최소 글자 수 10 이상, 최대 글자 수 50~4000, 최소 < 최대다. 최대 글자 수에서 협찬 문구와 빈 줄(`disclosureReserve`, 리뷰 초안이 쓰는 계산과 같다)을 빼고도 본문 10자가 들어가야 한다. 어긋나면 400 `{ error, fields }`(`review.maxChars`, `interests.3` 같은 경로)이고 화면은 해당 칸 아래에 표시한다.
- `POST /api/ops/profile/reset` `{ revision }`: 저장한 사본을 비워(행은 남고 `profile`만 null) 파일 기본값으로 되돌린다(확인 창을 거친다). 한 번도 저장하지 않았고 `revision`이 0이면 비울 것이 없어 성공이다. 요청 본문은 64KB까지 받는다(한도까지 채운 프로필이 약 40KB).
- 저장된 사본이 스키마에 맞지 않으면(손으로 고친 경우 등) 오류 로그를 남기고 파일을 쓴다. 이때 출처는 `기본 파일`이지만 `revision`은 그 행의 번호여서, 화면에서 다시 저장하면 사본을 고칠 수 있다.
- 감사 기록은 `ops.profile`, `ops.profile.reset`이고 `detail`에는 `revision`만 남긴다(프로필 내용은 남기지 않는다).

## 인증 없이 열리는 경로

- `/healthz` 인증 없이 `ok`를 돌려준다. 헬스체크용이다.
- `/go/gift/<캠페인 ID>` (GET/HEAD) **인증 없이** 열리는 중계 페이지다. 선물하기 체험단은 카카오톡 앱 안의 브라우저에서 로그인된 상태로만 볼 수 있는데, 폰의 일반 브라우저나 Telegram 앱 브라우저는 카카오 로그인이 없고 Telegram 버튼은 http(s) 주소만 받는다. 그래서 Telegram 카드의 `📱 카카오톡에서 열기` 버튼이 이 https 페이지를 열고, 페이지가 `kakaotalk://inappbrowser?url=<인코딩된 https 주소>`로 넘긴다(자동 이동 + `카카오톡에서 열기` 큰 링크 + `웹 브라우저로 열기` 보조 링크, JavaScript 없음). 폰의 브라우저에는 대시보드 세션이 없으므로 인증을 걸 수 없다.
  - 받는 값은 소문자 16진수 24자(선물하기 캠페인 ID 형식)뿐이다. 그 밖의 값(`../`, 대문자, 길이가 다른 값, 하위 경로)은 404다. 쿼리 문자열은 무시한다.
  - 이동 대상은 서버가 검증한 ID로 만든 `https://gift.kakao.com/giftbox/trial-campaign/<ID>` 하나뿐이다. 요청에 담긴 주소로 보내는 일(open redirect)은 없다.
  - 응답에는 `Content-Security-Policy`(스크립트 불가), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store`가 붙는다. 무신사용 중계는 없다(무신사 카드는 `link.musinsa.com`을 직접 연다).
  - 이 버튼은 `PUBLIC_BASE_URL`(https 주소, 경로 없이)이 있고 대시보드가 켜져 있을 때(Telegram 설정이 있을 때)만 쓰인다. 대시보드가 꺼져 있으면 중계 페이지가 없으므로 버튼은 같은 이름(`📱 카카오톡에서 열기`)의 직접 gift.kakao.com 링크로 돌아간다.

화면의 데이터는 60초마다 다시 받는다.

## 보안

- 데이터 조회 API는 GET/HEAD만 허용하고 나머지는 405를 돌려준다. 쓰기는 인증 API 다섯 개, 체험단 조작 여덟 개(`POST /api/campaigns/:id/<조작>`), Threads 조작 아홉 개(`POST /api/posts/:id/<조작>`)와 `POST /api/posts/add`, `/api/revivable/check`, `/api/digest`, 운영 작업 실행(`POST /api/ops/<name>/run`), 프로필 저장·되돌리기(`POST /api/ops/profile`, `/api/ops/profile/reset`), 일정·수량 저장·되돌리기(`POST /api/ops/schedule`, `/api/ops/schedule/reset`), 영상 조작(`POST /api/videos`, `/api/videos/:id/<조작>`, `/api/publications/:id/<조작>`)뿐이고, 모두 같은 출처 JSON + 세션 + CSRF 토큰을 요구한다. 예외인 영상 파일(`POST /api/videos/:id/file`)은 JSON 대신 `video/mp4`·`video/quicktime` 본문이고 나머지 검사는 같다. 형식·크기·세션·CSRF는 본문을 읽기 전에 확인하고, 거절한 본문은 읽지 않고 연결을 닫는다.
- 코드와 세션 토큰은 sha256 해시로만 저장하고 `timingSafeEqual`로 비교한다. CSRF 토큰은 세션 토큰에서 파생해 따로 저장하지 않는다.
- 코드 요청과 확인은 DB advisory lock으로 순서를 맞춰, 동시에 들어온 요청이 한도나 1회 사용 규칙을 넘지 못한다.
- React가 모든 동적 텍스트를 이스케이프하고, `http(s)` URL만 링크로 만든다.
- 영상 미리보기는 `https` 주소일 때만 그리고, CSP `media-src`는 이 서버와 `SUPABASE_URL`의 출처, 그리고 올리기 전에 브라우저가 고른 파일의 길이·해상도를 읽는 `blob:`만 허용한다.
- 썸네일은 `https`이고 호스트가 `st.kakaocdn.net`, `t1.daumcdn.net`, `img1.kakaocdn.net`, `gift-s.kakaocdn.net`(선물하기), `image.msscdn.net`(무신사)인 URL만 그린다. CSP `img-src`도 같은 호스트만 허용한다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보낸다.

## 알려진 한계

- Threads 글의 permalink는 DB에 없어서 표시하지 않는다.
- 한도는 IP별이 아니라 전체 기준이다(사용자가 한 명). 누가 코드 요청을 계속 보내면 그동안 나도 코드를 못 받는다. 이때는 Telegram 알림을 보고 판단한다.
- 감사 기록(`admin_actions`)을 보는 화면은 아직 없다. DB에서 직접 본다.
- 체험단 프로필과 설정은 웹에서 고칠 수 없다(파일과 환경 변수를 고쳐 재배포한다).
- Threads 글 목록은 최근 50개만 보여 준다. 더 오래된 글은 `/posts/<id>` 주소로 직접 연다.
