# 외부 서비스 준비

워커를 돌리려면 서비스 4개가 필요하다. Supabase만 있으면 수집과 dry-run 발행은 바로 돌아가고, 나머지는 하나씩 붙이면 된다.

| 서비스 | 용도 | 없을 때 동작 |
|---|---|---|
| Supabase | Postgres (데이터, pg-boss 큐) | 필수 |
| OpenRouter | 주제 선정·중복 판정, 초안 작성 | 주제 선정부터 실패 |
| Telegram 봇 | 초안 검수 (승인/재생성/폐기) | 콘솔 출력 + CLI로 검수 |
| Meta 앱 (Threads API) | 실제 발행 | `THREADS_DRY_RUN=true`로 로그만 남김 |

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

> **현재 상태 (2026-10-11): 연결 보류 중. 2026-10-18 전후로 재시도 예정**
> - 완료: Meta 앱 **CAT** 생성, Threads 사용 사례·권한·콜백 URL 설정, 발행 계정 **devbrief.kr**을 Threads 테스터로 추가하고 초대 수락.
> - 막힌 곳: devbrief.kr로 토큰을 만들려고 하면 로그인은 되지만, 허용 페이지가 Threads 404("방황하는 모든 자가 길을 잃은 것은 아니지만, 이 페이지는 길을 잃었습니다")로 나온다. OAuth 주소(`threads:auth-url`)와 대시보드의 사용자 토큰 생성기 모두 같다. PC 시크릿 창과 휴대폰 브라우저에서도 같다.
> - 진단: 같은 앱에서 **본계정(오래 쓴 개인 계정)은 토큰 생성에 성공**했다. 그래서 앱 설정과 개발자 계정은 정상이고, **새로 만든 devbrief.kr 계정에만 걸린 제한**(새 계정 보호 조치로 추정)이 원인으로 보인다. Meta가 공식적으로 밝힌 원인은 아니다.
> - 기다리는 동안 할 일: devbrief.kr 프로필(사진·소개) 채우기, 휴대폰 앱에서 직접 글 1~2개 올리고 팔로우·좋아요, 2단계 인증 켜기, 로그인은 같은 휴대폰에서.
> - 정리할 것: 진단용으로 추가한 본계정은 Threads 테스터에서 삭제한다. 본계정 토큰은 쓰지 않는다(`.env`에 넣으면 본계정에 발행된다).
> - 그동안 파이프라인은 `THREADS_DRY_RUN=true`로 정상 동작한다(초안 생성, 검수, 문체 학습 데이터 축적).
> - 재시도할 때: 아래 4-3의 "방법 A"부터 다시 한다. 이번에도 404면 4-5의 마지막 항목을 본다.

### 4-1. Threads 계정
- 발행 전용 계정을 쓴다. 현재는 **devbrief.kr**이다(Instagram 계정을 먼저 만들고 Threads를 연결함).
- **프로필은 공개로 둔다.** 사용자 토큰 생성기는 공개 계정에만 토큰을 만들어 주고, 비공개 프로필은 앱 권한이 90일마다 끊긴다.
- 새로 만든 계정은 바로 앱 연동이 안 될 수 있다(위 현재 상태 참고). 프로필을 채우고 며칠 실제로 쓴 뒤 연결한다.

### 4-2. 앱 만들기 (한글 화면 기준)
1. https://developers.facebook.com 에서 개발자로 등록한다.
   - 처음 쓰는 기기에서는 "평소에 사용하지 않는 기기" 보안 제한이 걸려 Contact info(이메일 인증) 단계가 막힐 수 있다. **평소 Facebook을 쓰는 휴대폰 브라우저**에서 진행하고, Facebook 계정에 이미 등록된 이메일로 인증한다.
2. **내 앱 → 앱 만들기**에서 사용 사례로 **"Threads API에 액세스"**를 고른다.
3. **사용 사례 → Threads API에 액세스 → 맞춤 설정 → 권한**에서 추가한다.
   - `threads_basic`, `threads_content_publish`, `threads_manage_insights`(성과 수집용)
4. 같은 곳의 **설정** 탭에서 **리디렉션 콜백 URL / 제거 콜백 URL / 삭제 콜백 URL**에 모두 `https://localhost/`를 넣고 **저장**한다.
5. **앱 역할 → 역할 → 사람 추가 → "Threads 테스터"**로 발행 계정 username을 추가한다. 일반 "테스터"가 아니다.
   - 대시보드에는 수락 여부가 표시되지 않는다. 수락은 발행 계정으로 로그인한 브라우저에서 `https://www.threads.com/settings/account` → **웹사이트 권한 → 초대**에서 하고, **활성** 탭에 앱이 보이면 완료다. 앱 설정의 "계정 센터"가 아니다.
   - 개발 모드 + 본인 테스터로 쓰면 App Review가 필요 없다.
6. **Threads 앱 ID / Threads 앱 시크릿 코드**는 **사용 사례 → Threads API에 액세스 → 맞춤 설정 → 설정** 탭 맨 위에 있다. 앱 설정 → 기본 설정에는 일반 앱 ID/시크릿도 같이 있어서 헷갈리니, Threads라고 적힌 값을 쓴다. (CAT의 Threads 앱 ID는 `1958252051820363`.)

