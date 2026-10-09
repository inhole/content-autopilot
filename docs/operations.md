# 운영

## 매일 할 일

Telegram으로 오는 초안을 확인한다. 하루 기본 3개다.

| 동작 | 결과 |
|---|---|
| ✅ 승인 | 다음 빈 발행 시간(08:00 / 12:30 / 19:00 KST)에 예약된다 |
| 🔁 재생성 | 같은 주제로 초안을 새로 쓴다 |
| 🗑 폐기 | 발행하지 않는다 |
| 초안에 `수정: <본문>` 답장 | 본문을 그대로 교체하고 다시 검수 메시지를 보낸다 |
| 초안에 다른 내용으로 답장 | 그 내용을 피드백으로 반영해 재생성한다 |
| 승인 메시지의 ⏪ 예약 취소 | 예약을 풀고 검수 대기로 되돌린다. 새 검수 메시지가 온다. |
| 승인 메시지의 🚀 지금 발행 | 발행 시각을 지금으로 당긴다. 다음 발행 확인 주기(5분 이내)에 나간다. |

두 버튼은 버튼이 만들어진 그 예약에만 동작한다. 이미 발행됐거나 다시 승인해서 시간이 바뀌었으면 "이미 처리된 예약이에요"라고 답한다.

**검수를 놓쳤을 때:** 48시간 동안 손대지 않은 초안은 `EXPIRED`로 만료되고 ⌛ 알림이 온다(매시 정각 확인). 09:00과 18:00에 검수 대기가 있으면 📝 리마인더가 온다.

발행이 끝나면 🚀 메시지가 온다. 발행이 3번 실패하면 ❌ 메시지가 온다. 일일 파이프라인, 초안 생성, 검수 전송 job이 재시도를 모두 소진해도 ❌ 메시지가 온다. 수집이 실패하거나 토큰 갱신이 실패하면 ⚠️ 메시지가 온다.

### Telegram 명령

| 명령 | 하는 일 |
|---|---|
| `/status` | 검수 대기, 발행 예정, 최근 24시간 발행 수, 실패한 글, 최근 7일 만료 수, 토큰 만료일, 마지막 수집 실행 결과, 이번 달 LLM 비용(OpenRouter)을 보여준다 |
| `/help` | 명령과 답장 규칙을 보여준다. 입력창에 `/`를 치면 명령 메뉴도 뜬다. |
| `/add <url> [한 줄 의견]` | 직접 고른 기사로 초안을 만든다. 의견을 붙이면 그 의견을 글의 관점으로 삼는다. 의견은 관점일 뿐이고, 사실은 기사 본문에서만 가져온다. 이미 다룬 기사면 알려주기만 하고 새로 만들지 않는다. |
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
npm run cli -- publish-now <postId>  # 즉시 발행 (FAILED 글 재시도에도 사용)
npm run cli -- threads:check         # 토큰 확인
npm run cli -- threads:refresh       # 토큰 수동 갱신
```

CLI는 Telegram 봇을 polling하지 않는다. 그래서 워커가 실행 중일 때 같이 써도 된다.

## 설정 바꾸기

| env | 기본값 | 설명 |
|---|---|---|
| `DAILY_POST_COUNT` | `3` | 하루에 만들 초안 수 |
| `PUBLISH_SLOTS` | `08:00,12:30,19:00` | 발행 시간 (`TZ_NAME` 기준) |
| `COLLECT_CRON` | `0 6 * * *` | 수집 시각 |
| `TZ_NAME` | `Asia/Seoul` | |

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
- **워커는 한 곳에서만 실행한다.** 로컬에서 `npm start`를 켜 둔 채로 Railway 워커가 뜨면 두 워커가 Telegram polling을 놓고 충돌한다 (`409 Conflict`). 중복 발행은 일어나지 않지만 버튼 응답이 불안정해진다. 로컬 워커는 끄고, 로컬에서는 CLI만 쓴다.
- 워커는 시작할 때 migration을 자동으로 적용한다.
- 환경변수를 바꾸면 Railway가 자동으로 재배포한다.

### CI 통과 후에만 배포 (Wait for CI)
GitHub Actions(`.github/workflows/ci.yml`)는 main에 push하거나 PR을 올리면 실행된다.
- `check` job: typecheck, lint, 단위 테스트
- `integration` job: pgvector Postgres 컨테이너에서 DB 시나리오 테스트

Railway 서비스 Settings에서 **Wait for CI**를 켜면, CI가 통과한 커밋만 배포된다. 원하면 GitHub Settings → Branches에서 main 보호 규칙을 만들고 `check`, `integration`을 필수로 지정한다.

### 생존 감시 (healthchecks.io)
워커가 죽으면 워커가 보내는 알림도 함께 멈춘다. 그래서 외부 서비스가 "신호가 끊겼다"를 대신 알리게 한다.
1. https://healthchecks.io 에 가입한다 (무료). 알림 채널(이메일 또는 Telegram)을 연결한다.
2. 체크 두 개를 만든다.
   - **worker:** Period 5분, Grace 10~15분 → ping URL을 Railway 변수 `HEALTHCHECK_URL`에 넣는다. 워커는 시작 직후와 5분마다 신호를 보낸다.
   - **daily:** Schedule(cron) `0 6 * * *`, 시간대 Asia/Seoul, Grace 1~2시간 → ping URL을 `HEALTHCHECK_DAILY_URL`에 넣는다. 일일 파이프라인이 성공하면 신호를 보내고, 마지막 재시도까지 실패하면 `<url>/fail`을 보낸다.
3. 둘 다 설정하지 않으면 신호를 보내지 않는다. 기능이 꺼질 뿐이고 다른 동작에는 영향이 없다.

### 로컬에서 통합 테스트
```bash
docker run -d --name ca-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres DATABASE_SSL=false npm run test:integration
```
통합 테스트는 테이블을 비우기 때문에 `DATABASE_URL` 호스트가 localhost/127.0.0.1/postgres가 아니면 실행을 거부한다(`test/integration/setup.ts`). 운영 DB에는 절대 돌지 않는다.
