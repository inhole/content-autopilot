# 체험단 자동화 실행계획 (Aside + 카카오톡 PC)

2026-10-18 인터뷰 결과를 바탕으로 쓴 계획이다. 구현하면서 바뀌는 결정은 이 문서와 `decisions.md`에 같이 적는다.

## 1. 인터뷰로 정한 것

| 항목 | 결정 |
|---|---|
| 자동화 범위 | 공고 수집·선별 → 신청 → 선정 후 일정 관리 → 리뷰 초안. 단계별로 나눠서 만든다 |
| 공고 입력 | 카카오톡 PC의 체험단 공고방 1~3개. 공고는 주로 **사이트 링크**다 |
| 대상 사이트 | 레뷰(revu.net) 하나 |
| 선별 기준 | **배송형(제품)** 체험단만 |
| 카톡 읽는 주기 | 하루 2~3회 (예: 09·13·20시). PC가 켜져 있는 시간에만 |
| 신청 | Telegram에서 승인하면 Aside가 제출한다 |
| 리뷰 | 네이버 블로그. Aside가 **임시저장까지만** 하고, 발행은 내가 직접 누른다 |
| 내 프로필 | 레포의 설정 파일(관심 카테고리, 제외 키워드, 블로그 소개, 신청 문구 톤) |
| 실행 구조 | 클라우드(Railway)와 로컬(Windows PC)로 역할을 나눈다 |
| 코드 위치 | 이 레포에 파이프라인을 하나 더 추가한다 (별도 패키지로 분리하지 않음) |
| MVP | 수집 → 선별 → Telegram 알림 + 신청 문구 초안. 제출은 수동으로 한다 |

## 2. 전제 확인 결과

- **Aside**는 Aside Computer(YC F25)의 Chromium 기반 AI 브라우저다. 로그인된 세션 그대로 에이전트가 페이지를 조작한다. 이 PC에는 브라우저(`C:\Program Files\Aside`, 1.0.928.2)만 설치되어 있고 **`aside` CLI는 아직 PATH에 없다**.
  - CLI: `aside "<작업>"`(에이전트 세션), `aside --session <id> "..."`, `aside exec -m <model>`, `aside repl "<js>"`(결정적 브라우저 조작, 예: `openTab(url)`), `aside mcp`(MCP 서버), `aside account list|use|status`.
  - Windows CLI는 PowerShell 설치 스크립트(`install.ps1`, Authenticode 서명 검증)로 설치한다. 개발자 설정 화면에서도 설치할 수 있다.
  - **문서에 없는 것:** REPL에서 쓸 수 있는 함수 목록, 반환값과 출력 형식(JSON 여부), `aside exec`의 전체 옵션. Phase 0에서 `aside --help`로 확인한다.
  - 게시·결제·메시지 같은 민감한 행동은 기본적으로 사용자 승인을 기다린다. 무인 실행 시 이 설정이 어떻게 동작하는지 확인이 필요하다.
  - 요금: Free 월 500크레딧, Pro 월 $20. 본인 API 키나 Claude 구독을 연결할 수도 있다.
- **Aside는 카카오톡 PC 앱을 읽을 수 없다.** 카톡은 웹 버전이 없어서, 카톡 수집은 Windows UI 자동화로 따로 만든다. Aside는 레뷰와 네이버 블로그만 맡는다.
- **워커는 Railway에서 돈다** (`docs/operations.md`). 카톡과 Aside는 이 PC에서만 돌 수 있으므로 로컬 역할이 필요하다.

## 3. 전체 구조

