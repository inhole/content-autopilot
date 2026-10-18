# 아키텍처

## 전체 흐름

```
                    ┌─────────────── worker (npm start) ───────────────┐
 RSS feeds ──▶ daily-pipeline (06:00 KST)                               │
               collect → rank ──▶ generate (주제당 1 job)                │
                                              │                         │
                                              ▼                         │
                                          review ──▶ Telegram ◀──▶ 사람  │
                                              │  승인 → 발행 시간 배정     │
                                              ▼                         │
               publish-due (5분마다) ──▶ publish ──▶ Threads API          │
                                         └─▶ publish-chain ──▶ 답글 조각 순서대로
               refresh-token (04:00) ──▶ Threads 토큰 갱신               │
               review-maintenance (매시) ──▶ 초안 만료 + 리마인더        │
               collect-insights (05:00) ──▶ 게시물 성과 스냅샷           │
               weekly-report (월 09:00) ──▶ 주간 리포트 Telegram        │
               poll-replies (5분마다) ──▶ 새 답글을 Telegram으로 알림    │
                    └──────────────────────────────────────────────────┘
                                       │
                               Supabase Postgres
                     (topics, posts, platform_accounts, pgboss.*)
```

프로세스는 워커 하나다. 스케줄, 재시도, 큐는 모두 pg-boss가 Postgres 위에서 처리한다. 큐 정의는 `src/jobs.ts` 한 곳에 있다.

## 단계별 동작

