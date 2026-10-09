# 외부 서비스 준비

워커를 돌리려면 서비스 4개가 필요하다. Supabase만 있으면 수집과 dry-run 발행은 바로 돌아가고, 나머지는 하나씩 붙이면 된다.

| 서비스 | 용도 | 없을 때 동작 |
|---|---|---|
| Supabase | Postgres (데이터, pg-boss 큐) | 필수 |
| OpenRouter | 주제 선정·중복 판정, 초안 작성 | 주제 선정부터 실패 |
| Telegram 봇 | 초안 검수 (승인/재생성/폐기) | 콘솔 출력 + CLI로 검수 |
| Meta 앱 (Threads API) | 실제 발행 | `THREADS_DRY_RUN=true`로 로그만 남김 |
| healthchecks.io (선택) | 워커 생존 감시 | 감시 없음 ([operations.md](operations.md#생존-감시-healthchecksio)) |

모든 값은 `.env`에 넣는다. 형식은 `.env.example`을 참고한다. `.env`는 git에 올라가지 않는다.

---

## 1. Supabase

1. https://supabase.com 에서 **New project**를 만든다.
   - Region: `Northeast Asia (Seoul)`
   - Database Password는 따로 저장해 둔다. 대시보드에서 다시 볼 수 없다.
2. 상단 **Connect**를 눌러 **Session pooler** 연결 문자열을 복사한다.
   ```
   postgresql://postgres.<project-ref>:<password>@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres
   ```
   - **Direct connection(`db.<ref>.supabase.co`)은 쓰지 않는다.** IPv6 전용이라 Railway나 일반 가정용 네트워크에서 `ENOTFOUND`로 실패한다.
   - **Transaction pooler(포트 6543)도 쓰지 않는다.** 계속 실행되는 pg-boss 워커와 맞지 않는다.
3. `.env`의 `DATABASE_URL`에 넣고 `npm run db:migrate`를 실행한다.

> Free 플랜은 1주일 동안 사용이 없으면 프로젝트가 일시정지된다. 워커가 매일 돌면 문제없다.

## 2. OpenRouter

1. https://openrouter.ai/keys 에서 키를 발급하고 크레딧을 충전한다 ($5면 한참 쓴다).
2. `OPENROUTER_API_KEY`에 넣는다.
3. 기본 모델은 다음과 같고, 바꾸려면 env로 덮어쓴다.

| 용도 | env | 기본값 |
|---|---|---|
| 초안 작성 | `LLM_MODEL` | `anthropic/claude-sonnet-5.5` |
| 주제 선정 | `LLM_RANK_MODEL` | `anthropic/claude-haiku-4.5` |

## 3. Telegram 봇

1. Telegram에서 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 토큰을 받는다.
2. `TELEGRAM_BOT_TOKEN`에 넣고 `npm start`로 워커를 띄운다.
3. 봇에게 `/start`를 보내면 chat id를 알려준다. 그 값을 `TELEGRAM_CHAT_ID`에 넣고 워커를 재시작한다.
   - 봇은 `TELEGRAM_CHAT_ID`가 아닌 채팅은 무시한다.

## 4. Meta 앱 (Threads API)

### 4-1. Threads 계정
- 발행 전용 계정을 쓰는 것을 권장한다.
- **프로필은 공개로 둔다.** 비공개 프로필이면 앱 권한이 90일마다 만료돼 다시 인증해야 한다.

### 4-2. 앱 만들기
1. https://developers.facebook.com 에서 개발자로 등록한다 (전화번호 인증).
   - 처음 쓰는 기기에서는 "평소에 사용하지 않는 기기" 보안 제한이 걸릴 수 있다. 그 기기로 며칠 쓰다 보면 풀린다.
2. **My Apps → Create App**에서 Use case로 **Access the Threads API**를 고른다.
3. **Use cases → Access the Threads API → Settings**에서 권한을 추가한다.
   - `threads_basic`, `threads_content_publish`
   - `threads_manage_insights` (나중에 성과 수집용)
4. 같은 화면의 Redirect / Uninstall / Delete Callback URL에 모두 `https://localhost/`를 넣는다. 토큰을 한 번 받을 때만 쓰는 임시 주소다.
5. **App roles → Roles → Add People → Threads Tester**로 발행 계정을 추가한다.
   - 그다음 threads.com의 **설정 → 계정 → 웹사이트 권한 → 초대**에서 수락한다.
   - 이렇게 개발 모드 + 본인 테스터로 쓰면 App Review가 필요 없다.
6. **App settings → Basic**에서 **Threads** App ID와 Secret을 복사한다. 이 화면에는 ID/Secret이 두 쌍 있는데, Threads라고 적힌 쪽을 써야 한다.

### 4-3. 장기 토큰 발급 (처음 한 번)

1. 브라우저로 아래 주소를 열고 허용한다.
   ```
   https://threads.com/oauth/authorize?client_id={APP_ID}&redirect_uri=https://localhost/&scope=threads_basic,threads_content_publish,threads_manage_insights&response_type=code
   ```
2. `https://localhost/?code=XXXX#_`로 이동하면, 주소창에서 `code` 값만 복사한다. 끝의 `#_`는 뺀다. 이 코드는 1시간 동안 한 번만 쓸 수 있다.
3. 아래 두 명령으로 코드를 장기 토큰으로 바꾼다.
   ```bash
   # 코드 → 단기 토큰 (1시간)
   curl -X POST https://graph.threads.com/oauth/access_token \
     -F client_id={APP_ID} -F client_secret={APP_SECRET} \
     -F grant_type=authorization_code -F redirect_uri=https://localhost/ \
     -F code={CODE}

   # 단기 토큰 → 장기 토큰 (60일)
   curl "https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret={APP_SECRET}&access_token={SHORT_TOKEN}"
   ```
4. 결과를 `.env`에 넣는다.
   - 첫 번째 응답의 `user_id` → `THREADS_USER_ID`
   - 두 번째 응답의 `access_token` → `THREADS_ACCESS_TOKEN`
   - `THREADS_DRY_RUN=false`
5. `npm run cli -- threads:check`로 확인한다. 계정 username이 나오면 성공이다.

토큰은 처음 쓸 때 `platform_accounts` 테이블로 옮겨지고, 그 뒤로는 DB에 있는 값을 쓴다. `refresh-token` job이 매일 04:00에 확인해서, 만료가 14일 안으로 남으면 갱신한다. 장기 토큰은 발급 후 24시간이 지나야 갱신할 수 있다. 그래서 첫날 갱신이 실패해도 정상이며, Telegram으로 경고가 온다.
