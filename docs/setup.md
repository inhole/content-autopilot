# 외부 서비스 준비

워커를 돌리려면 서비스 4개가 필요하다. 체험단(선물하기, 무신사)은 둘 다 공개 목록이라 별도 준비가 필요 없다. Supabase만 있으면 수집과 dry-run 발행은 바로 돌아가고, 나머지는 하나씩 붙이면 된다.

| 서비스 | 용도 | 없을 때 동작 |
|---|---|---|
| Supabase | Postgres (데이터, pg-boss 큐) | 필수 |
| OpenRouter | 주제 선정·중복 판정, 초안 작성 | 주제 선정부터 실패 |
| Telegram 봇 | 초안 검수 (승인/재생성/폐기) | 콘솔 출력 + CLI로 검수 |
| Meta 앱 (Threads API) | 실제 발행 | `THREADS_DRY_RUN=true`로 로그만 남김 |
| 카카오톡 선물하기·무신사 (5절) | 체험단 공개 목록 | 계정·토큰 필요 없음. 읽기만 한다 |

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

체험단 선별은 기본으로 LLM을 쓰지 않는다(`CAMPAIGN_RANK_MODE=rule`, 5-1절). `LLM_RANK_MODEL`은 Threads 주제 선정과 `CAMPAIGN_RANK_MODE=llm`일 때의 체험단 선별에 쓰인다.

## 3. Telegram 봇

1. Telegram에서 `@BotFather`에게 `/newbot`을 보내 봇을 만들고 토큰을 받는다.
2. `TELEGRAM_BOT_TOKEN`에 넣고 `npm start`로 워커를 띄운다.
3. 봇에게 `/start`를 보내면 chat id를 알려준다. 그 값을 `TELEGRAM_CHAT_ID`에 넣고 워커를 재시작한다.
   - 봇은 `TELEGRAM_CHAT_ID`가 아닌 채팅은 무시한다.

## 4. Meta 앱 (Threads API)