| 단계 | 코드 | 하는 일 |
|---|---|---|
| collect | `src/pipeline/collect.ts` | `sources`의 RSS를 읽어 48시간 이내 글만 `topics`에 넣는다. 정규화한 URL의 sha256(`url_hash`)으로 중복을 막는다. 상대 링크는 피드 주소 기준으로 해석한다. URL이 잘못된 항목은 그 항목만 건너뛰고(`skipped`), 피드 하나가 실패해도 나머지 피드는 계속한다. |
| rank | `src/pipeline/rank.ts` | 먼저 48시간이 지난 `COLLECTED` 주제를 `SKIPPED`로 정리한다. 그다음 후보 최대 100개와 최근 14일 동안 다룬 주제 목록을 함께 LLM에 넘겨, 한 번의 호출로 0~10점 평가와 중복 판정(`duplicate_of`)을 같이 한다. 응답에 모든 후보가 정확히 한 번씩 들어 있지 않으면(`validateScores`) DB에 쓰기 전에 실패시켜 재시도한다. 중복이 아닌 것 중 상위 `DAILY_POST_COUNT`개만 `SHORTLISTED`, 나머지는 `SKIPPED`. |
| generate | `src/pipeline/generate.ts`, `sources.ts`, `style.ts` | 근거 자료를 모아(`gatherSources`) 그 내용만 근거로 초안 JSON(`text`, `angle`, `topic_tag`, `caveats`)을 만든다. GeekNews 토픽은 페이지의 원문 링크(`topic-title-link`)를 따라가 **원문 본문**을 근거로 쓰고, GeekNews 요약은 참고 자료로만 넘긴다. 링크 카드(`source_url`)도 원문을 가리킨다. HN 기사는 `discussion_url`로 상위 댓글 5개를 가져와 "개발자 반응"으로 넘긴다. 댓글은 의견이라 사실의 근거로 쓰지 않는다. 여기에 문체 학습 조각(`style.ts`)을 붙인다. 승인된 글 예시(직접 수정한 글 우선), 최근 첫 줄 목록, 최근 마지막 줄 목록, 최근 30일 폐기 사유 지침이다. 모델이 500자를 넘기면 같은 모델로 450자 이내 축약을 한 번 요청한다(`draftPost`). daily는 이번에 고른 주제뿐 아니라 **초안이 없는 모든 `SHORTLISTED` 주제**를 등록하므로, 등록 중에 장애가 나도 다음 실행에서 복구된다. 큐는 `generate-v2`(policy `singleton`, 주제별로 한 번에 하나씩 실행)다. 이름을 바꾸기 전의 `generate` 큐 작업은 직접 실행하지 않고 `generate-v2`로 넘긴다. 최초 생성은 이미 있는 초안을 그대로 쓰고, 덮어쓰지 않는다. 재생성은 요청할 때마다 `regen_seq`를 올리고, **가장 최근 요청의 결과만** 저장된다. 그래서 실패 후 재시도된 이전 피드백이 더 나중 결과를 덮어쓰지 못한다. 기사 서버의 429·5xx·타임아웃은 재시도하고, 404·403이나 본문이 없는 경우에만 주제를 건너뛴다. |
| review | `src/review/telegram.ts` | 초안, 관점, 확인할 점, 출처를 Telegram으로 보낸다. 버튼은 승인 / 재생성 / 폐기. 연결 글이면 메시지 하나에 [1/3] [2/3] [3/3]을 글자 수와 함께 보여주고, `수정2:`·`삭제2` 같은 답장으로 조각을 고친다(operations.md). 버튼은 그 글의 **최신 검수 메시지**에서, 그 메시지가 보여준 본문 버전(`review_revision = revision`)일 때만 동작한다. 재생성이나 `수정:`으로 본문이 바뀌면 `revision`이 올라가서 이전 메시지의 버튼은 무효가 된다. 메시지를 보내는 사이에 본문이 바뀌면 그 메시지는 등록하지 않는다. 새 검수 메시지를 보내면 이전 메시지의 버튼은 지운다. |
| approve | `src/pipeline/publish.ts` | `PUBLISH_SLOTS` 중 아직 비어 있는 가장 빠른 시간을 `scheduled_at`으로 정한다. 같은 시간대는 DB unique 인덱스(`003_unique_publish_slot.sql`)로 한 글만 가질 수 있다. 동시 승인으로 충돌하면 다른 시간대로 다시 고른다. Telegram 승인은 검수자가 본 `revision`을 함께 넘기고, 그 사이 본문이 바뀌었으면 승인이 거부된다. |
| publish | `src/pipeline/publish.ts` | 컨테이너 생성 → `FINISHED` 대기 → `threads_publish`. 출처 URL은 `link_attachment`로 붙인다. |
| chain | `src/pipeline/chain.ts` | 글에 답글 조각(`post_parts`, idx 2·3)이 있으면 본글이 발행된 뒤 `publish-chain` job이 조각을 순서대로 발행한다. 각 조각은 `reply_to_id`로 바로 앞 조각에 다는 답글이다. 조각마다 본글과 같은 방식으로 선점한다. `claim_seq`가 소유 토큰이고, `container_id`를 발행 전에 저장하고, `threads_publish` 직전에 소유권을 다시 확인한다. 그래서 재시도해도 같은 조각이 두 번 올라가지 않는다. 10분 넘게 `PUBLISHING`인 조각은 이어받는다. 발행 응답이 유실돼 media id를 모르면 `/me/threads`, `/me/replies`의 최근 글에서 본문이 정확히 같은 것을 찾는다. 예약 시각 이후의 글만 보고, 답글은 `replied_to`가 바로 앞 조각인 것만 본다. `replied_to`나 시각이 빠진 항목은 확인할 수 없으므로 후보로 치지 않고, 후보가 둘 이상이어도 고르지 않고 실패한 시도로 센다. 다른 글 밑의 같은 문구 답글에 잘못 이어 붙이지 않기 위해서다. 빠진 id는 원래 다음 조각을 달 때만 찾으므로, 연결 글 발행이 끝나거나 멈출 때 마지막으로 올라간 조각의 id도 찾아 둔다. 그래도 못 찾으면 답글 알림 기간(48시간) 동안 `publish-due`가 그 글을 다시 넣어 찾는다. id가 있어야 그 조각에 달린 독자 답글을 읽을 수 있다. 조각당 최대 3번 시도하고 그래도 실패하면 `FAILED`로 두고 Telegram으로 알린다. 이 알림은 재시도 버튼이 달린 유일한 복구 경로라서, Telegram 장애에도 다시 보내도록 별도 `chain-alert` job(최대 5번 재시도)으로 보낸다. 전송에 성공해야 `post_parts.alerted_at`을 기록하고, 기록이 없는 실패는 `publish-due`가 5분마다 다시 알림 job에 넣는다. 그래서 실패를 기록한 직후 워커가 죽어도 알림이 사라지지 않는다. 알림 큐는 `exclusive`라 장애가 길어져도 글당 알림 job은 하나뿐이고, 보내기 직전에 아직 알릴 실패가 남았는지 다시 확인한다. 본글은 그대로 남는다. 출처 링크와 CTA의 위치는 `composeChain`이 정한다. 링크는 마지막 답글(답글이 없으면 본글), CTA는 마지막 답글에만 붙는다. CTA를 붙여 500자를 넘으면 발행 시점에 뺀다. 생성은 `THREAD_CHAIN_ENABLED`가 켜져 있을 때만 답글을 만들지만, 이미 조각이 있는 글은 이 값과 관계없이 연결 글로 발행한다. |
| replies | `src/pipeline/replies.ts` | `poll-replies` job(5분마다, policy `singleton`, `retryLimit: 0`)이 최근 48시간 안에 발행된 글(`dry-` id 제외)과 그 글의 발행된 답글 조각마다 최상위 답글을 `GET /{media-id}/replies`로 가져온다. 어느 조각에 달렸는지는 `threads_replies.part_idx`(`013`, 본글이면 null)에 남기고 알림에 `[2/3]`처럼 표시한다. 내가 쓴 답글과 숨김 처리된 답글은 건너뛴다. 답글 id가 primary key인 `threads_replies`(`010`)에 `on conflict do nothing`으로 넣으므로 새 답글만 알림 대상이 된다. 답글 목록은 최신순으로 첫 페이지만 읽는다. 알림은 `notify_claimed_at`으로 먼저 원자적으로 선점한 뒤 보내고, 전송에 실패하면 선점을 풀어 다음 주기에 다시 보낸다. 보낸 메시지의 id와 `notified_at`은 전송이 끝난 뒤 함께 저장한다. 선점한 채로 프로세스가 죽으면 10분 뒤 선점이 만료돼 다시 알린다(알림이 빠지는 것보다 한 번 더 오는 쪽을 택했다). 사람이 그 알림 메시지에 **답장**하면 `message:text` 핸들러가 검수 로직보다 먼저 `answerReply`를 호출한다. `answer_state`를 `null → ANSWERING`으로 원자적으로 선점해서 더블 탭이나 재시도로 같은 답글에 두 번 달지 않는다(답글당 1회). 답글은 `reply_to_id`가 붙은 일반 텍스트 발행이고 500자 제한을 받는다. 발행은 글 발행과 같은 `driveContainer`로 컨테이너가 `FINISHED`가 될 때까지 기다리고, 발행 전에 `answer_container_id`를 저장한다. 실패하면 컨테이너를 다시 조회한다. `PUBLISHED`면 응답만 유실된 것이라 답글 완료로 처리하고, 발행되지 않은 게 확실하면 선점을 풀어 다시 답장할 수 있게 한다. 조회도 실패해 결과를 모르면 선점을 유지하고, 10분 뒤 만료되면 다음 답장 때 저장된 컨테이너를 먼저 확인한다. 토큰에 `threads_read_replies`, `threads_manage_replies` 권한이 필요하다. |