```
[로컬 PC · WORKER_ROLE=local]                     [Railway · WORKER_ROLE=cloud (지금 워커)]
 kakao-collect (cron 09·13·20)                      campaign-rank  → LLM 선별 (chatJson)
   카톡방 읽기 → 레뷰 링크 추출 → campaigns 행          campaign-review → Telegram 공고 카드
 campaign-fetch {campaignId}                          버튼: 신청 승인 / 패스 / 신청함(수동)
   Aside로 상세 페이지 읽기 → 조건 파싱               campaign-remind → 마감 리마인더
 campaign-apply {campaignId}        (Phase 2)        Telegram polling은 여기서만
 campaign-check-selection (daily)   (Phase 3)
 blog-draft-save {campaignId}       (Phase 4)
                 \                                   /
                  └──── 같은 Supabase Postgres + pg-boss 큐 ────┘
```

- 두 워커는 같은 DB와 pg-boss를 쓴다. 큐마다 `work()`를 등록하는 쪽이 정해져 있어서, 로컬 전용 큐는 PC가 켜져 있을 때만 처리된다. PC가 꺼져 있으면 job은 대기하고, cron 큐는 `singleton` 정책이라 쌓이지 않는다.
- **Telegram polling은 클라우드에서만 한다** (두 곳에서 polling하면 409 Conflict). 로컬 워커는 `reviewer.start()`를 부르지 않는다. 알림을 보내야 하면 `sendMessage`만 쓴다 (polling과 충돌하지 않음).
- 마이그레이션은 클라우드 워커만 실행한다.
- **`campaigns` 행이 상태의 기준이다.** Threads `posts`와 같은 원칙이다. 신청·임시저장처럼 외부에 흔적이 남는 단계는 `claim_seq` 토큰으로 행을 선점하고, 재시도해도 두 번 제출하지 않게 만든다.

### 상태 흐름

```
DISCOVERED (카톡에서 링크 발견)
  → DETAILED (Aside로 상세 파싱) / UNREADABLE
  → SHORTLISTED / SKIPPED (LLM 선별 + 규칙 필터: 배송형만, 제외 키워드, 신청 마감 지남)
  → PENDING_REVIEW (Telegram 카드 발송)
  → APPROVED → APPLYING → APPLIED      (MVP는 "신청함" 버튼으로 바로 APPLIED)
  → SELECTED / NOT_SELECTED            (Phase 3)
  → DRAFTING → DRAFT_REVIEW → DRAFT_SAVED → POSTED   (Phase 4)
  거절·만료: REJECTED / EXPIRED
```

## 4. 코드 배치

이 레포에 추가한다. 기존 모듈은 그대로 재사용한다.

| 재사용 | 용도 |
|---|---|
| `src/db/pool.ts`, `src/db/migrate.ts`, `migrations/` | `014_campaigns.sql`부터 이어서 추가 |
| `src/jobs.ts` (`createBoss`, `alertOnFinalFailure`, `Q`) | 큐 등록을 역할별로 나눈다 |
| `src/llm/openrouter.ts` (`chatJson`) | 상세 파싱, 선별, 신청 문구, 리뷰 초안 |
| `src/review/telegram.ts` (`Reviewer`, 봇, 채팅 필터) | 체험단 카드와 버튼 |
| `src/lib/url.ts` (`urlHash`), `src/lib/time.ts` | 링크 중복 차단, 마감일 계산 |
| `src/config.ts` | 새 환경변수 |

새로 만드는 것:

```
src/campaigns/
  kakao-links.ts     카톡 텍스트 → 레뷰 캠페인 URL 추출·정규화 (순수 함수, 단위 테스트)
  revu.ts            레뷰 상세 → 구조화 (DOM 텍스트를 chatJson + zod 스키마로)
  rank.ts            규칙 필터 + LLM 선별
  prompts.ts         선별·신청 문구·리뷰 초안 프롬프트 (한국어)
  profile.ts         campaign-profile.json 로드·zod 검증
  store.ts           campaigns 상태 전이 (조건부 UPDATE)
  telegram.ts        체험단 카드 포맷과 callback 파싱 (camp:<id>:<action>:<rev>)
src/kakao/
  reader.ts          PowerShell 스크립트 호출, 결과 파싱
  read-room.ps1      카톡방 창 열기 → 대화 영역 복사 → stdout
src/aside/
  client.ts          BrowserAgent 인터페이스 + AsideCliAgent + DryRunAgent
config/campaign-profile.json
```