> **현재 상태 (2026-10-19): 발행 전용 계정 @devbrief.kr로 발행한다**
> - devbrief.kr은 처음에 토큰을 만들 때 허용 페이지가 Threads 404("이 페이지는 길을 잃었습니다")로 나와 일주일 넘게 연결하지 못했다. OAuth 주소와 대시보드 사용자 토큰 생성기, PC와 휴대폰 모두 같았다. 같은 앱 **CAT**에서 본계정 @lilxnhoo는 토큰이 바로 나와서, 앱 설정이 아니라 새 계정에 걸린 제한으로 보였다(Meta가 밝힌 원인은 아니다).
> - 그래서 2026-10-18에는 본계정으로 연결해 발행했다(#29, #30 등 11개). 그날 `threads:probe`로 `/me/replies`의 `replied_to`가 원글 id와 일치하고, `/me/threads`와 `/me/replies`는 최신순이며 `/me/threads`에는 답글이 섞이지 않는 것을 확인했다. 연결 글의 media id 복구가 기대는 동작이 실제와 맞다.
> - 2026-10-19 devbrief.kr 토큰이 발급돼 4-4 끝의 절차로 발행 계정을 옮겼다(user id `29555790387356473`). 본계정에 올린 글의 팔로워와 성과 기록은 옮겨지지 않는다. 새 토큰으로는 그 글을 조회할 수 없어 성과 수집과 답글 알림이 글마다 오류 로그를 남기지만, 글마다 따로 처리하므로 워커는 멈추지 않는다.
> - 남은 확인: devbrief.kr에 글과 답글이 생긴 뒤 `threads:probe`를 다시 돌려 답글·성과 항목까지 `OK`인지 본다.

### 4-1. Threads 계정
- 현재 발행 계정은 **@devbrief.kr**이다(위 현재 상태 참고). 2026-10-18 하루는 본계정 @lilxnhoo로 발행했다.
- **프로필은 공개로 둔다.** 사용자 토큰 생성기는 공개 계정에만 토큰을 만들어 주고, 비공개 프로필은 앱 권한이 90일마다 끊긴다.
- 새로 만든 계정은 바로 앱 연동이 안 될 수 있다(위 현재 상태 참고). 프로필을 채우고 며칠 실제로 쓴 뒤 연결한다.

### 4-2. 앱 만들기 (한글 화면 기준)
1. https://developers.facebook.com 에서 개발자로 등록한다.
   - 처음 쓰는 기기에서는 "평소에 사용하지 않는 기기" 보안 제한이 걸려 Contact info(이메일 인증) 단계가 막힐 수 있다. **평소 Facebook을 쓰는 휴대폰 브라우저**에서 진행하고, Facebook 계정에 이미 등록된 이메일로 인증한다.
2. **내 앱 → 앱 만들기**에서 사용 사례로 **"Threads API에 액세스"**를 고른다.
3. **사용 사례 → Threads API에 액세스 → 맞춤 설정 → 권한**에서 추가한다.
   - `threads_basic`, `threads_content_publish`, `threads_manage_insights`(성과 수집용), `threads_read_replies`·`threads_manage_replies`(답글 알림·답글 달기용)
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
1. `npm run cli -- threads:probe`로 토큰 주인과 API 동작을 확인한다. 읽기만 하고 DB에 토큰을 저장하지 않는다. 확인할 글이 없다고 나오면 앱에서 글과 답글을 하나씩 올리고 다시 돌린다.
2. 로컬 `.env`는 `THREADS_DRY_RUN=true`인 채로 `THREADS_DRY_RUN=false npm run cli -- threads:check`를 실행해 계정 username이 나오는지 본다. 이때 토큰이 DB(`platform_accounts`)에 처음 저장되고, 만료일은 59일 뒤로 잡힌다. 이후 기준은 DB다.
3. Railway Variables에 `THREADS_USER_ID`, `THREADS_ACCESS_TOKEN`, `THREADS_DRY_RUN=false`를 넣는다(저장하면 재배포된다).
4. 첫 실제 발행: 검수 대기 초안 하나를 Telegram에서 ✅ 승인 → 🚀 지금 발행 → 5분 안에 🚀 알림 → Threads 프로필에서 본문, 원문 링크 카드, 주제 태그를 확인한다. Threads API 호출은 지금까지 dry-run으로만 검증됐으므로 이것이 첫 실제 검증이다.

`refresh-token` job이 매일 04:00에 확인해서 만료가 14일 안으로 남으면 갱신한다(갱신은 발급 24시간 이후부터 가능). 토큰을 새로 발급해 바꿀 때(발행 계정을 옮길 때도 같다)는 이 순서로 한다.
1. 로컬 `.env`에 새 토큰을 넣고 `threads:fill-user-id`로 `THREADS_USER_ID`를 채운 뒤 `threads:probe`로 계정 이름을 확인한다.
2. Railway Variables의 `THREADS_ACCESS_TOKEN`, `THREADS_USER_ID`를 새 값으로 저장한다. **DB 행보다 먼저 바꾼다.** 순서가 반대면 이전 env로 돌고 있는 워커가 다음 호출 때 이전 토큰을 다시 DB에 넣는다.
3. `delete from platform_accounts where platform='THREADS'`를 실행하고, 바로 `THREADS_DRY_RUN=false npm run cli -- threads:check`를 돌린다. 새 토큰이 DB에 저장되고 username이 출력된다. 워커는 호출마다 DB에서 토큰을 읽으므로 재시작은 필요 없다.
4. `select user_id, expires_at from platform_accounts`로 새 user id가 들어갔는지 확인한다.

### 4-5. 겪은 문제와 해결
| 증상 | 원인 / 해결 |
|---|---|
| 개발자 가입 중 "현재 이 변경 사항을 적용할 수 없습니다 … 평소에 사용하지 않는 기기" | Facebook 계정 보안 조치. 평소 쓰는 기기에서 진행하고, 이미 등록된 이메일을 쓴다. 아니면 며칠 기다린다. |
| 토큰 발급 시 `The user has not accepted the invite to test the app` (1349245) | 초대 미수락. 발행 계정으로 `threads.com/settings/account` → 웹사이트 권한 → 초대에서 수락한다. 허용 화면의 로그인 계정이 테스터 계정인지도 확인한다. |
| 휴대폰에서 토큰 생성기를 누르면 Threads 앱이 켜지고 빈 화면 | 앱이 링크를 가로챈다. 안드로이드는 앱 정보 → 기본으로 열기 → 지원되는 링크 열기를 끄고, 아이폰은 Threads 앱을 잠시 "앱 정리"한 뒤 브라우저에서 한다. |
| 로그인 후 Threads 404 "이 페이지는 길을 잃었습니다" | 주소가 깨졌으면(`&amp;`) 터미널에서 다시 복사한다. 주소가 정상이고 다른 테스터 계정은 되는데 특정 계정만 404면 **그 계정의 제한**이다(devbrief.kr이 처음 일주일 넘게 이 상태였다). 프로필을 채우고 직접 활동하며 며칠 기다린다. 일주일이 넘어도 같으면 Instagram 앱에 계정 확인 알림이 있는지 보고, Meta 개발자 지원에 "같은 앱에서 다른 테스터는 되는데 특정 테스터만 authorize 404"로 신고한다. |

---

## 5. 체험단 (카카오톡 선물하기, 무신사 프리유저)

체험단은 계정이나 토큰이 필요 없다. 선물하기와 무신사 모두 공개 목록을 읽기만 한다. 위의 Supabase, Telegram 설정이 되어 있으면 바로 돈다. 수집, 선별, 카드는 OpenRouter 없이 돌고, 리뷰 초안만 OpenRouter가 필요하다. 클라우드 워커 하나가 Threads와 두 출처의 체험단을 같이 처리하고, 별도 PC나 브라우저 자동화를 쓰지 않는다. 로그인이 필요한 무신사 신청은 지금은 내가 직접 한다(5-4절).

신청과 리뷰 작성은 카카오톡 **모바일 앱**에서만 된다. 폰에 카카오톡이 있고 선물하기에서 체험단에 신청할 수 있는 계정이면 된다. Telegram은 그 폰에도 깔려 있어야 카드의 링크를 바로 열 수 있다.

### 5-1. 환경 변수

모두 선택이다. 기본값으로 돌아간다. 형식은 `.env.example`을 본다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GIFT_COLLECT_CRON` | `0 9,15,21 * * *` | 공개 목록을 읽는 시각 (`TZ_NAME` 기준) |
| `GIFT_TRIAL_PAGE_ID` | `33325` | 선물하기 체험단 탭의 페이지 번호. `gift.kakao.com/page/<번호>`다. 탭이 바뀌면 이 값을 고친다. |
| `CAMPAIGN_DAILY_MAX` | `5` | 출처(카카오톡, 무신사)마다 하루에 Telegram으로 보낼 카드 최대 개수 (1~20) |
| `CAMPAIGN_RANK_MODE` | `rule` | 선별 점수 방식. `rule`은 코드가 경쟁률·정가·관심 단어로 매기고 LLM을 부르지 않는다. `llm`은 `LLM_RANK_MODEL`이 매긴다([architecture.md](architecture.md) 선별) |
| `MUSINSA_COLLECT_CRON` | `0 10,16,22 * * *` | 무신사 목록을 읽는 시각 (`TZ_NAME` 기준) |
| `CAMPAIGN_PROFILE_PATH` | `config/campaign-profile.json` | 선별 규칙과 리뷰 문체, 광고 표기를 담은 프로필 파일 |

선별은 기본으로 LLM 없이 돌고(`CAMPAIGN_RANK_MODE=llm`일 때만 `LLM_RANK_MODEL`), 리뷰 초안은 `LLM_MODEL`을 쓴다(2절). 카카오톡 카드 버튼이 카카오톡 앱으로 바로 열리게 하려면 `PUBLIC_BASE_URL`(대시보드 공개 https 주소, 경로 없이)도 넣는다([dashboard.md](dashboard.md)). 웹 대시보드는 Telegram 설정이 있으면 켜지고, Telegram으로 받는 1회용 코드로 로그인한다([dashboard.md](dashboard.md)).

### 5-2. 프로필 `config/campaign-profile.json`

선별 규칙과 리뷰 문체의 기준이다. 레포에 두며, 배송지나 연락처는 넣지 않는다(카카오에 이미 있다). 파일을 바꾸면 워커를 재시작한다. 대시보드 `운영` 페이지에서 고쳐 저장하면 DB 사본이 이 파일보다 우선하고 재시작 없이 반영된다([dashboard.md](dashboard.md)의 「체험단 프로필 편집」). 그때부터 파일은 사본을 되돌렸을 때 쓰는 기본값이다.

```json
{
  "about": "IT 개발자. 실사용 위주로 꼼꼼히 써보고 장단점을 솔직하게 남기는 편",
  "interests": ["IT 액세서리", "주변기기", "생활용품", "식품", "주방용품"],
  "preferKeywords": ["키보드", "마우스", "충전", "디지털", "텀블러", "프라이팬"],
  "excludeKeywords": ["다이어트 보조제", "주류", "성인"],
  "excludeBrands": [],
  "maxCompetition": 200,
  "minPriceWon": 30000,
  "review": {
    "tone": "담백한 1인칭, 과장 없이 실사용 위주",
    "minChars": 100,
    "maxChars": 500,
    "points": ["실제로 써본 기간과 상황", "좋았던 점과 아쉬운 점"]
  },
  "disclosure": "체험단으로 제품을 제공받아 작성한 솔직한 리뷰입니다."
}
```

| 필드 | 설명 |
|---|---|
| `about` | 나를 소개하는 한두 문장. 선별과 리뷰 초안의 맥락이다. |
| `interests` | 관심 품목. 규칙 점수에서는 `preferKeywords`와 같이 쓰이고, LLM 선별에서는 프롬프트에 들어간다. |
| `preferKeywords` | 제목, 브랜드, 무신사 품목 이름에 들어 있으면 규칙 점수에 2점을 더하는 단어. 부분 일치라 짧은 단어는 엉뚱한 데 걸린다(예: `허브`는 브랜드 `에센허브`, `케이블`은 `케이블 비니`). 생략하면 빈 목록이다. |
| `excludeKeywords` | 제목·브랜드에 있으면 코드가 점수를 매기기 전에 바로 건너뛴다. |
| `excludeBrands` | 브랜드 이름에 포함되면 건너뛴다. 생략하면 빈 목록이다. |
| `minPriceWon` | 정가(원)가 이보다 낮은 체험단은 건너뛴다(`가격 낮음: 14,900원`). 정가를 모르면 건너뛰지 않는다. 저장소 기본 파일은 `30000`이고, 생략하면 제한이 없다. 선물하기 정가는 수집 때 공개 상품 API에서 읽고, 무신사는 목록의 대표 상품 정가를 쓴다. |
| `maxCompetition` | 모집 인원 한 명당 신청자 수가 이보다 많으면 건너뛴다. **생략하면 제한이 없다** (저장소 기본 파일에는 없다. 위 예시의 200은 예시 값이다). |
| `review.tone` | 리뷰 말투 |
| `review.minChars` / `maxChars` | 리뷰 글자 수 범위. 기본 100 / 500. `maxChars`는 광고 표기 줄을 포함한 전체 길이다. |
| `review.points` | 리뷰에 담을 관점 |
| `disclosure` | 모든 리뷰 초안 맨 앞에 코드가 붙이는 광고 표기. 생략하면 줄을 붙이지 않는다([결정 12](decisions.md#12-광고-표기는-코드가-강제한다)). 체험단으로 받은 제품의 리뷰에는 반드시 두는 것을 권한다. |

### 5-3. 첫 실행

1. `npm run cli -- gift:list`로 목록이 읽히는지 본다. DB에는 쓰지 않는다.
2. `npm run cli -- campaign:collect`로 수집·선별·카드 전송을 한 번 돌린다. `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`가 있어야 카드가 간다(없으면 콘솔에 출력만 한다).
3. 이후는 워커가 `GIFT_COLLECT_CRON`대로 돈다. 쓰는 법은 [operations.md](operations.md#체험단)를 본다.

### 5-4. 무신사 프리유저

무신사 체험단 목록(`musinsa.com/preuser/main`이 쓰는 공개 API)은 로그인 없이 읽힌다. 따로 준비할 것이 없고 `MUSINSA_COLLECT_CRON` 시각마다 클라우드 워커가 읽는다. `npm run cli -- musinsa:list`로 목록이 나오는지 본다(DB에는 쓰지 않는다). 그다음 `npm run cli -- musinsa:collect`로 수집·선별·카드 전송을 한 번 돌린다([결정 13](decisions.md#13-무신사-체험단-목록은-공개-api라-클라우드에서-읽는다)).

무신사 프리유저 **가입**은 별도다. 신청, 내 신청 내역은 로그인한 가입 계정만 쓸 수 있고, 가입하려면 스냅을 한 번 올려야 한다(`MCMP_001_006 작성한 스냅이 있는 회원만 신청할 수 있습니다`). 가입 전에는 카드의 링크를 PC에서 열어 직접 신청하고 `✅ 신청함`을 누른다. 가입 뒤 자동 신청은 후속 단계이고, 그때는 내가 로그인한 Aside 브라우저를 쓸 계획이다([plans/campaign-autopilot.md](plans/campaign-autopilot.md)). 비밀번호나 쿠키를 코드나 `.env`에 넣지 않는다.