## 상태

```
topics:  COLLECTED ─▶ SHORTLISTED ─▶ USED
            │  └────▶ SKIPPED
            └───────▶ DUPLICATE

posts:   PENDING_REVIEW ─▶ SCHEDULED ─▶ PUBLISHING ─▶ PUBLISHED
           │ │  ▲  ▲          │                │
           │ │  │  └ 예약 취소 ┘                └─▶ SCHEDULED (재시도) ─▶ FAILED (3회 실패)
           │ │  └ 재생성 / 수정
           │ └─▶ REJECTED
           └───▶ EXPIRED (48시간 동안 손대지 않음, review-maintenance)
```

## 중복 발행 방지

발행의 기준은 job이 아니라 `posts` 행이다.

1. **행을 선점한다.** `publishPost`는 `UPDATE … SET status='PUBLISHING', attempts = attempts + 1, claim_seq = claim_seq + 1 WHERE status='SCHEDULED'`로 행을 잡는다. 이 업데이트에 성공한 워커만 진행한다.
2. **선점마다 소유 토큰을 쓴다.** 선점할 때 증가한 `claim_seq` 값이 토큰이다. `attempts`는 `publish-now`가 0으로 되돌리기 때문에 토큰으로 쓰지 않는다. 이후의 모든 UPDATE(컨테이너 저장, 완료, 실패)는 `status='PUBLISHING' and claim_seq = 토큰` 조건을 단다. 멈춰 있던 워커가 10분 뒤 깨어나 보니 다른 워커가 행을 이어받았다면, 토큰이 맞지 않아 아무것도 쓰지 못하고 발행도 하지 않는다.
3. **컨테이너 ID를 먼저 저장한다.** 컨테이너를 만들자마자 `container_id`를 저장하고, publish 직전에 소유권을 한 번 더 확인한다. 이 확인은 heartbeat 역할도 한다.
4. **재시도는 저장된 컨테이너부터 이어간다.** 컨테이너 상태가 `PUBLISHED`면 이미 올라간 것으로 보고 끝낸다. `EXPIRED`나 `ERROR`면 새 컨테이너를 만든다. 컨테이너를 만들 때 보낸 내용(본문·링크·주제 태그)의 지문을 `container_fingerprint`(`012`)에 함께 저장한다. 실패한 뒤 「예약 취소」하고 고친 글처럼 지금 보낼 내용과 지문이 다르면, 예전 컨테이너는 이미 올라갔는지만 확인하고 아니면 새로 만든다. 그래서 고치기 전 글이 발행되지 않는다.
5. **job 자체는 재시도하지 않는다.** `publish` 큐는 `retryLimit: 0`이다. 실패하면 행을 `SCHEDULED`로 되돌리고, 5분 뒤 `publish-due`가 그 행을 다시 찾아 시도한다. 3번 실패하면 `FAILED`로 바꾸고 Telegram으로 알린다.
6. **실패로 확정하기 전에 컨테이너를 다시 본다.** 응답만 유실되고 실제로는 발행된 경우가 있어서, 실패하면 컨테이너 상태를 다시 조회한다. `PUBLISHED`면 `PUBLISHED`로 기록한다. 상태 조회까지 실패하면 결과를 알 수 없는 것으로 보고 최대 6번까지 재시도한 뒤 `FAILED`로 확정한다(`decideAfterFailure`).
7. **멈춘 행은 이어받는다.** 워커가 죽어 `PUBLISHING`에서 10분 넘게 멈춘 행은 다음 sweep이 이어서 처리한다.