- `src/review/telegram.ts`는 이미 673줄이다. 체험단 버튼 처리를 직접 넣지 않고, 봇 라우터에서 `camp:` prefix만 `src/campaigns/telegram.ts`의 핸들러로 넘긴다. 명령어는 `message:text` 핸들러보다 먼저 등록한다 (CLAUDE.md 참고).
- `src/worker.ts`는 `WORKER_ROLE`에 따라 큐 등록, Telegram polling, 마이그레이션을 나눈다. 기본값은 `cloud`라서 지금 배포는 그대로 동작한다.
- `BrowserAgent`는 `ThreadsApi` / `DryRunThreadsClient`와 같은 방식이다. `ASIDE_DRY_RUN=true`이면 실제로 제출·저장하지 않고 할 일만 로그로 남긴다.

### 새 환경변수 (안)

| 키 | 기본값 | 설명 |
|---|---|---|
| `WORKER_ROLE` | `cloud` | `cloud` / `local` |
| `KAKAO_ROOMS` | (없음) | 읽을 카톡방 이름, 쉼표 구분 |
| `KAKAO_COLLECT_CRON` | `0 9,13,20 * * *` | 로컬 수집 주기 |
| `ASIDE_BIN` | `aside` | CLI 경로 |
| `ASIDE_ACCOUNT` | (없음) | `--account`로 넘길 계정 |
| `ASIDE_DRY_RUN` | `false` | 제출·저장 없이 기록만 |
| `CAMPAIGN_DAILY_MAX` | `5` | 하루 Telegram으로 보낼 공고 최대 개수 |

### 프로필 파일 `config/campaign-profile.json`

```json
{
  "blog": { "url": "https://blog.naver.com/...", "topic": "개발자 일상·IT 제품", "tone": "담백한 1인칭" },
  "types": ["delivery"],
  "interests": ["IT 액세서리", "생활용품", "식품"],
  "excludeKeywords": ["다이어트 보조제", "주류"],
  "minRewardWon": 20000,
  "applyMessage": { "maxChars": 300, "points": ["사진 퀄리티", "실사용 후기"] }
}
```

배송지 같은 개인정보는 넣지 않는다 (레뷰 계정에 이미 있음). 규칙 필터(`types`, `excludeKeywords`, `minRewardWon`, 마감일)는 코드로 먼저 걸러서 LLM 호출을 줄이고, 나머지 판단은 LLM이 한다. 승인·패스 기록은 `style.ts`처럼 선별 프롬프트에 최근 예시로 넣는다 (Phase 1 후반).

## 5. 단계별 계획

### Phase 0 · 스파이크 (반나절~1일, 코드 머지 없음)

불확실한 부분을 먼저 확인한다. 결과는 이 문서 9절에 적는다.

1. **Aside CLI 설치와 출력 확인**
   - PowerShell 설치 스크립트로 CLI를 설치하고 `aside --help`, `aside repl --help`를 저장한다.
   - `aside repl "const p = await openTab('<레뷰 캠페인 URL>'); ..."`로 페이지 텍스트를 stdout으로 받을 수 있는지, 출력이 JSON인지 확인한다.
   - 로그인된 기본 프로필을 쓰는지, 브라우저 창이 닫혀 있을 때도 동작하는지 확인한다.
   - 무인 실행 중 승인 대기(게시·제출) 설정이 어떻게 동작하는지 확인한다.
2. **레뷰 데이터 경로**
   - 캠페인 URL 패턴과 ID 추출 규칙을 확인한다.
   - 상세 페이지가 내부 JSON API로 데이터를 받는지 개발자 도구로 본다. 있으면 REPL 안의 `fetch`로 받는 게 DOM 파싱보다 안정적이다.
   - 신청 폼 필드(신청 메시지, SNS 선택, 옵션 등)를 기록한다.
