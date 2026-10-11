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
| chain | `src/pipeline/chain.ts` | 글에 답글 조각(`post_parts`, idx 2·3)이 있으면 본글이 발행된 뒤 `publish-chain` job이 조각을 순서대로 발행한다. 각 조각은 `reply_to_id`로 바로 앞 조각에 다는 답글이다. 조각마다 본글과 같은 방식으로 선점한다. `claim_seq`가 소유 토큰이고, `container_id`를 발행 전에 저장하고, `threads_publish` 직전에 소유권을 다시 확인한다. 그래서 재시도해도 같은 조각이 두 번 올라가지 않는다. 10분 넘게 `PUBLISHING`인 조각은 이어받는다. 발행 응답이 유실돼 media id를 모르면 `/me/threads`, `/me/replies`의 최근 글에서 본문이 정확히 같은 것을 찾는다. 예약 시각 이후의 글만 보고, 답글은 `replied_to`가 바로 앞 조각인 것만 본다. `replied_to`나 시각이 빠진 항목은 확인할 수 없으므로 후보로 치지 않고, 후보가 둘 이상이어도 고르지 않고 실패한 시도로 센다. 다른 글 밑의 같은 문구 답글에 잘못 이어 붙이지 않기 위해서다. 조각당 최대 3번 시도하고 그래도 실패하면 `FAILED`로 두고 Telegram으로 알린다. 이 알림은 재시도 버튼이 달린 유일한 복구 경로라서, Telegram 장애에도 다시 보내도록 별도 `chain-alert` job(최대 5번 재시도)으로 보낸다. 전송에 성공해야 `post_parts.alerted_at`을 기록하고, 기록이 없는 실패는 `publish-due`가 5분마다 다시 알림 job에 넣는다. 그래서 실패를 기록한 직후 워커가 죽어도 알림이 사라지지 않는다. 알림 큐는 `exclusive`라 장애가 길어져도 글당 알림 job은 하나뿐이고, 보내기 직전에 아직 알릴 실패가 남았는지 다시 확인한다. 본글은 그대로 남는다. 출처 링크와 CTA의 위치는 `composeChain`이 정한다. 링크는 마지막 답글(답글이 없으면 본글), CTA는 마지막 답글에만 붙는다. CTA를 붙여 500자를 넘으면 발행 시점에 뺀다. 생성은 `THREAD_CHAIN_ENABLED`가 켜져 있을 때만 답글을 만들지만, 이미 조각이 있는 글은 이 값과 관계없이 연결 글로 발행한다. |
| replies | `src/pipeline/replies.ts` | `poll-replies` job(5분마다, policy `singleton`, `retryLimit: 0`)이 최근 48시간 안에 발행된 글(`dry-` id 제외)의 최상위 답글을 `GET /{media-id}/replies`로 가져온다. 내가 쓴 답글과 숨김 처리된 답글은 건너뛴다. 답글 id가 primary key인 `threads_replies`(`010`)에 `on conflict do nothing`으로 넣으므로 새 답글만 알림 대상이 된다. 답글 목록은 최신순으로 첫 페이지만 읽는다. 알림은 `notify_claimed_at`으로 먼저 원자적으로 선점한 뒤 보내고, 전송에 실패하면 선점을 풀어 다음 주기에 다시 보낸다. 보낸 메시지의 id와 `notified_at`은 전송이 끝난 뒤 함께 저장한다. 선점한 채로 프로세스가 죽으면 10분 뒤 선점이 만료돼 다시 알린다(알림이 빠지는 것보다 한 번 더 오는 쪽을 택했다). 사람이 그 알림 메시지에 **답장**하면 `message:text` 핸들러가 검수 로직보다 먼저 `answerReply`를 호출한다. `answer_state`를 `null → ANSWERING`으로 원자적으로 선점해서 더블 탭이나 재시도로 같은 답글에 두 번 달지 않는다(답글당 1회). 답글은 `reply_to_id`가 붙은 일반 텍스트 발행이고 500자 제한을 받는다. 발행은 글 발행과 같은 `driveContainer`로 컨테이너가 `FINISHED`가 될 때까지 기다리고, 발행 전에 `answer_container_id`를 저장한다. 실패하면 컨테이너를 다시 조회한다. `PUBLISHED`면 응답만 유실된 것이라 답글 완료로 처리하고, 발행되지 않은 게 확실하면 선점을 풀어 다시 답장할 수 있게 한다. 조회도 실패해 결과를 모르면 선점을 유지하고, 10분 뒤 만료되면 다음 답장 때 저장된 컨테이너를 먼저 확인한다. 토큰에 `threads_read_replies`, `threads_manage_replies` 권한이 필요하다. |

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