이 로직은 `test/publish.test.ts`가 검증한다.

## 중복 판정

같은 URL은 수집 단계에서 `url_hash` unique로 걸러진다. 그 밖의 중복은 rank의 LLM이 판정한다.
- **후보끼리 같은 사건이면** 정보가 가장 풍부한 하나만 남긴다. 한국어 요약과 영어 원문처럼 언어가 달라도 마찬가지다.
- **최근 14일 동안 이미 다룬 주제와 같은 사건이면** 제외한다.

처음에는 임베딩 유사도(pgvector)로 중복을 걸렀다. 그런데 GeekNews 한국어 요약과 HN 영어 원문은 같은 기사여도 유사도가 0.37~0.63밖에 나오지 않았다. 다른 기사와 구분할 수 있는 기준값을 정할 수 없어서 임베딩 방식은 제거했다 (`migrations/002_drop_embedding.sql`).

LLM이 잘못된 id나 자기 자신을 가리키면 `resolveDuplicates`가 그 표시를 무시한다. 중복 참조가 순환하면(A→B, A→B→C→A 등 길이와 관계없이) 그 안에서 점수가 가장 높은 하나를 대표로 남긴다. 그래서 같은 사건이 통째로 사라지는 일은 없다.

## 데이터

| 테이블 | 내용 |
|---|---|
| `sources` | 수집할 RSS 목록. 새 피드는 여기에 행을 추가하면 된다. `MANUAL`은 직접 입력한 주제용이다. |
| `topics` | 수집한 글, 점수, 중복 대상(`duplicate_of`), 상태. `/add`로 넣은 주제는 작성자 의견(`note`)을 가진다(`005`). HN 항목은 토론 링크(`discussion_url`, `007`)를 가진다. |
| `posts` | 초안과 발행 상태. `(topic_id, platform)`이 unique라 재생성하면 같은 행이 갱신된다. `revision`(본문 버전)·`review_revision`(검수 메시지가 보여준 버전), `regen_seq`(최근 재생성 요청 순번), `claim_seq`(발행 소유 토큰)는 경합을 막기 위한 컬럼이다(`004_post_revisions.sql`). `reject_reason`은 폐기 사유이고 문체 학습에 쓰인다(`008`). |
| `post_parts` | 연결 글의 답글 조각(`011`). 본글은 `posts`에 있고 1번째 조각이다. `(post_id, idx)`가 primary key이고 idx는 2 또는 3이다. 상태는 `PENDING` / `PUBLISHING` / `PUBLISHED` / `FAILED`. `claim_seq`(소유 토큰), `container_id`, `platform_post_id`, `attempts`, `last_error`를 조각마다 가진다. |
| `platform_accounts` | Threads 토큰과 만료 시각 |
| `post_insights` | 발행한 글의 Threads 성과 스냅샷(조회·좋아요·답글·리포스트·인용·공유). 수집할 때마다 행이 쌓이고 리포트는 글별 최신 행을 쓴다. 값이 null이면 Threads가 주지 않은 지표다(`009`). 연결 글도 본글만 수집한다. 리포트는 답글 조각이 있는 글과 없는 글의 평균 조회·답글을 비교한다. |
| `pgboss.*` | pg-boss가 관리하는 큐와 스케줄 |

