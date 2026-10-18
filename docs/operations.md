# 운영

## 매일 할 일

Telegram으로 오는 초안을 확인한다. 하루 기본 3개다.

| 동작 | 결과 |
|---|---|
| ✅ 승인 | 다음 빈 발행 시간(08:00 / 12:30 / 21:00 KST)에 예약된다 |
| 🔁 재생성 | 같은 주제로 초안을 새로 쓴다 |
| 🗑 폐기 | 사유 버튼(사실 오류 / 재미없음 / 주제 별로 / 중복 / 기타)이 뜨고, 고르면 폐기된다. ↩ 취소로 되돌릴 수 있다. 최근 30일 동안 같은 사유가 2건 이상 쌓이면 다음 초안 지침에 반영된다. CLI `reject`는 사유 없이 폐기한다. |
| 초안에 `수정: <본문>` 답장 | 본문을 그대로 교체하고 다시 검수 메시지를 보낸다 |
| 초안에 다른 내용으로 답장 | 그 내용을 피드백으로 반영해 재생성한다 (연결 글이면 전체를 다시 쓴다) |
| 연결 글에 `수정2: <본문>` (또는 `수정3:`) 답장 | 해당 답글 조각을 그대로 교체한다. `수정1:`은 `수정:`과 같이 본글을 바꾼다. |
| 연결 글에 `삭제2` (또는 `삭제3`) 답장 | 해당 답글 조각을 지운다. 남은 조각은 번호를 다시 매긴다. |
| 승인 메시지의 ⏪ 예약 취소 | 예약을 풀고 검수 대기로 되돌린다. 새 검수 메시지가 온다. |
| 승인 메시지의 🚀 지금 발행 | 발행 시각을 지금으로 당긴다. 다음 발행 확인 주기(5분 이내)에 나간다. |

**연결 글:** `THREAD_CHAIN_ENABLED=true`이면 LLM이 답글을 0~2개 붙인다. 검수 메시지 하나에 `[1/3]`, `[2/3]`, `[3/3]`이 글자 수와 함께 보인다. 본문이든 조각이든 바뀔 때마다 `revision`이 올라가서 이전 메시지의 버튼은 무효가 된다. 승인하면 본글이 예약 시간에 나가고, 그 직후 `publish-chain`이 답글을 순서대로 올린다. 출처 링크는 마지막 답글(답글이 없으면 본글)에 붙고, `THREAD_CTA_TEXT`가 있으면 마지막 답글 끝에 붙는다. 이 CTA는 글이 하나뿐일 때는 붙지 않는다. 연결 글 내용은 `npm run cli -- show <postId>`로 볼 수 있다.

**답글 조각 발행이 실패했을 때:** 조각마다 3번까지 시도한다. 그래도 실패하면 ❌ 알림과 「🔁 답글 다시 시도」 버튼(`chainretry:<postId>`)이 온다. 누르면 `FAILED` 조각이 `PENDING`으로 돌아가고, 다음 `publish-due` 확인(5분 이내)이 이어서 올린다. 본글은 그대로 남는다. `/status`에는 실패한 조각 수가 `연결 글 답글 실패: N건`으로, 발행된 글에서 30분 넘게 진행이 없는 조각 수가 `연결 글 답글 멈춤: N건`으로 보인다. 멈춘 조각은 `publish-due`가 5분마다 다시 찾아 이어서 올린다.

**답글 알림:** `poll-replies`는 본글과 이미 발행된 답글 조각에 달린 답글을 모두 읽는다. 연결 글이면 알림 첫 줄에 `글 #12 [2/3]`처럼 어느 글에 달린 답글인지 나온다. 알림에 답장하면 그 독자의 답글에 바로 답글이 달린다.

**알려진 한계:** insights는 본글만 수집한다.

**Threads 답글 알림:** 발행한 글에 달린 새 답글은 5분 안에 `💬 @user 답글 · 글 #12 "첫 줄…"` 메시지로 온다. 이 메시지에 답장하면 그 내용이 그대로 Threads 답글로 달리고 `✅ 답글을 달았어요`가 온다. 답글 하나에는 한 번만 달 수 있고, 500자를 넘으면 거절한다. 실패하면 ❌ 메시지가 오고 같은 알림에 다시 답장하면 된다. 발행 후 48시간이 지난 글의 답글은 확인하지 않는다.

두 버튼은 버튼이 만들어진 그 예약에만 동작한다. 이미 발행됐거나 다시 승인해서 시간이 바뀌었으면 "이미 처리된 예약이에요"라고 답한다.