3. **카톡 PC 읽기**
   - 방 이름으로 창을 찾고, 대화 영역에서 `Ctrl+A`, `Ctrl+C`로 클립보드에 복사하는 방식이 되는지 확인한다.
   - 복사된 텍스트 형식(`[이름] [오후 1:23] 내용`, 날짜 구분선)과 몇 개 메시지까지 로드되는지 본다.
   - 화면 잠금 상태에서는 동작하지 않는 것을 확인하고 운영 조건에 적는다.
4. **판정:** 세 가지가 모두 되면 Phase 1로 간다. 카톡 읽기가 불안정하면 "대화 내보내기 txt를 CLI로 가져오기"를 대체 입력으로 쓴다.

### Phase 1 · MVP: 수집 → 선별 → Telegram 알림

**목표:** 카톡방에 올라온 레뷰 배송형 공고 중 프로필에 맞는 것만, 신청 문구 초안과 함께 Telegram으로 받는다. 신청은 내가 직접 한다.

1. `014_campaigns.sql`
   - `kakao_messages(hash pk, room, sent_at_text, body, seen_at)`: 이미 본 메시지 재처리 방지
   - `campaigns(id, source, external_id, url, url_hash unique, title, type, category, reward_won, recruit_count, apply_deadline, announce_at, review_deadline, detail jsonb, status, score, reason, apply_message, review_message_id, revision, claim_seq, attempts, created_at, updated_at)`
   - `unique(source, external_id)`
2. `src/campaigns/kakao-links.ts` + 테스트: 카톡 텍스트에서 `revu.net` 링크를 뽑고, 단축 URL과 쿼리를 정규화해 캠페인 ID를 얻는다.
3. `src/kakao/read-room.ps1` + `reader.ts`: 방마다 텍스트를 읽고, 메시지 단위로 해시해서 새 것만 넘긴다. 방 하나가 실패해도 다른 방은 계속한다 (`collectAll`과 같은 격리).
4. `src/aside/client.ts`: `readPage(url): Promise<string>`부터 만든다. `execFile`로 CLI를 호출하고 타임아웃(90초)과 stderr 로그를 남긴다.
5. `src/campaigns/revu.ts`: 상세 텍스트를 `chatJson` + zod로 구조화한다(유형, 제공 내역, 금액, 모집 인원, 신청 마감, 발표일, 리뷰 마감, 필수 키워드). 읽지 못하면 `UNREADABLE`로 두고 재시도하지 않는다 (`SkipTopicError`와 같은 원칙). 일시 오류는 재시도한다.
6. `src/campaigns/rank.ts`: 규칙 필터를 적용하고, 남은 후보를 한 번의 LLM 호출로 평가한다. 상위 `CAMPAIGN_DAILY_MAX`개만 `SHORTLISTED`로 둔다. 같은 호출에서 신청 문구 초안도 만든다.
7. Telegram 카드: 제목, 제공 내역, 금액, 마감일(D-n), 선별 이유, 신청 문구, 레뷰 링크. 버튼은 `✅ 신청함`(→ APPLIED, 수동 신청 완료 기록), `🙅 패스`(→ REJECTED, 이유 버튼), `✏️ 문구 수정`(답장으로 수정) 세 개다. 카드도 `review_revision`처럼 `revision`으로 오래된 버튼을 막는다.
8. 큐: 로컬 `kakao-collect`, `campaign-fetch`. 클라우드 `campaign-rank`, `campaign-review`. 마지막 시도 실패는 `alertOnFinalFailure`로 알린다.
9. CLI: `campaign:collect`(카톡 읽기 1회), `campaign:add <url>`(링크 직접 추가, Telegram `/camp <url>`도 같은 동작), `campaign:show <id>`.
10. `/status`에 체험단 단계별 개수를 추가한다.