## 프롬프트

프롬프트는 `src/pipeline/prompts.ts`에 있다. 계정 소개는 모든 프롬프트가 공유하고, 그 아래에 단계별 지시가 붙는다. 생성 규칙의 핵심은 세 가지다.
- 기사 본문에 있는 사실만 쓴다.
- 자기 말로 요약한다.
- 개발자 관점의 해석을 하나 이상 넣는다.

남의 글을 모아서 올리기만 하는 계정은 노출에서 불리하다. 이 세 규칙이 그걸 피하는 장치다.

## 체험단 파이프라인

레뷰 체험단 공고를 카카오톡에서 모아 신청하고, 선정되면 일정을 챙기고, 블로그 후기 초안을 임시저장한다. Threads 파이프라인과 같은 Postgres와 pg-boss를 쓰지만 워커가 둘이다(결정 9~13).

```
 [로컬 PC · WORKER_ROLE=local]                    [Railway · WORKER_ROLE=cloud]
  kakao-collect (09·13·20시)                       campaign-rank ──▶ 규칙 필터 + LLM 선별
    카톡방 읽기 → 레뷰 링크 → campaigns               └─▶ campaign-card ──▶ Telegram 카드 ◀──▶ 사람
  campaign-fetch ──▶ Aside로 상세 읽기 + LLM 구조화    campaign-rewrite  신청 문구 재작성
  campaign-sweep (5분마다)                          blog-draft        후기 초안 (메모·사진 근거)
    heartbeat, 신청·저장 대기분, 멈춘 DISCOVERED        campaign-maintenance (매시)
  campaign-apply ──▶ 레뷰 신청                         만료 + 리마인더(09~21시만)
  campaign-selection (10·19시) ──▶ 선정 확인           Telegram polling은 여기서만
  blog-save ──▶ 네이버 임시저장
                 └──────── 같은 Postgres + pg-boss 큐 ────────┘
```