**검수를 놓쳤을 때:** 48시간 동안 손대지 않은 초안은 `EXPIRED`로 만료되고 ⌛ 알림이 온다(매시 정각 확인). 09:00과 18:00에 검수 대기가 있으면 📝 리마인더가 온다.

발행이 끝나면 🚀 메시지가 온다. 발행이 3번 실패하면 ❌ 메시지가 온다. 일일 파이프라인, 초안 생성, 검수 전송 job이 재시도를 모두 소진해도 ❌ 메시지가 온다. 수집이 실패하거나 토큰 갱신이 실패하면 ⚠️ 메시지가 온다.

### Telegram 명령

| 명령 | 하는 일 |
|---|---|
| `/status` | (체험단 단계별 개수와 로컬 워커의 마지막 heartbeat도 같이 보인다.) 검수 대기, 발행 예정, 최근 24시간 발행 수, 실패한 글, 최근 7일 만료 수, 실패하거나 멈춘 연결 글 답글 수(있을 때만), 토큰 만료일, 마지막 수집 실행 결과, 이번 달 LLM 비용(OpenRouter)을 보여준다 |
| `/help` | 명령과 답장 규칙을 보여준다. 입력창에 `/`를 치면 명령 메뉴도 뜬다. |
| `/add <url> [한 줄 의견]` | 직접 고른 기사로 초안을 만든다. 의견을 붙이면 그 의견을 글의 관점으로 삼는다. 의견은 관점일 뿐이고, 사실은 기사 본문에서만 가져온다. 이미 다룬 기사면 알려주기만 하고 새로 만들지 않는다. |
| `/report` | 최근 7일 성과 리포트(발행 수, 조회·좋아요·답글·리포스트 합계와 평균, 답글률, 답글 많은 글 3개, 조회 가장 적은 글, 연결 글과 단일 글의 평균 조회·답글 비교)를 보여준다. 매주 월요일 09:00에도 자동으로 온다. |
| `/camp <레뷰 링크>` | 체험단 공고를 직접 추가한다. 이미 있는 공고면 상태만 알려준다. |
| `/camps` | 진행 중인 체험단을 마감순으로 보여준다. |
| `/posted <id> <블로그 주소>` | 임시저장한 후기를 발행했다고 기록한다 (`POSTED`) |
| `/start` | chat id를 알려준다 (처음 설정할 때) |

## CLI

```bash
npm run cli                          # 명령 목록
npm run cli -- collect               # RSS만 수집
npm run cli -- daily                 # 수집 → 선정(중복 판정) → 초안 생성을 지금 바로 실행 (큐 없이)
npm run cli -- add-topic "제목" [url] [의견] # 직접 고른 주제로 초안 생성 (/add와 같음)
npm run cli -- list [status]         # 최근 글 목록 (예: list scheduled)
npm run cli -- show <postId>         # 초안 보기
npm run cli -- review [postId]       # 초안을 Telegram으로 (다시) 보내기. id가 없으면 검수 대기 전부
npm run cli -- approve <postId>      # 승인 (다음 발행 시간 배정)
npm run cli -- reject <postId>
npm run cli -- publish-now <postId>  # 즉시 발행 (FAILED 글 재시도에도 사용). 연결 글이면 답글까지 올리고, 본 글이 이미 올라간 글은 남은 답글만 이어서 올린다(FAILED 답글도 다시 시도)
npm run cli -- threads:check         # 토큰 확인
npm run cli -- threads:refresh       # 토큰 수동 갱신
npm run cli -- insights              # 발행 글의 성과를 지금 수집하고 글별 최신 숫자 출력
npm run cli -- report                # 주간 리포트 본문 출력 (/report와 같음)
npm run cli -- replies               # 새 Threads 답글을 지금 확인하고 Telegram으로 알림
```

