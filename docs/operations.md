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

발행이 끝나면 🚀 메시지가 온다. 3번 실패하면 ❌ 메시지가 온다. 수집이 실패하거나 토큰 갱신이 실패해도 ⚠️ 메시지가 온다.

## CLI

```bash
npm run cli                          # 명령 목록
npm run cli -- collect               # RSS만 수집
npm run cli -- daily                 # 수집 → 중복 제거 → 선정 → 초안 생성을 지금 바로 실행 (큐 없이)
npm run cli -- add-topic "제목" [url] # 직접 고른 주제로 초안 생성
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