두 역할 모두 모든 체험단 큐와 스케줄을 만들지만(멱등) `work()`는 자기 큐에만 등록한다. PC가 꺼져 있으면 로컬 큐의 job은 대기한다. 마이그레이션은 클라우드만 실행한다.

### 큐

| 큐 | 역할 | 하는 일 |
|---|---|---|
| `kakao-collect` | local | `KAKAO_COLLECT_CRON`(기본 `0 9,13,20 * * *`)마다 `KAKAO_ROOMS`를 읽는다. 방 하나가 실패해도 다른 방은 계속한다. 새 메시지에서 레뷰 링크를 뽑아 `campaigns`(`DISCOVERED`)에 넣고 `campaign-fetch`를 보낸다. |
| `campaign-fetch` | local | Aside로 상세 페이지를 읽고 `chatJson`으로 구조화해 `DETAILED`로 바꾼다. 본문을 읽지 못하면 `UNREADABLE`로 두고 재시도하지 않는다. 일시 오류는 재시도한다. 끝나면 `campaign-rank`를 요청한다. |
| `campaign-rank` | cloud | 마감 지난 것·방문형·제외 키워드 같은 규칙을 코드로 먼저 걸러 `SKIPPED`(`skip_reason`)로 두고, 남은 후보를 한 번의 LLM 호출로 평가한다. 상위 `CAMPAIGN_DAILY_MAX`개를 `SHORTLISTED`로 두고 신청 문구 초안을 만든다. fetch가 끝난 뒤에 도는 stately 큐다. |
| `campaign-card` | cloud | `SHORTLISTED`를 `PENDING_REVIEW`로 바꾸고 Telegram 카드를 보낸다. |
| `campaign-rewrite` | cloud | 카드에 단 피드백으로 신청 문구를 다시 쓴다. |
| `campaign-sweep` | local | 5분마다 heartbeat를 기록하고, 신청 대기(`APPROVED`, 멈춘 `APPLYING`)와 저장 대기(`DRAFT_APPROVED`, 멈춘 `DRAFT_SAVING`)를 각 큐에 넣고, 30분 넘게 `DISCOVERED`인 것을 다시 fetch한다. |
| `campaign-apply` | local | `retryLimit: 0`. 실패하면 행이 `APPROVED`로 돌아가고 sweep이 다시 찾는다. |
| `campaign-selection` | local | 10:00, 19:00에 레뷰 마이페이지를 읽어 선정 여부를 반영한다. |
| `campaign-maintenance` | cloud | 매시 신청 마감이 지난 `PENDING_REVIEW`를 `EXPIRED`로 바꾸고, 리마인더를 보낸다(09~21시에만). |
| `blog-draft` | cloud | 메모·사진·가이드로 후기 초안을 쓴다. 요청할 때 `regen_seq`를 올려서 가장 최근 요청의 결과만 저장한다. |
| `blog-save` | local | 승인된 초안을 네이버 블로그에 임시저장한다. |

### 상태

