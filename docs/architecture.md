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
               review-maintenance (매시) ──▶ 초안 만료·예고 + 리마인더   │
               collect-insights (05:00) ──▶ 게시물 성과 스냅샷           │
               weekly-report (월 09:00) ──▶ 주간 리포트 Telegram        │
               poll-replies (5분마다) ──▶ 새 답글을 Telegram으로 알림    │
               revive-check / revive (/revive) ──▶ 상록 만료 초안 재검수 │
               weekly-digest (일 18:00) ──▶ 만료 초안 묶음 연결 글        │
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
           └───▶ EXPIRED (48시간 동안 손대지 않음, review-maintenance. 만료 24시간 전에 ⏳ 예고를 한 번 보낸다)
                    ├─▶ PENDING_REVIEW (상록 판정 후 /revive로 재검수, origin = revived)
                    └─▶ (주간 묶음 글의 재료, digest_post_id 기록. 원래 글은 EXPIRED 그대로)
```

## 만료 초안 다시 쓰기

검수를 못 해서 만료된 초안을 버리지 않고 두 가지로 다시 쓴다(결정 14, `016`). `posts.origin`이 글이 어디서 왔는지를 남기고(`news` / `revived` / `digest`), 검수 메시지 맨 위에 `♻️ 재활용` / `🗞 주간 묶음` 라벨로 보인다.

- **상록 초안 재검수** (`src/pipeline/revive*.ts`)
  - `/revive`(또는 CLI `revive`)를 실행하면 `revive-check` job이 지난 30일 안에 만료된 뉴스 초안을 판정한다. 대상은 아직 재활용하지 않았고 묶음에도 쓰이지 않은 초안이다. 판정은 LLM 한 번 호출로 한다. 몇 주 뒤에 읽어도 가치가 있으면 `evergreen`(사용법, 연구 결과, 설계 교훈, 관행에 대한 의견), 그 시점에 묶였으면 `stale`(출시·버그·장애·가격·행사 소식)이다. 애매하면 `stale`로 본다.
  - 판정 결과는 `revive_verdict` / `revive_reason` / `revive_checked_at`에 한 번만 저장하고, 목록 메시지를 보낸다. 상록 초안마다 `♻️ #id 살리기` 버튼이 있다.
  - 버튼을 누르면 `revive` job(글마다 하나씩)이 LLM으로 **시점에 묶인 표현을 고치고 말투를 새 반말로 바꿔 쓴다**("방금", "이번 주", "최근 나온" 같은 표현. 결정 7). 사실, 수치, 첫 줄의 아이디어는 그대로 둔다. 옛 글의 "다들 ~함?" 같은 형식적인 마지막 질문은 빼도 된다.
  - 고친 글은 조건부 UPDATE 하나로 저장된다. 조건은 아직 `EXPIRED`이고 재활용·묶음에 쓰이지 않았을 것이다. 상태는 `PENDING_REVIEW`, `origin`은 `revived`가 되고 `revision`이 오른다. 그다음 재시도가 있는 `review` 큐로 검수 메시지를 보낸다.
  - `generation.text`도 새 글로 바꾸고(`generation.prompt_version`은 2) 원래 글은 `generation.revived.from_text`에 남긴다. `style.ts`가 `generation->>'text' <> text`를 "주인이 고친 글"로 보고 말투를 배우기 때문에, LLM이 고친 글을 주인의 수정으로 오인하지 않게 하려는 것이다. 답글 조각은 그대로 둔다.