**완료 기준**
- 카톡방에 레뷰 링크가 올라오고 다음 수집 주기 안에 카드가 온다. 같은 링크가 다시 올라와도 카드는 한 번만 온다.
- 방문형과 제외 키워드 공고는 카드가 오지 않는다 (`campaign:show`에 사유가 남음).
- `npm run typecheck`, `npm run lint`, `npm test`가 통과한다. 링크 추출, 규칙 필터, 상태 전이는 단위 테스트로 검증하고, 중복 차단과 revision 검사는 통합 테스트로 검증한다.

### Phase 2 · 승인 후 자동 신청

1. 카드에 `🚀 신청 승인` 버튼을 추가한다 → `APPROVED` → 로컬 `campaign-apply` 큐.
2. `campaign-apply`는 `APPLYING`으로 선점(`claim_seq`)한 다음 Aside로 신청 폼을 채우고 제출한다.
   - 결정적인 단계(페이지 열기, 필드 채우기)는 REPL로 하고, 폼이 예상과 다를 때만 에이전트 모드(`aside "<작업>"`)로 넘긴다. 에이전트 모드는 크레딧과 비결정성 비용이 크다.
   - 제출 직전 소유권을 다시 확인한다. 제출 후에는 레뷰 "신청 내역"에서 신청 여부를 확인해야 `APPLIED`로 바꾼다. 응답을 잃어도 다음 시도는 먼저 신청 내역을 보고 판단한다 (Threads `decideAfterFailure`와 같은 원칙).
   - 스크린샷을 남기고 Telegram 결과 메시지에 첨부한다.
3. 3회 실패하면 `FAILED`로 바꾸고, 수동 신청 링크와 `재시도` 버튼을 보낸다.
4. 처음에는 `ASIDE_DRY_RUN=true`로 일주일 운영하고 로그를 확인한 다음 켠다.

**완료 기준:** 승인한 공고가 레뷰 신청 내역에 한 번만 나타난다. 같은 job을 두 번 돌려도 중복 신청이 없다.

### Phase 3 · 선정 확인과 일정 관리

1. 로컬 `campaign-check-selection` (매일 1회): Aside로 레뷰 마이페이지를 읽어서 신청한 캠페인의 선정 여부를 반영한다 (`SELECTED` / `NOT_SELECTED`).
2. 선정되면 Telegram으로 알린다. 리뷰 마감일과 필수 키워드, 가이드를 요약해 보낸다.
3. 클라우드 `campaign-remind` (매일 09시): 리뷰 마감 D-3, D-1, 당일, 그리고 "제품 받았나요?" 확인 질문을 보낸다. 버튼은 `📦 받음`, `📝 초안 쓰기`다.
4. `/camps` 명령: 진행 중인 체험단과 마감일을 정렬해서 보여준다.

### Phase 4 · 네이버 블로그 리뷰 초안 → 임시저장