```
공고:  DISCOVERED ─▶ DETAILED ─▶ SHORTLISTED ─▶ PENDING_REVIEW ─▶ APPROVED ─▶ APPLYING ─▶ APPLIED
          │             │             │              │  │  │          ▲          │            │ │
          └▶ UNREADABLE └▶ SKIPPED    │              │  │  └▶ APPLIED (직접 신청함 버튼)  └▶ APPLY_FAILED
                                      │              │  └▶ REJECTED (패스)      └── 재시도 버튼 ──┘  │
                                      └▶ EXPIRED ◀───┘  (신청 마감 지남)             APPLIED ─▶ SELECTED / NOT_SELECTED

후기:  SELECTED ─▶ RECEIVED (📦 받음, 건너뛸 수 있음) ─▶ DRAFT_REVIEW ─▶ DRAFT_APPROVED ─▶ DRAFT_SAVING ─▶ DRAFT_SAVED ─▶ POSTED
                                                         │  ▲                ▲                 │  │
                                                         └──┘ 재생성·수정     └── 재시도 ────────┘  └▶ DRAFT_FAILED
```

- `DRAFT_REVIEW`는 `SELECTED`나 `RECEIVED`에서 `📝 초안 쓰기`로 들어간다. 사진과 메모를 답장으로 받은 뒤에 초안이 만들어진다.
- `APPLY_FAILED`는 Telegram 재시도 버튼으로 `APPROVED`에 돌아간다(`attempts` 초기화). `DRAFT_FAILED`도 같다.
- `POSTED`는 `/posted <id> <블로그 주소>`로 기록한다. `DRAFT_SAVED`에서만 가능하다.

### 신청과 임시저장은 행을 선점한다

`posts` 발행과 같은 모델이다(`src/campaigns/apply.ts`, `blog-save.ts`).

1. `UPDATE … SET status='APPLYING'(또는 'DRAFT_SAVING'), attempts = attempts + 1, claim_seq = claim_seq + 1`로 행을 잡는다. 올린 `claim_seq`가 소유 토큰이다.
2. 이후 모든 쓰기는 `status`와 `claim_seq = 토큰` 조건을 단다. 선점을 잃은 워커는 아무것도 쓰지 않는다.
3. 브라우저에서 돌이킬 수 없는 일을 하기 직전에 소유권을 한 번 더 확인한다(heartbeat 겸용).
4. **신청:** 제출 전에 레뷰의 신청 내역(`status=request`)과 선정 내역(`accepted`)을 먼저 본다. 응답을 잃어 이미 신청된 경우 다시 제출하지 않는다. 제출 뒤에도 스크립트의 답을 믿지 않고 목록으로 확인해야 `APPLIED`가 된다. 로그인이 풀려 있으면 즉시 `APPLY_FAILED`(`레뷰 로그인이 필요해요`)다.
5. 3번 시도해도 안 되면 `APPLY_FAILED`/`DRAFT_FAILED`로 두고 Telegram에 재시도 버튼을 보낸다. 10분 넘게 멈춘 `APPLYING`/`DRAFT_SAVING`은 이어받는다.
6. 임시저장은 결과를 알 수 없을 때(타임아웃, 결과 줄 없음) 재시도하므로 임시저장 글이 중복될 수 있다. 임시저장은 발행이 아니라서 허용한다.
7. **드라이런(`ASIDE_DRY_RUN=true`):** 읽기는 하지만 제출·저장 스크립트는 실행하지 않는다. 신청은 `APPLY_FAILED`(`드라이런: 제출하지 않음`), 저장은 `DRAFT_FAILED`(`드라이런: 저장하지 않음`)로 끝난다. `APPROVED`로 되돌리면 sweep이 5분마다 반복하기 때문이다. 직접 신청하거나, 드라이런을 끈 뒤 재시도 버튼을 누른다.

### 카카오톡 읽기

Aside는 카카오톡 PC 앱을 읽을 수 없어서 `src/kakao/read-room.ps1`이 읽는다. 방 이름과 같은 제목의 창을 찾아(없으면 메인 창 검색으로 연다) 대화 영역에서 `Ctrl+A`, `Ctrl+C`로 복사하고 클립보드를 stdout으로 출력한다. 읽기만 하고 입력창에는 쓰지 않는다. 종료 코드: 0 성공, 2 화면 잠김, 3 카카오톡 창 없음, 4 방을 찾지 못함, 5 복사된 것 없음, 1 기타. `src/kakao/reader.ts`가 복사 텍스트(`[이름] [오후 1:23] 내용`)와 대화 내보내기 형식을 파싱하고, 메시지별 해시를 `kakao_messages`에 기록해 이미 본 메시지를 건너뛴다.