체험단 명령은 [아래](#체험단-cli)에 있다.

CLI는 Telegram 봇을 polling하지 않는다. 그래서 워커가 실행 중일 때 같이 써도 된다.

## 설정 바꾸기

| env | 기본값 | 설명 |
|---|---|---|
| `DAILY_POST_COUNT` | `3` | 하루에 만들 초안 수 |
| `PUBLISH_SLOTS` | `08:00,12:30,21:00` | 발행 시간 (`TZ_NAME` 기준) |
| `COLLECT_CRON` | `0 6 * * *` | 수집 시각 |
| `TZ_NAME` | `Asia/Seoul` | |
| `THREAD_CHAIN_ENABLED` | `false` | 켜면 생성 단계에서 답글 조각을 만든다. 이미 조각이 있는 글은 이 값과 관계없이 연결 글로 발행한다. 2~3주 꺼서 기준선을 만든 뒤 켜서 비교한다. |
| `THREAD_CTA_TEXT` | 없음 | 마지막 답글 끝에 코드가 붙이는 고정 문구. `\n`은 줄바꿈이다. 500자에 맞지 않으면 발행할 때 뺀다. 글이 하나뿐이면 붙이지 않는다. 참여 유도로 보일 수 있어서 도달이 줄면 비운다(결정 8). |

스케줄은 워커가 시작할 때 다시 등록된다. 바꾼 뒤에는 워커를 재시작한다.

RSS 피드는 `sources` 테이블로 관리한다.

```sql
insert into sources (kind, name, url) values ('RSS', '이름', 'https://.../feed.xml');
update sources set enabled = false where name = '이름';   -- 끄기
```

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| `ENOTFOUND db.*.supabase.co` | Direct 주소를 쓰고 있다. Session pooler 주소로 바꾼다. ([setup.md](setup.md#1-supabase)) |
| HN 피드 `Status code 429` | 짧은 시간에 여러 번 요청해서 그렇다. 하루 한 번 수집에서는 보통 생기지 않는다. |
| 초안이 0개 | `npm run cli -- list`로 확인한다. topics가 모두 `DUPLICATE`나 `SKIPPED`면 `score_reason`과 `duplicate_of`를 보고 순위 프롬프트(`src/pipeline/prompts.ts`)를 조정한다. |
| 글이 `FAILED` | `select id, last_error from posts where status = 'FAILED'`로 원인을 보고, 고친 뒤 `publish-now <id>`로 다시 시도한다. |
| 본글만 올라가고 답글이 안 올라간다 | `select post_id, idx, status, attempts, last_error from post_parts where status <> 'PUBLISHED'`로 원인을 본다. `FAILED`면 Telegram 알림의 「🔁 답글 다시 시도」를 누른다. `PENDING`이나 `PUBLISHING`이면 5분 안에 `publish-due`가 이어서 올린다. 계속 멈춰 있으면 워커 로그의 `[publish-chain]`을 확인한다. |
| 답글 알림이 안 온다 / 로그에 `[replies] post #N failed` | 토큰에 `threads_read_replies`, `threads_manage_replies` 권한이 있어야 한다. 권한을 추가했다면 [setup.md](setup.md)대로 토큰을 다시 발급한다. `THREADS_DRY_RUN=true`이거나 `dry-` 글이면 답글을 확인하지 않는다. `npm run cli -- replies`로 바로 확인해 볼 수 있다. |
| 답글 달기가 `❌ 답글을 달지 못했어요` | 메시지에 이유가 나온다. 권한 부족이면 위 항목, 이미 달았으면 한 번만 가능하다는 뜻이다. |
| 토큰 만료 | [setup.md 4-3](setup.md#4-3-장기-토큰-발급-처음-한-번)대로 다시 발급한다. 그다음 `delete from platform_accounts where platform='THREADS'`로 지우고 워커를 재시작하면 env의 새 토큰을 다시 읽는다. |

job 상태는 `pgboss.job` 테이블에서 볼 수 있다.

```sql
select name, state, retry_count, output, created_on from pgboss.job order by created_on desc limit 20;
```

## 배포 (Railway)

워커는 HTTP 포트 없이 계속 실행되는 프로세스 하나다. Railway 서비스 하나로 충분하다. GitHub `main`에 push하면 자동으로 다시 배포된다.

### 빌드 동작
- Railway(Railpack)는 `package.json`의 `engines.node`(`>=24.2`)로 Node 버전을 고르고, `npm start`로 실행한다. 별도 빌드 단계는 없다.
- `tsx`는 실행에 필요하므로 `dependencies`에 둔다. devDependencies를 정리(prune)하는 설정을 켜도 깨지지 않게 하기 위해서다.
- `prepare`의 hook 설정은 git 저장소가 아니면 건너뛴다.

### 처음 배포
1. https://railway.com 에서 GitHub 계정으로 가입한다. Hobby 플랜은 월 $5이고 $5 사용량이 포함된다. 이 워커는 그 안에서 돈다.
2. **New Project → Deploy from GitHub repo**를 고르고, `inhole/content-autopilot`을 선택한다 (GitHub 앱 권한 허용).
3. 첫 배포는 환경변수가 없어서 실패한다. 정상이다.
4. 서비스 → **Variables → Raw Editor**에 로컬 `.env` 내용을 붙여넣고 저장한다.
   - `DATABASE_URL`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `THREADS_DRY_RUN`, (발급 후) `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN`
5. **Deployments**에서 다시 배포한다. 로그에 다음 두 줄이 보이면 성공이다.
   ```
   [worker] started · collect "0 6 * * *" Asia/Seoul · ...
   [telegram] @<봇이름> polling
   ```
6. **Settings**에서 확인한다.
   - Replicas: **1**
   - Serverless(App Sleeping): **끔** (켜져 있으면 06:00 수집과 Telegram 응답이 멈춘다)
   - Restart Policy: On Failure (기본값)

### 주의
- **Telegram polling은 한 곳에서만 한다.** 로컬에서 `npm start`를 켜 둔 채로 Railway 워커가 뜨면 두 워커가 polling을 놓고 충돌한다 (`409 Conflict`). 중복 발행은 일어나지 않지만 버튼 응답이 불안정해진다. 로컬에서는 CLI만 쓴다. 예외는 체험단용 `WORKER_ROLE=local` 워커 하나뿐이며, 이 워커는 polling을 하지 않는다. Railway의 cloud 워커를 둘 이상 띄우지 않는다.
- 체험단 기능을 켤 때는 **cloud를 먼저 배포한다.** cloud가 마이그레이션 `014`를 적용한다. local은 마이그레이션을 하지 않는다.
- 워커는 시작할 때 migration을 자동으로 적용한다.
- 환경변수를 바꾸면 Railway가 자동으로 재배포한다.
- 웹 대시보드는 `DASHBOARD_PASSWORD`를 넣고 Networking에서 도메인을 만들면 켜진다. 자세한 내용은 [dashboard.md](dashboard.md)에 있다.

### CI 통과 후에만 배포 (Wait for CI)
GitHub Actions(`.github/workflows/ci.yml`)는 main에 push하거나 PR을 올리면 실행된다.
- `check` job: typecheck, lint, 단위 테스트
- `integration` job: pgvector Postgres 컨테이너에서 DB 시나리오 테스트

Railway 서비스 Settings에서 **Wait for CI**를 켜면, CI가 통과한 커밋만 배포된다. 원하면 GitHub Settings → Branches에서 main 보호 규칙을 만들고 `check`, `integration`을 필수로 지정한다.

### 로컬에서 통합 테스트
```bash
docker run -d --name ca-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres DATABASE_SSL=false npm run test:integration
```
통합 테스트는 테이블을 비우기 때문에 `DATABASE_URL` 호스트가 localhost/127.0.0.1/postgres가 아니면 실행을 거부한다(`test/integration/setup.ts`). 운영 DB에는 절대 돌지 않는다.

## 체험단 로컬 워커

카톡 읽기, 레뷰 신청, 블로그 임시저장은 이 PC에서만 된다. 준비물은 [setup.md 5절](setup.md#5-체험단-aside--카카오톡-pc)이다.

### 실행

```bash
# .env에 WORKER_ROLE=local
npm start
```

- 시작 로그에 `[worker] started`가 보이면 된다. Telegram polling 로그(`[telegram] @… polling`)는 **나오지 않는 것이 정상**이다.
- **PC가 켜져 있고 화면이 잠기지 않아야 한다.** 잠기면 `read-room.ps1`이 종료 코드 2로 끝나 카톡을 읽지 못한다. Aside도 잠긴 화면에서는 동작하지 않는다. 꺼져 있는 동안의 로컬 job은 대기하다가 켜지면 처리된다.
- 로그인할 때 자동으로 시작하려면 Windows **작업 스케줄러**에 작업을 만든다.
  - 트리거: 로그온할 때. 사용자: 본인 계정 (카톡과 Aside 창이 있는 데스크톱 세션이어야 해서 "로그온 여부와 관계없이 실행"은 쓰지 않는다).
  - 동작: 프로그램 `cmd.exe`, 인수 `/c npm start`, 시작 위치 이 레포 경로.
  - 절전을 끄거나, 최소한 사용하는 시간 동안 깨어 있게 한다.
- 이 PC에서 `npm start`가 두 개 뜨지 않게 한다.

### 체험단 CLI

```bash
npm run cli -- campaign:collect        # 카톡을 지금 읽어 새 링크를 등록한다 (local 역할 PC에서)
npm run cli -- campaign:add <url>      # 링크를 직접 추가 (/camp와 같음)
npm run cli -- campaign:fetch <id>     # 상세 페이지를 다시 읽는다
npm run cli -- campaign:rank           # 선별을 지금 실행한다
npm run cli -- campaign:show <id>      # 상태, 선별 이유, skip_reason, last_error 보기
npm run cli -- campaign:card <id>      # Telegram 카드를 (다시) 보낸다
npm run cli -- campaign:apply <id>     # 신청을 지금 실행한다 (ASIDE_DRY_RUN이 꺼져 있으면 실제로 제출한다)
npm run cli -- campaign:selection      # 선정 확인을 지금 실행한다
npm run cli -- campaign:remind         # 리마인더를 지금 확인해서 보낸다
npm run cli -- blog:draft <id> [피드백] # 후기 초안을 (다시) 만든다
npm run cli -- blog:save <id>          # 승인된 초안을 네이버에 임시저장한다
npm run cli -- kakao:read "<방 이름>"  # 스파이크용. 읽어서 출력만 한다
npm run cli -- aside:read <url>        # 스파이크용. 페이지 텍스트를 출력만 한다
```

`kakao:read`, `aside:read`는 DB와 외부 서비스에 아무것도 쓰지 않는다.

### Telegram에서 할 일

| 때 | 동작 |
|---|---|
| 공고 카드(🎁)가 왔다 | `✅ 신청함 (직접)`은 내가 직접 신청했을 때, `🚀 신청 승인 (자동)`은 Aside가 신청하게 할 때, `🙅 패스`는 사유를 고른다. 신청 문구는 `수정: <문구>` 답장으로 교체하거나 다른 내용으로 답장해 다시 쓰게 한다. |
| 신청이 끝났다 / 실패했다 | 실패 알림의 재시도 버튼은 `attempts`를 0으로 돌리고 다시 신청한다. |
| 선정됐다 (🎉) | 리뷰 마감, 키워드, 가이드 요약이 온다. 리뷰 마감 D-3, D-1, 당일과 선정 3일 뒤 "제품 받았나요?"가 온다(리마인더는 09~21시에만). |
| `📝 초안 쓰기` | 접수 메시지에 **사진과 사용 메모를 답장**한다. 메모를 보내면 초안 카드가 온다. |
| 초안 카드 | `✅ 승인 (임시저장)`, `🔁 재생성`. 답장 `수정: <본문>`, `제목: <제목>`은 그대로 교체하고, 그 외는 수정 요청으로 재생성한다. 광고 표기는 코드가 맨 앞에 붙이므로 지우지 않아도 된다. |
| 임시저장 완료 | 네이버 블로그 임시저장함에서 사진 위치와 글을 확인하고 **직접 발행**한 뒤 `/posted <id> <블로그 주소>`를 보낸다. |

### Phase 0 스파이크 체크리스트

코드는 모두 쓰여 있지만 아래는 실제 PC에서 확인한 적이 없다. 결과는 [plans/campaign-autopilot.md](plans/campaign-autopilot.md) 9절에 적는다.

1. `aside --help`, `aside repl --help`, `aside account list`를 저장한다.
2. `npm run cli -- aside:read https://www.revu.net/campaign/<id>`로 페이지 텍스트가 나오는지 본다. `__ASIDE_RESULT__` 줄 파싱이 되는지, `openTab`이 돌려주는 객체가 `evaluate`/`title`/`url`을 지원하는지 확인한다. 로그인이 풀려 있는지도 본다.
3. `npm run cli -- aside:read https://www.revu.net/mypage/campaigns?status=request`로 내 신청 목록이 보이는지 본다.
4. 레뷰 신청 폼(신청 메시지, 선택 항목)이 `APPLY_SCRIPT`의 가정과 맞는지 dry-run 로그와 화면으로 비교한다.
5. `npm run cli -- kakao:read "<방 이름>"`으로 복사된 텍스트가 `[이름] [오후 1:23] 내용` 형식이고 몇 개 메시지까지 읽히는지 본다. 화면을 잠그고 다시 해서 종료 코드 2가 나오는지도 본다.
6. 네이버 블로그 임시저장을 `ASIDE_DRY_RUN=false`로 한 건만 실제로 돌려 본다 (`blog:save <id>`). 발행되지 않고 임시저장함에만 생기는지 확인한다.
7. 셋(Aside 읽기, 레뷰 목록, 카톡 읽기)이 되면 운영을 시작한다. 카톡이 불안정하면 대화 내보내기 txt 입력으로 대체한다(결정 11).

### dry-run 해제

`ASIDE_DRY_RUN=true`이면 읽기는 하지만 신청 제출과 블로그 저장은 하지 않는다. 신청은 `APPLY_FAILED`(`드라이런: 제출하지 않음`), 저장은 `DRAFT_FAILED`(`드라이런: 저장하지 않음`)로 끝난다.

1. 처음 **일주일**은 `true`로 운영하면서 선별 카드의 품질과 dry-run 로그의 신청 내용(`[aside dry-run]`)을 본다.
2. 문제가 없으면 `.env`에서 `ASIDE_DRY_RUN=false`(또는 줄 삭제)로 바꾸고 로컬 워커를 재시작한다.
3. dry-run으로 끝난 건은 카드의 재시도 버튼으로 다시 신청한다.

### 체험단 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 카드가 안 온다 | `/status`로 로컬 heartbeat와 단계별 개수를 본다. `npm run cli -- campaign:show <id>`로 `status`, `skip_reason`, `last_error`를 본다. `SKIPPED`면 사유(방문형, 제외 키워드, 신청 마감 지남, 선별 탈락)를 보고 프로필을 조정한다. |
| `read-room.ps1` 종료 코드 **2** | 화면이 잠겨 있다. 잠금을 풀고 PC를 깨워 둔다. 다음 수집 주기에 다시 읽는다. |
| 종료 코드 **3** | 카카오톡이 실행 중이 아니거나, 메인 창을 찾지 못했다(로그아웃, 트레이로 최소화). 카카오톡을 열고 로그인한다. |
| 종료 코드 **4** | 방을 찾지 못했다. `KAKAO_ROOMS`가 창 제목과 정확히 같은지 본다. 방이 목록 맨 위에 있지 않으면 메인 창 검색으로 열리는지 직접 해 본다. |
| 종료 코드 **5** | 복사된 텍스트가 없다. 방 창이 가려져 있거나 대화 영역을 클릭하지 못한 것이다. 창 크기와 배율을 확인하고 `kakao:read`로 재현한다. |
| 종료 코드 **1** | 그 밖의 오류. stderr 메시지를 본다. |
| `레뷰 로그인이 필요해요` (신청 `APPLY_FAILED`, 선정 확인 알림) | Aside 브라우저에서 revu.net에 다시 로그인하고 카드의 재시도 버튼을 누른다. 로그인이 풀린 채로는 선정 확인도 하지 않는다. 안 뽑힌 것으로 처리하지 않기 위해서다. |
| 공고가 `UNREADABLE` | 상세 페이지를 읽지 못했다. 링크가 레뷰 캠페인이 아니거나 삭제된 공고일 수 있다. 재시도하지 않는다. 고쳤다면 `campaign:fetch <id>`로 다시 읽는다. |
| 신청이 `APPLY_FAILED` | `last_error`로 원인을 보고(`campaign:show <id>`), 고친 뒤 카드의 **재시도 버튼**을 누른다. 3번 실패하면 `APPLY_FAILED`가 되고 재시도 버튼이 온다. 실패 화면은 `data/campaign-screenshots/`에 저장된다. `드라이런: 제출하지 않음`이면 dry-run 때문이다. 신청 내역에 이미 있으면 재시도해도 다시 제출하지 않고 `APPLIED`로 바꾼다. |
| 초안 저장이 `DRAFT_FAILED` | `last_error`를 본다. `드라이런: 저장하지 않음`이면 dry-run 때문이다. 로그인(네이버)이 풀렸거나 에디터 화면이 달라졌을 수 있다. 고친 뒤 재시도 버튼, 또는 `blog:save <id>`. 결과를 확인하지 못해 재시도하면 임시저장 글이 중복될 수 있으니 네이버 임시저장함을 정리한다. |
| `/status`의 로컬 heartbeat가 오래됨 | PC가 꺼졌거나 잠겼거나 로컬 워커가 죽었다. 로컬 워커를 다시 시작한다. 그동안의 local job은 대기하고 있다가 이어서 처리된다. |
| Telegram `409 Conflict` | polling을 하는 워커가 둘이다. Railway cloud 워커가 하나뿐인지, PC의 워커가 `WORKER_ROLE=local`인지 확인한다. |
| 로컬 워커 시작 후 `relation "campaigns" does not exist` | cloud가 아직 마이그레이션 `014`를 적용하지 않았다. cloud를 먼저 배포하고 다시 시작한다. |