- **주간 "이번 주 놓친 소식"** (`src/pipeline/digest*.ts`)
  - `weekly-digest` job(일요일 18:00, `/digest`로 바로 실행)이 지난 10일 안에 만료된 뉴스 초안을 모은다. 재활용·묶음에 쓰이지 않았고 `revive_verdict`가 없거나 `stale`인 것이 대상이다. 상록 초안은 따로 살리도록 남겨 둔다.
  - 주제 점수 순으로 최대 3개를 고른다. 2개 미만이면 만들지 않는다.
  - LLM이 연결 글 하나로 엮는다. 본글은 묶음 소개 훅과 1번 소식을 담고(질문으로 끝낼 필요 없음), 답글 2개가 2·3번 소식이다. 사실은 원래 초안에 있던 것만 쓴다.
  - 한 트랜잭션 안에서 묶음용 주제(MANUAL, `이번 주 놓친 소식 (YYYY-MM-DD)`), 글(`origin = digest`), 조각을 만들고 재료 초안에 `digest_post_id`를 기록한다. 재료를 2개 이상 선점하지 못하면 통째로 되돌린다. 그래서 같은 초안이 두 묶음에 들어가지 않는다.
  - 검수 메시지는 `review` 큐로 보낸다. 글을 저장한 뒤 큐에 넣기 전에 워커가 죽으면 잡을 재시도해도 소용이 없다(재료는 이미 선점됐다). 그래서 매시 `review-maintenance`가 검수 메시지 없이 10분 넘게 멈춘 `PENDING_REVIEW` 초안을 다시 `review` 큐에 넣는다(`loadUnsentReviews`). 이 복구 잡은 실행하는 순간에 아직 검수 메시지가 없을 때만 보낸다(`ifUnsent`, `isUnsentReview`). `review` 큐는 기본 정책이라 대기 중인 원래 잡과 중복을 막지 못하고, 검수 메시지를 두 번 보내면 앞 메시지의 버튼이 무효가 되기 때문이다. 일반 초안 생성과 재활용에도 같은 복구가 적용된다. `수정2:`·`삭제2`로 조각을 고치면 각 조각의 링크도 그 조각을 따라간다. 🔁 재생성과 피드백 답장은 평소처럼 generate job으로 가지만, 묶음 글의 주제면 `regenerateDigest`가 같은 재료로 다시 쓴다(`regen_seq` 조건은 같다).
  - **링크:** 출처가 소식마다 달라서 조각마다 자기 링크를 단다(`post_parts.link_url`). 본글은 1번 소식의 `source_url`, 답글은 각자 `link_url`이다. 조각 중 하나라도 `link_url`이 있으면 "출처는 마지막 답글에" 규칙(결정 8)을 쓰지 않는다. CTA는 그대로 마지막 답글에만 붙는다.

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

