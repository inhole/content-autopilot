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
               refresh-token (04:00) ──▶ Threads 토큰 갱신               │
                    └──────────────────────────────────────────────────┘
                                       │
                               Supabase Postgres
                     (topics, posts, platform_accounts, pgboss.*)
```

프로세스는 워커 하나다. 스케줄, 재시도, 큐는 모두 pg-boss가 Postgres 위에서 처리한다. 큐 정의는 `src/jobs.ts` 한 곳에 있다.

## 단계별 동작

| 단계 | 코드 | 하는 일 |
|---|---|---|
| collect | `src/pipeline/collect.ts` | `sources`의 RSS를 읽어 48시간 이내 글만 `topics`에 넣는다. 정규화한 URL의 sha256(`url_hash`)으로 중복을 막는다. 피드 하나가 실패해도 나머지는 계속한다. |
| rank | `src/pipeline/rank.ts` | 먼저 48시간이 지난 `COLLECTED` 주제를 `SKIPPED`로 정리한다. 그다음 후보 최대 100개와 최근 14일 동안 다룬 주제 목록을 함께 LLM에 넘겨, 한 번의 호출로 0~10점 평가와 중복 판정(`duplicate_of`)을 같이 한다. 중복이 아닌 것 중 상위 `DAILY_POST_COUNT`개만 `SHORTLISTED`, 나머지는 `SKIPPED`. |
| generate | `src/pipeline/generate.ts` | 기사 본문을 가져와(Readability) 그 내용만 근거로 초안 JSON(`text`, `angle`, `topic_tag`, `caveats`)을 만든다. 본문을 읽을 수 없으면 해당 주제는 건너뛴다. |
| review | `src/review/telegram.ts` | 초안, 관점, 확인할 점, 출처를 Telegram으로 보낸다. 버튼은 승인 / 재생성 / 폐기. |
| approve | `src/pipeline/publish.ts` | `PUBLISH_SLOTS` 중 아직 비어 있는 가장 빠른 시간을 `scheduled_at`으로 정한다. |
| publish | `src/pipeline/publish.ts` | 컨테이너 생성 → `FINISHED` 대기 → `threads_publish`. 출처 URL은 `link_attachment`로 붙인다. |

## 상태

```
topics:  COLLECTED ─▶ SHORTLISTED ─▶ USED
            │  └────▶ SKIPPED
            └───────▶ DUPLICATE

posts:   PENDING_REVIEW ─▶ SCHEDULED ─▶ PUBLISHING ─▶ PUBLISHED
              │  ▲                         │
              │  └ 재생성 / 수정             └─▶ SCHEDULED (재시도) ─▶ FAILED (3회 실패)
              └─▶ REJECTED
```

## 중복 발행 방지

발행의 기준은 job이 아니라 `posts` 행이다.

1. **행을 선점한다.** `publishPost`는 `UPDATE … SET status='PUBLISHING' WHERE status='SCHEDULED'`로 행을 잡는다. 이 업데이트에 성공한 워커만 진행한다.
2. **컨테이너 ID를 먼저 저장한다.** 컨테이너를 만들자마자 `container_id`를 저장하고, 그다음에 publish를 호출한다.
3. **재시도는 저장된 컨테이너부터 이어간다.** 컨테이너 상태가 `PUBLISHED`면 이미 올라간 것으로 보고 끝낸다. `EXPIRED`나 `ERROR`면 새 컨테이너를 만든다.
4. **job 자체는 재시도하지 않는다.** `publish` 큐는 `retryLimit: 0`이다. 실패하면 행을 `SCHEDULED`로 되돌리고, 5분 뒤 `publish-due`가 그 행을 다시 찾아 시도한다. 3번 실패하면 `FAILED`로 바꾸고 Telegram으로 알린다.
5. **멈춘 행은 이어받는다.** 워커가 죽어 `PUBLISHING`에서 10분 넘게 멈춘 행은 다음 sweep이 이어서 처리한다.

이 로직은 `test/publish.test.ts`가 검증한다.

## 중복 판정

같은 URL은 수집 단계에서 `url_hash` unique로 걸러진다. 그 밖의 중복은 rank의 LLM이 판정한다.
- **후보끼리 같은 사건이면** 정보가 가장 풍부한 하나만 남긴다. 한국어 요약과 영어 원문처럼 언어가 달라도 마찬가지다.
- **최근 14일 동안 이미 다룬 주제와 같은 사건이면** 제외한다.

처음에는 임베딩 유사도(pgvector)로 중복을 걸렀다. 그런데 GeekNews 한국어 요약과 HN 영어 원문은 같은 기사여도 유사도가 0.37~0.63밖에 나오지 않았다. 다른 기사와 구분할 수 있는 기준값을 정할 수 없어서 임베딩 방식은 제거했다 (`migrations/002_drop_embedding.sql`).

LLM이 잘못된 id나 자기 자신을 가리키면 `resolveDuplicates`가 그 표시를 무시한다. 두 주제가 서로를 가리키면 점수가 높은 쪽을 남긴다. 그래서 어떤 경우에도 둘 다 사라지지는 않는다.

## 데이터

| 테이블 | 내용 |
|---|---|
| `sources` | 수집할 RSS 목록. 새 피드는 여기에 행을 추가하면 된다. `MANUAL`은 직접 입력한 주제용이다. |
| `topics` | 수집한 글, 점수, 중복 대상(`duplicate_of`), 상태 |
| `posts` | 초안과 발행 상태. `(topic_id, platform)`이 unique라 재생성하면 같은 행이 갱신된다. |
| `platform_accounts` | Threads 토큰과 만료 시각 |
| `pgboss.*` | pg-boss가 관리하는 큐와 스케줄 |

## 프롬프트

프롬프트는 `src/pipeline/prompts.ts`에 있다. 계정 소개는 모든 프롬프트가 공유하고, 그 아래에 단계별 지시가 붙는다. 생성 규칙의 핵심은 세 가지다.
- 기사 본문에 있는 사실만 쓴다.
- 자기 말로 요약한다.
- 개발자 관점의 해석을 하나 이상 넣는다.

남의 글을 모아서 올리기만 하는 계정은 노출에서 불리하다. 이 세 규칙이 그걸 피하는 장치다.