### 4-3. 장기 토큰 발급 (처음 한 번)

**방법 A (권장): 대시보드의 사용자 토큰 생성기**
1. **사용 사례 → Threads API에 액세스 → 맞춤 설정 → 설정** 탭 아래 **사용자 토큰 생성기**에서 발행 계정 줄의 **액세스 토큰 생성하기**를 누르고, 발행 계정으로 로그인·허용한다. 60일짜리 장기 토큰이 바로 나온다(단기→장기 교환이 필요 없다).
2. 토큰을 `.env`의 `THREADS_ACCESS_TOKEN`에 한 줄로 넣는다(채팅에 붙여넣지 않는다).
3. `npm run cli -- threads:fill-user-id`를 실행한다. 토큰 주인을 조회해 `THREADS_USER_ID`를 `.env`에 채우고 `(@devbrief.kr)`처럼 출력한다. **계정 이름을 꼭 확인한다.**

**방법 B: OAuth + CLI**
1. `.env`에 `THREADS_APP_ID`, `THREADS_APP_SECRET`(Threads 앱 ID와 시크릿)을 넣는다.
2. `npm run cli -- threads:auth-url`로 출력된 주소를 발행 계정으로 로그인한 브라우저에서 열고 허용한다. 이 대화창이나 HTML로 표시된 출력을 복사하면 `&`가 `&amp;`로 깨질 수 있으니 터미널에서 직접 복사한다.
3. 이동한 주소(`https://localhost/?code=…`)를 통째로 복사해 `npm run cli -- threads:token "<복사한 주소>"`를 실행한다. 코드 교환과 장기 토큰 교환을 한 번에 하고 `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN`을 `.env`에 저장한다(토큰은 출력되지 않는다). 코드는 1시간 안에 한 번만 쓸 수 있다.

같은 과정을 curl로 하려면 `POST https://graph.threads.com/oauth/access_token`(code → 단기 토큰) 다음 `GET https://graph.threads.net/access_token?grant_type=th_exchange_token`(단기 → 장기)을 호출한다. 구현은 `src/threads/oauth.ts`에 있다.

### 4-4. 연결 후 할 일
1. 로컬 `.env`는 `THREADS_DRY_RUN=true`인 채로 `THREADS_DRY_RUN=false npm run cli -- threads:check`를 실행해 계정 username이 나오는지 본다. 이때 토큰이 DB(`platform_accounts`)에 처음 저장되고, 만료일은 59일 뒤로 잡힌다. 이후 기준은 DB다.
2. Railway Variables에 `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN`, `THREADS_DRY_RUN=false`를 넣는다(저장하면 재배포된다).
3. 첫 실제 발행: 검수 대기 초안 하나를 Telegram에서 ✅ 승인 → 🚀 지금 발행 → 5분 안에 🚀 알림 → Threads 프로필에서 본문, 원문 링크 카드, 주제 태그를 확인한다. Threads API 호출은 지금까지 dry-run으로만 검증됐으므로 이것이 첫 실제 검증이다.

`refresh-token` job이 매일 04:00에 확인해서 만료가 14일 안으로 남으면 갱신한다(갱신은 발급 24시간 이후부터 가능). 토큰을 새로 발급해 바꿀 때는 `delete from platform_accounts where platform='THREADS'` 후 워커를 재시작하면 env의 새 토큰을 다시 읽는다.

### 4-5. 겪은 문제와 해결
| 증상 | 원인 / 해결 |
|---|---|
| 개발자 가입 중 "현재 이 변경 사항을 적용할 수 없습니다 … 평소에 사용하지 않는 기기" | Facebook 계정 보안 조치. 평소 쓰는 기기에서 진행하고, 이미 등록된 이메일을 쓴다. 아니면 며칠 기다린다. |
| 토큰 발급 시 `The user has not accepted the invite to test the app` (1349245) | 초대 미수락. 발행 계정으로 `threads.com/settings/account` → 웹사이트 권한 → 초대에서 수락한다. 허용 화면의 로그인 계정이 테스터 계정인지도 확인한다. |
| 휴대폰에서 토큰 생성기를 누르면 Threads 앱이 켜지고 빈 화면 | 앱이 링크를 가로챈다. 안드로이드는 앱 정보 → 기본으로 열기 → 지원되는 링크 열기를 끄고, 아이폰은 Threads 앱을 잠시 "앱 정리"한 뒤 브라우저에서 한다. |
| 로그인 후 Threads 404 "이 페이지는 길을 잃었습니다" | 주소가 깨졌으면(`&amp;`) 터미널에서 다시 복사한다. 주소가 정상이고 다른 테스터 계정은 되는데 특정 계정만 404면 **그 계정의 제한**이다(현재 devbrief.kr 상태). 프로필을 채우고 직접 활동하며 며칠 기다린다. 일주일이 넘어도 같으면 Instagram 앱에 계정 확인 알림이 있는지 보고, Meta 개발자 지원에 "같은 앱에서 다른 테스터는 되는데 특정 테스터만 authorize 404"로 신고한다. |