체험단은 출처가 둘이다. **카카오톡 선물하기**와 **무신사 프리유저**는 둘 다 공개 목록을 읽어 모아 고르고, 신청·결과·리뷰 기한을 챙기고, 리뷰 초안을 쓴다. Threads 파이프라인과 같은 Postgres, pg-boss, 같은 클라우드 워커를 쓴다. 선물하기 신청과 리뷰 작성은 카카오톡 모바일 앱에서만, 무신사는 PC에서 한다. 코드는 둘 다 하지 않는다. 내가 직접 하고 Telegram 버튼으로 기록한다([결정 9](decisions.md#9-체험단-출처는-카카오-선물하기-공개-목록이다), [결정 10](decisions.md#10-신청과-리뷰는-사람이-하고-버튼으로-기록한다)). 무신사 목록도 로그인 없이 읽히는 공개 API다. 로그인이 필요한 건 신청뿐이라, 자동 신청은 나중에 Aside로 한다([결정 13](decisions.md#13-무신사-체험단-목록은-공개-api라-클라우드에서-읽는다)). 계획과 검증 현황은 [plans/campaign-autopilot.md](plans/campaign-autopilot.md)에 있다.

```
 gift.kakao.com 공개 목록 (page 33325)          musinsa.com/preuser 공개 API
        │  gift-collect (09·15·21시)                    │  musinsa-collect (10·16·22시)
        │                                               │  새 공고만 상세(발표일·리뷰 기간) 추가
        ▼                                               ▼
  campaigns COLLECTED ◀──────────────────────────────────┘
        │
        ▼
        규칙 필터 ──▶ LLM 점수(출처별, 60건씩) ──▶ 출처마다 하루 상위 N개 SHORTLISTED
                                                              │ campaign-card
                                                              ▼
        Telegram 사진 카드 ◀──▶ 사람: 선물하기는 폰 카톡, 무신사는 PC에서 열어 신청 → ✅ 신청함
        (경쟁률, D-n, 버튼)            결과 확인 → 🎉 선정 / 😢 미선정
                                      /due 로 리뷰 기한 알림
                                      📝 리뷰 초안 쓰기 → 메모 답장
                                                │ review-draft
                                                ▼
                                  초안 메시지 + 조작 메시지 ──▶ 복사해 선물하기·무신사에 올림 → ✅ 리뷰 올림
 campaign-maintenance (매시): 마감 지난 카드 만료 + 리마인더(09~21시만)
```

### 큐

모두 `src/campaigns/jobs.ts`에 있고, 클라우드 워커 하나가 전부 처리한다(큐와 스케줄은 멱등으로 만든다). 로컬 워커 역할은 없다.

| 큐 | 하는 일 |
|---|---|
| `gift-collect` | `GIFT_COLLECT_CRON`(기본 `0 9,15,21 * * *`)마다 공개 목록을 읽어 `campaigns`에 upsert하고, `COLLECTED`를 선별해 뽑힌 만큼 카드를 보낸다. `stately`, 재시도 1회(10분 뒤). 클라우드. |
| `musinsa-collect` | `MUSINSA_COLLECT_CRON`(기본 `0 10,16,22 * * *`)마다 무신사 공개 목록을 읽어 `campaigns`에 upsert하고(새 공고는 상세도 읽는다), `COLLECTED`를 선별해 뽑힌 만큼 카드를 보낸다. `stately`, 재시도 1회(10분 뒤). |
| `campaign-rank` | 예전 큐다. 지금은 아무것도 쌓지 않는다(두 수집 job이 직접 선별한다). 이미 쌓인 job이 있을 때를 위해 처리기만 남겨 두었다. `stately`, 재시도 1회. |
| `campaign-card` | 카드를 Telegram에 보낸다(이미지가 있으면 사진 카드). `exclusive`, 재시도 3회. 같은 체험단은 `singletonKey`로 한 번만 쌓인다. |
| `review-draft` | 메모로 리뷰 초안을 쓰고 두 메시지를 보낸다. 체험단당 하나씩(`singleton`), 재시도 2회(backoff). |
| `campaign-maintenance` | 매시 정각. 신청 마감이 지난 카드를 `EXPIRED`로 만들고 키보드를 지운 뒤, 09~21시에는 리마인더를 보낸다. 재시도 없음. |

마지막 시도까지 실패하면 수집(선물하기·무신사), 선별, 카드 전송, 리뷰 초안 job이 Telegram으로 ❌ 알림을 보낸다.

### 수집: 선물하기

`src/campaigns/gift.ts`가 선물하기 체험단 탭(`GIFT_TRIAL_PAGE_ID`, 기본 33325)의 공개 JSON을 읽는다. 로그인이 필요 없다.

- 첫 페이지(`/v2/pages/<id>`)에 50건과 검색 조건이 있고, 나머지는 `/v1/pages/trial-campaign/collections?page=2,3,…`(24건씩)에서 `isLast`이거나 빈 목록이 나올 때까지 읽는다. 페이지 사이에 0.4초 쉬고, 최대 40페이지에서 멈춘다. 2026-10-18에 475건(19페이지)을 확인했다.
- 첫 페이지 실패는 에러로 끝난다. 이후 페이지 실패는 경고만 남기고 읽은 만큼만 쓴다. 필수 필드가 없는 등 형식이 예상과 다르면 조용히 넘어가지 않고 실패한다.
- **가격**: upsert 뒤에 공개 상품 API(`GET https://gift.kakao.com/a/product-detail/v3/products/<상품 ID>`, 모바일 UA)에서 `price.basicPrice`(정가)와 `price.sellingPrice`(판매가)를 읽어 `detail.price = { basic, selling }`로 저장한다(`fillGiftPrices`). 새 행과, 아직 `COLLECTED`이면서 가격이 없는 행이 대상이고, 0.3초 간격으로 한 번에 최대 150건만 읽는다. 실패는 경고만 남기고 수집을 막지 않으며, 실패한 행은 `detail.priceTriedAt`을 남겨 6시간 안에는 다시 읽지 않는다. 선별은 가격 읽기를 아직 시도하지 않은 행(`awaitingPrice`)을 `COLLECTED`로 남겨 두므로, 상한에 걸린 행은 가격 없이 한 번에 탈락하지 않고 다음 수집 때 가격을 받은 뒤 선별된다. 읽기에 실패한 행은 가격을 모르는 채로 선별한다. 목록 갱신은 `detail`을 덮어쓰지 않고 합치므로 저장한 가격이 지워지지 않는다. 가격은 선별 규칙(`minPriceWon`), 선별 프롬프트, 카드(`정가 49,000원`, 판매가가 더 낮으면 `→ 39,200원`), 대시보드 목록·상세에 쓰인다.
- 제목, 브랜드, 이미지, 상품 ID, 모집·신청 인원, 남은 일수를 `campaigns`에 넣고 원본 항목은 `detail`(jsonb)에 둔다. 링크는 `https://gift.kakao.com/giftbox/trial-campaign/<campaignId>`다.
- upsert는 `(source, external_id)`가 같으면 목록에서 온 필드와 `last_seen_at`만 갱신한다. 상태, 점수, 내가 기록한 값, `updated_at`은 건드리지 않는다. 그래서 몇 번을 돌려도 같은 결과다.
- **신청 마감은 추정이다.** 목록에는 남은 일수만 있어서, 오늘(KST)에 남은 일수를 더한 날의 끝(23:59:59)을 `apply_deadline`으로 둔다. 실제 마감 시각과 일수 계산 방식은 확인하지 못했다. 카드와 대시보드에는 `(추정)`으로 표시한다.
- 상세 페이지는 로그인이 필요해서 읽지 않는다. 선별은 목록의 공개 정보로만 한다([결정 11](decisions.md#11-선별은-공개-정보만으로-한다)).

### 수집: 무신사

`src/campaigns/musinsa.ts`가 무신사 체험단 목록(`musinsa.com/preuser/main`이 쓰는 공개 JSON)을 읽는다. 로그인이 필요 없다. `influencer.musinsa.com/api2/mcmp/...`는 로그인이 필요한 다른 시스템(크리에이터 캠페인)이고 처음에 이것을 잘못 읽었다([결정 13](decisions.md#13-무신사-체험단-목록은-공개-api라-클라우드에서-읽는다)).

- **목록** (`GET https://www.musinsa.com/preuser/api/v1/event/events?page=N&size=100`): 페이지는 1부터이고 `size`는 100까지 받는다. 응답의 `hasNext`가 false이거나 `content`가 비면 끝이다. 페이지 사이에 0.3초 쉬고 최대 20페이지에서 멈춘다. 선물하기와 같은 규칙이다: 첫 페이지 실패는 에러, 이후 페이지 실패는 경고만 남기고 읽은 만큼 쓰며, 429·5xx·네트워크 오류는 한 번 재시도한다(`src/campaigns/http.ts`). `state`가 `OPEN`인 것만 쓴다. 2026-10-19에 352건, 4페이지를 확인했다.
- **upsert** (`collectMusinsaCampaigns`): 선물하기와 같은 규칙이다. 새 행은 `COLLECTED`, 기존 행은 목록 필드와 `last_seen_at`만 갱신하고 상태, 점수, 내가 기록한 값, `updated_at`은 건드리지 않는다. `external_id`는 이벤트 `id`, 링크는 `https://www.musinsa.com/preuser/events/<id>`, 제목은 `name`, 브랜드는 `brand.name`, 모집·신청 인원은 `recruitmentCount`·`applicantsCount`, 상품 ID는 대표 상품의 `uniqueId`다. 마감 `endDate`는 날짜만 있어서 그날 끝(KST 23:59:59.999)을 `apply_deadline`으로 둔다. 날짜는 정확한 값이라 `(추정)`을 붙이지 않는다. 그날 안에서 닫히는 시각은 알 수 없다. 목록 항목은 `detail`(jsonb)에 들어가고, 기존 행은 목록 항목을 기존 `detail` 위에 합쳐서 상세에서 얻은 값이 지워지지 않는다.
- **상세** (`GET /event/events/:id`): 새로 만들어진 행에만 읽는다(0.3초 간격). 품목(`eventCategory`), 발표일(`winnerDrawDate`), 배송일, 리뷰 시작·마감일(`reviewStartDate`, `reviewEndDate`), 최소 회원 등급, 옵션 이름을 `detail`에 합친다. 상세 읽기가 실패해도 경고만 남기고 수집은 계속된다. 품목 이름은 `/event/filters`의 id를 한국어로 옮긴 표(`musinsaCategoryLabel`)로 보여 주고, 모르는 값은 id 그대로 보여 준다.
- **선정 시 리뷰 마감**: 무신사 공고를 `🎉 선정`으로 기록하면 `review_deadline`이 비어 있을 때 `detail.reviewEndDate`의 그날 끝(KST)으로 채워진다. `/due`로 바꾸면 그 값이 우선한다.
- **신청은 아직 사람이 한다**: 신청, 내 신청 내역 API는 로그인과 무신사 프리유저 가입이 있어야 쓸 수 있고, 가입은 스냅을 한 번이라도 올려야 한다(`MCMP_001_006 작성한 스냅이 있는 회원만 신청할 수 있습니다`). 그때까지는 카드 링크를 PC에서 열어 직접 신청하고 `✅ 신청함`으로 기록한다. 가입 뒤에는 옵션을 고르는 Telegram 버튼과, 내가 로그인한 브라우저(Aside)로 하는 자동 신청을 붙일 계획이다([plans/campaign-autopilot.md](plans/campaign-autopilot.md)).

### 선별

`src/campaigns/rank.ts`. `COLLECTED` 전부가 대상이다.

1. **규칙(코드)**: `config/campaign-profile.json`의 `excludeKeywords`(제목·브랜드), `excludeBrands`, `maxCompetition`(신청자 ÷ 모집 인원, 없으면 제한 없음), `minPriceWon`(정가가 이보다 낮으면 `가격 낮음: 14,900원`, 정가를 모르면 건너뛰지 않는다)과 마감이 지난 것은 점수를 매기기 전에 `SKIPPED`로 보내고 `skip_reason`을 남긴다.
2. **규칙 점수(`CAMPAIGN_RANK_MODE=rule`, 기본값)**: `ruleScore`가 LLM 없이 후보마다 0~10점과 이유를 만든다. 출처마다 따로 매기지만 공식은 같다.
   - **경쟁률 5점**: 신청자 ÷ 모집 인원을 로그 눈금으로 본다. 1:1 이하면 5점, 3,000:1 이상이면 0점이다(2026-10-24 실측: 선물하기 18~2,466:1, 중앙값 693, 무신사 약 50~2,200:1). 인원을 모르면 2.5점이다.
   - **정가 3점**: 1만 원~30만 원을 로그 눈금으로 본다. 1만 원 이하는 0점, 30만 원 이상은 3점이고, 정가를 모르면 1점(3만 원 정도)이다.
   - **관심 2점**: 제목, 브랜드, 무신사 품목 이름에 프로필의 `preferKeywords`나 `interests` 단어가 들어 있으면 2점이다(대소문자 무시, 부분 일치).
   - 이유는 `경쟁률 53:1 · 정가 115,000원 · 관심 키보드`처럼 남고, 뽑히지 않으면 `선별 탈락: <이유>`가 된다. 규칙 점수는 모든 후보에 점수를 주므로, 한도 안에서 안 뽑힌 후보는 전부 `SKIPPED`가 된다.
3. **LLM(`CAMPAIGN_RANK_MODE=llm`, `LLM_RANK_MODEL`)**: 2 대신 쓴다. 남은 후보를 출처별로 나눠 60건씩 `chatJson`으로 0~10점과 한 줄 이유를 받는다. 출처마다 시스템 프롬프트(`rankSystem(source)`)가 다르고, 무신사 후보에는 선물하기와 같은 모집·신청 인원(경쟁률)에 더해 품목, 정가(할인가가 더 낮으면 함께), 상품 개수가 들어간다. 두 출처 모두 후보 줄에 정가(할인가)가 들어가고, 프롬프트는 다른 조건이 비슷하면 정가가 높은 제품에 더 높은 점수를 주라고 한다(가격을 모르는 후보는 가감하지 않는다). 프롬프트에는 프로필(소개, 관심사)과 최근 신청한 체험단·패스한 체험단(사유 포함) 10개씩이 들어간다.
4. **하루 한도**: 점수 순으로 하루(KST) 남은 한도(`CAMPAIGN_DAILY_MAX`, 기본 5)만큼 `SHORTLISTED`가 된다. 한도는 **출처마다 따로** 센다. 선물하기가 5개를 채워도 무신사는 별도로 5개까지 뽑힌다. 오늘 이미 뽑힌 수는 선별된 시각 `shortlisted_at`(마이그레이션 `015`)으로 센다. `updated_at`은 매시 작업이 한 번도 뽑히지 않은 공고를 만료할 때도 바뀌어서 쓰지 않는다. 선별이 끝나면 이번에 뽑힌 것만이 아니라 `SHORTLISTED`로 남은 공고 전부에 카드를 보낸다. 앞선 실행에서 카드를 못 보낸 공고도 여기서 다시 나간다. 점수는 받았지만 뽑히지 않은 것은 `SKIPPED`(`선별 탈락: …`)다. 모델이 점수를 안 준 후보와, 한도를 다 쓴 날의 후보 전부는 `COLLECTED`로 남아 다음 수집 때 다시 평가된다.

### 상태

```
COLLECTED ──▶ SKIPPED            (규칙 또는 선별 탈락)
    └──▶ SHORTLISTED ──▶ PENDING_REVIEW (카드 전송) ──▶ REJECTED (🙅 패스 + 사유)
                               │  └──▶ EXPIRED (신청 마감 지남. COLLECTED·SHORTLISTED도 같음)
                               ▼
                            APPLIED (✅ 신청함) ──▶ SELECTED (🎉) ──▶ DRAFT_REVIEW ──▶ POSTED (✅ 리뷰 올림)
                                        └──▶ NOT_SELECTED (😢)
```

- 모든 전이는 `update … where status = … returning`이다. 이미 바뀌었으면 0행이라 아무 일도 하지 않는다. 중복 클릭과 오래된 버튼이 안전한 이유다.
- 카드 버튼(`✅`, `🙅` 계열)은 `PENDING_REVIEW`이고 `revision = review_revision =` 버튼의 revision일 때만 동작한다. 카드를 다시 보내면 이전 카드의 키보드는 지워진다. 결과 버튼(`🎉`/`😢`)과 `📝 리뷰 초안 쓰기`는 상태만 본다(revision 0).
- `markCardSent`는 카드를 보내는 사이 revision이 바뀌었으면 등록하지 않고 방금 보낸 카드의 키보드를 지운다.

### Telegram

- **카드**: 사진(`image_url`)에 `🎁 [카카오톡] #12 제목`, 브랜드, `모집 100명 · 신청 1,234명 (경쟁률 12.3:1)`, `마감 D-3 (추정)`, 점수와 이유를 캡션(1024자 이하)으로 보낸다. 이미지가 없으면 글로 보낸다. 버튼은 한 줄에 하나다: `📱 카카오톡에서 열기`(URL, `PUBLIC_BASE_URL`과 대시보드가 켜져 있으면 `/go/gift/<id>` 중계 페이지를 거쳐 카카오톡 앱으로 열리고, 아니면 gift.kakao.com을 직접 연다), `✅ 신청함`, `🙅 패스`. 무신사 카드의 열기 버튼은 `📱 무신사 앱에서 열기`이고 `https://link.musinsa.com/preuser/events/<번호>`로 간다. iOS에서는 무신사 앱으로 열리고, 앱이 없거나 PC면 `www.musinsa.com` 웹 페이지로 넘어간다(`campaigns.url`과 대시보드는 www 주소를 그대로 쓴다). 무신사 카드는 머리글이 `[무신사]`이고, 같은 경쟁률 줄 아래에 `패션 소품 · 정가 25,000원 → 14,990원 · 상품 N개`(품목, 정가와 더 낮은 할인가, 상품이 2개 이상일 때 개수)와 `발표 10/27(화) · 리뷰 10/31(토)~11/14(토)`가 나온다. 상세를 읽지 못한 공고는 해당 줄이 빠진다. 마감 줄의 `(추정)`은 선물하기에만 붙는다. 무신사 마감은 목록의 정확한 날짜다. 안내 문구는 `📱 무신사 앱이나 💻 PC에서 열어 신청한 뒤 ✅ 신청함을 눌러주세요`, 첫 버튼은 `💻 무신사에서 열기`다. 패스를 누르면 사유 버튼(관심 없는 품목, 경쟁률이 너무 높음, 브랜드·품질이 불안함, 기타, 취소)으로 바뀐다. 사유는 `reject_reason`에 남아 다음 선별 프롬프트에 들어간다.
- **신청 뒤**: `✅ 신청함`을 누르면 `APPLIED`로 기록하고 `🎉 선정` / `😢 미선정` 버튼 메시지를 보낸다. 선정이면 `/due`로 리뷰 기한을 알려 달라는 안내와 `📝 리뷰 초안 쓰기` 버튼이 온다.
- **명령**: `/camps`는 진행 중인 체험단을 단계(신청 대기, 결과 대기, 선정·리뷰 작성, 초안 검수)별로 보여준다. `/due <번호> <날짜>`는 리뷰 기한을 그날 23:59(KST)로 기록한다(`10/30`, `10-30`, `10.30`, `2026-10-30`. 이미 지난 날짜는 내년으로 본다). `APPLIED`, `SELECTED`, `DRAFT_REVIEW`에서만 된다. 기한을 다른 날짜로 바꾸면 이미 보낸 기한 리마인더(`review-*`) 기록을 지워서 새 날짜 기준으로 다시 알린다. `/status`에는 체험단 단계별 개수와 마지막 수집 시각, 출처별 진행 중 개수가 나온다. `/camps`의 각 줄에는 `[카카오톡]` / `[무신사]` 출처가 붙는다.
- callback data는 `camp:<action>:<id>:<revision>[:<arg>]`와 `rev:<action>:<id>:<revision>`이다(`callbacks.ts`, 64바이트 한도 안).
- 핸들러는 `createReviewer`의 `extend` 훅으로 등록한다. 기존 검수 `message:text` 핸들러보다 먼저 실행되고, 자기 것이 아닌 답장은 `next()`로 넘긴다.

### 리마인더

`src/campaigns/reminders.ts`. `campaign-maintenance`가 09~21시(KST)에만 보낸다. 같은 종류는 한 번만 간다(`campaign_reminders`의 `(campaign_id, kind)`). 먼저 행을 넣고(`on conflict do nothing`) 보내며, 보내기가 실패하면 행을 지워 다음 시간에 다시 시도한다.

| kind | 조건 | 내용 |
|---|---|---|
| `result-check` | `APPLIED`이고 (추정) 신청 마감에서 하루가 지남 | 결과가 나왔는지 묻고 `🎉`/`😢` 버튼을 준다 |
| `due-missing` | `SELECTED`가 된 지 하루가 지났는데 `review_deadline`이 없음 | `/due`로 알려 달라는 안내 |
| `review-d3` / `review-d1` / `review-d0` | `SELECTED`·`DRAFT_REVIEW`이고 리뷰 마감까지 3일 이내 / 1일 / 당일(달력 날짜 기준) | 마감 알림. `SELECTED`면 `📝 리뷰 초안 쓰기` 버튼이 붙는다 |

마감 알림은 그 시점에 가장 구체적인 종류 하나만 보낸다. 선정이 마감 하루 전에 났다면 뒤늦은 "3일 남음"은 가지 않는다.

### 리뷰 초안

`src/campaigns/review-draft.ts`, `review-telegram.ts`, `review-prompts.ts`.

1. `📝 리뷰 초안 쓰기`(`SELECTED`, `DRAFT_REVIEW`)를 누르면 안내 메시지가 오고, 그 메시지 id를 `intake_message_id`에 저장한다.
2. 안내 메시지에 써본 기간, 좋았던 점, 아쉬운 점 같은 사용 메모를 답장하면 `memo`에 저장하고 `review-draft` job을 쌓는다.
3. job이 메모만 근거로 초안을 쓴다. 메모에 없는 경험, 숫자, 효능은 지어내지 않게 하고, 프로필의 `review.minChars`~`maxChars`(기본 100~500자)에 맞춘다. 벗어나면 한 번 줄이거나 늘리고, 그래도 길면 문장 끝에서 자른다. 상태는 `DRAFT_REVIEW`가 된다.
4. 메시지가 둘 간다. 첫 번째는 **초안만** 담아서 길게 눌러 복사하기 쉽게 하고, 두 번째는 글자 수 안내와 `🔁 다시 쓰기` / `✅ 리뷰 올림` 버튼이 있는 조작 메시지다.
5. 조작 메시지에 `수정: <리뷰>`로 답장하면 그대로 교체한다(광고 표기 줄은 유지하고, 최대 글자 수를 넘으면 거절한다). 그 외 답장은 피드백으로 보고 다시 쓴다. 글이 바뀔 때마다 `revision`이 올라가 이전 조작 메시지의 버튼은 무효가 된다.
6. 다시 쓰기 요청은 `regen_seq`를 요청할 때 올린다. 쓴 결과는 그 seq가 아직 최신이고 메모가 그대로일 때만 반영한다. 재시도된 옛 요청이 새 결과를 덮지 못한다.
7. 복사해서 선물하기 리뷰(또는 무신사 후기)에 직접 올린 뒤 `✅ 리뷰 올림`을 누르면 `POSTED`로 기록한다.

출처에 따라 프롬프트의 리뷰 장소가 다르다(카카오톡 선물하기 상품 리뷰, 무신사 상품 후기). 복사 안내 문구도 출처의 리뷰 장소를 쓴다.

### 광고 표기

프로필(`config/campaign-profile.json`)의 `disclosure` 한 줄을 코드(`composeReview`)가 모든 초안의 맨 앞에 붙인다. 프롬프트는 모델에게 표기를 쓰지 말라고 하고, 모델이 비슷한 줄을 써도 중복해서 붙이지 않는다. 표기 줄의 길이는 `maxChars`에서 미리 뺀다([결정 12](decisions.md#12-광고-표기는-코드가-강제한다)).

### 체험단 데이터

| 테이블 | 내용 |
|---|---|
| `campaigns` | 체험단 한 건의 모든 상태(`014`). `source`는 `kakao-gift` 또는 `musinsa`다. `(source, external_id)`와 `url_hash`가 unique. 목록 필드, 점수·이유·`skip_reason`, 카드(`revision`, `review_message_id`, `review_revision`, `reject_reason`), 신청·선정·결과·`review_deadline`, 리뷰(`intake_message_id`, `memo`, `draft_text`, `regen_seq`, `posted_at`)를 가진다. |
| `campaign_reminders` | 보낸 리마인더. `(campaign_id, kind)`가 primary key |

웹 대시보드가 같은 데이터를 보여준다([dashboard.md](dashboard.md)). 로그인은 Telegram 1회용 코드이고, 그 기록은 `admin_login_codes`, `admin_sessions`, `admin_actions`(감사 기록) 테이블에 있다(`019`).