### Telegram

- 카드 버튼: `✅ 신청함 (직접)` → `APPLIED`, `🚀 신청 승인 (자동)` → `APPROVED`, `🙅 패스` → 사유 버튼 → `REJECTED`. callback은 `camp:<action>:<id>:<revision>`이고 카드에 보인 `revision`과 같을 때만 동작한다. 신청 문구가 바뀌면 `revision`이 올라간다.
- 카드 답장: `수정: <문구>`는 신청 문구를 그대로 교체하고, 그 외는 피드백으로 보고 다시 쓴다.
- 선정되면 🎉 알림(리뷰 마감, 키워드, 가이드 요약)과 `📝 초안 쓰기` 버튼이 온다. 3일이 지나도 `RECEIVED`가 아니면 `📦 받음` 확인이 온다. 리뷰 마감은 D-3(2~3일 전), D-1, 당일에 알리고 같은 종류는 한 번만 보낸다(`campaign_reminders`).
- `📝 초안 쓰기` → 접수 메시지가 오면 그 메시지에 사진(여러 장)과 사용 메모를 답장한다. 메모를 보내면 초안을 만든다. 초안 카드는 `✅ 승인 (임시저장)`, `🔁 재생성` 버튼을 가지며, 답장 `수정: <본문>`, `제목: <제목>`은 그대로 교체하고 그 외는 수정 요청으로 재생성한다. 빠진 필수 키워드는 카드에 경고로 보인다.
- 명령: `/camp <링크>`, `/camps`(진행 중 목록, 마감순), `/posted <id> <블로그 주소>`. `/status`에 체험단 단계별 개수와 로컬 워커의 마지막 heartbeat가 나온다.
- 핸들러는 `createReviewer`의 `extend` 훅으로 등록한다. 기존 검수 `message:text` 핸들러보다 먼저 실행되고, 자기 것이 아닌 답장은 `next()`로 넘긴다.

### 광고 표기

프로필(`config/campaign-profile.json`)의 `disclosure` 한 줄을 코드가 모든 블로그 초안의 맨 앞에 붙인다(결정 13). 모델이 첫머리에 같은 취지의 문단을 써도 걷어내고 코드의 문구만 남긴다. `수정:` 답장으로 본문을 바꿔도 맨 앞에 다시 붙는다.

### 체험단 데이터

| 테이블 | 내용 |
|---|---|
| `campaigns` | 공고 한 건의 모든 상태(`014`). `(source, external_id)`와 `url_hash`가 unique. 파싱한 상세(`detail` jsonb와 `type`, `reward_won`, 마감일 등), 선별(`score`, `reason`, `skip_reason`, `apply_message`), 카드(`revision`, `review_message_id`, `review_revision`, `reject_reason`), 선점(`claim_seq`, `attempts`, `last_error`, `screenshot_path`), 후기(`intake_message_id`, `memo`, `draft_title`, `draft_body`, `regen_seq`, `blog_url`)를 가진다. |
| `kakao_messages` | 이미 읽은 카톡 메시지의 해시(primary key)와 방 이름 |
| `campaign_photos` | 후기용 사진. Telegram `file_id`를 저장하고, 로컬 워커가 `local_path`로 내려받는다(Aside는 디스크 파일을 올린다). |
| `campaign_reminders` | 보낸 리마인더(`selected`, `received-check`, `review-d3`/`d1`/`d0`). `(campaign_id, kind)`가 primary key라 한 번만 간다. |
| `worker_heartbeats` | 로컬 워커의 마지막 응답 시각. `/status`에 보인다. |