1. Telegram에서 선정된 캠페인 카드에 사진 여러 장과 메모(사용 소감)를 답장으로 보낸다.
   - 클라우드 워커는 Telegram `file_id`만 저장한다. 로컬 워커가 파일을 받아 `%LOCALAPPDATA%\content-autopilot\photos\<campaignId>\`에 저장한다 (Aside가 업로드하려면 로컬 파일이 필요함).
2. LLM이 레뷰 가이드(필수 키워드, 분량, 사진 수)와 내 메모를 근거로 초안을 쓴다. 메모와 가이드에 없는 사용 경험은 지어내지 않는다 (Threads의 "본문에 있는 사실만" 원칙과 같음).
3. **광고 표기를 코드로 맨 앞에 넣는다** (공정위 추천·보증 심사지침: 경제적 대가를 받았다는 사실을 첫머리에 표시). LLM이 쓰게 두지 않고, 빠질 수 없게 한다. CTA를 코드로 붙이는 방식과 같다.
4. Telegram으로 초안을 검수한다(승인 / 수정 답장 / 재생성) → 로컬 `blog-draft-save`가 Aside로 네이버 블로그 에디터를 열고, 본문과 사진을 넣고, **임시저장만** 한다. 발행 버튼은 누르지 않는다.
5. 내가 발행한 다음 Telegram에 블로그 URL을 보내면 `POSTED`로 바꾼다. 레뷰에 URL을 등록하는 일은 Phase 5 후보로 둔다.

**완료 기준:** 네이버 블로그 임시저장함에 초안 1개가 사진과 함께 생기고, 광고 표기가 맨 위에 있다.

## 6. 문서와 규칙 갱신

구현 PR마다 같이 고친다.

- `CLAUDE.md`: "MVP는 Threads만" 문장을 고치고, 체험단 파이프라인, `WORKER_ROLE`, 로컬 큐를 Architecture에 추가한다.
- `docs/decisions.md`: 체험단 파이프라인 추가, 클라우드·로컬 분리, 카톡은 UI 자동화(Aside 아님), 신청과 발행에 사람의 승인 단계를 둔 이유를 적는다.
- `docs/architecture.md`: 상태 흐름과 큐를 추가한다.
- `docs/setup.md`: Aside CLI 설치(Windows), 레뷰·네이버 로그인, 카톡방 이름 설정을 추가한다.
- `docs/operations.md`: 로컬 워커 실행법(작업 스케줄러로 로그인 시 시작), PC와 화면 잠금 조건, 문제 해결을 추가한다.

## 7. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| **카카오 약관:** 비공식 자동화 프로그램은 금지 대상이라 계정 제재 가능성이 있다 | 읽기만 한다. 메시지를 보내지 않는다. 하루 2~3회만 읽는다. 문제가 생기면 "대화 내보내기 txt" 입력으로 바꾼다 |
| **레뷰 약관:** 매크로 신청을 제한할 수 있다 | 공고마다 내가 승인하고, 양을 하루 몇 건으로 제한한다. Phase 2 전에 약관을 확인한다 |
| 화면 잠금이나 PC 꺼짐 상태에서는 카톡과 Aside가 동작하지 않는다 | 로컬 큐는 다음에 PC가 켜지면 처리된다. `/status`에 로컬 워커의 마지막 heartbeat를 표시한다 |
| 레뷰 DOM이 바뀜 | 상세 파싱을 LLM 구조화로 해서 셀렉터에 덜 의존한다. 내부 JSON API가 있으면 그걸 쓴다 |
| Aside가 새 제품이라 CLI가 자주 바뀜 | `BrowserAgent` 인터페이스 뒤에 숨긴다. 버전을 고정하고, `aside --update`는 수동으로 한다 |
| Aside 크레딧 소진 | REPL 위주로 짜고, 에이전트 모드는 예외 경로에서만 쓴다. Claude 구독이나 API 키 연결을 검토한다 |
| 중복 신청과 중복 임시저장 | `campaigns` 행 선점, 제출 전 재확인, 제출 후 신청 내역 대조 (Threads 발행과 같은 모델) |
| 리뷰 진정성 | 내 메모와 사진에 근거한 초안만 만든다. 광고 표기는 코드로 강제하고, 발행은 직접 한다 |
| 개인정보 | 프로필에 배송지와 연락처를 넣지 않는다. Aside 인증 파일(`~/.aside/cli/auth.json`)은 커밋하지 않는다 |

## 8. 일정 (대략)

| 단계 | 예상 |
|---|---|
| Phase 0 스파이크 | 0.5~1일 |
| Phase 1 MVP | 3~4일 |
| Phase 1 운영 (선별 품질 조정) | 1주 |
| Phase 2 자동 신청 | 2~3일 + dry-run 1주 |
| Phase 3 일정 관리 | 1~2일 |
| Phase 4 블로그 임시저장 | 3~4일 |

## 9. 스파이크 결과 (Phase 0에서 채움)

- Aside CLI 버전, `--help` 요약:
- REPL 출력 형식:
- 레뷰 캠페인 URL·ID 규칙, 내부 API 유무:
- 레뷰 신청 폼 필드:
- 카톡 복사 텍스트 형식, 로드되는 메시지 수:
- 결정 (Phase 1 진행 / 대체 경로):
