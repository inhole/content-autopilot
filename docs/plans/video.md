# 숏폼 영상 자동화 설계 (Instagram Reels / YouTube Shorts)

[roadmap.md](roadmap.md) 4절을 구체화한 설계다. 결정과 이유는 [decisions.md](../decisions.md) 15에 요약한다. 구현하면서 바뀌는 내용은 이 문서도 같이 고친다. 설계 리뷰(Codex, 2026-10-24) 지적을 반영한 판이다.

## 1. 목표와 범위

- 반응이 좋았던 Threads 글을 30~45초 세로 영상(1080×1920)으로 만든다. 사람이 Telegram에서 미리보기를 보고 승인하면 정해진 시간에 Reels와 Shorts로 올라간다.
- 영상은 하루 1편, 자동 선택은 주 3편을 넘기지 않는다(roadmap 4절 리스크).
- **이번 범위:** V1(원고·TTS·렌더·Telegram 미리보기·직접 업로드), V2(Reels 자동 발행), V3(Shorts 자동 발행), V4(영상 성과 수집과 주간 리포트). 모두 설정으로 하나씩 켠다.
- **V0는 사람이 할 일이다:** Instagram 프로페셔널 계정 전환, Meta 앱에 Instagram 제품 추가, Google Cloud OAuth 클라이언트, TTS 키 발급, Supabase Storage 버킷. 순서는 [setup.md](../setup.md) 7절에 적는다.
- **범위 밖:** 웹 대시보드 화면, 체험단 리뷰 릴스(roadmap 2순위), 장면 전환 효과와 배경 영상, 기본 배경음악, 묶음 글(digest)과 만료 초안으로 만드는 영상.

## 2. 흐름

```
video-pick (VIDEO_CRON, 기본 화·목·토 07:00) 또는 /video [postId]
  → videos 행 SCRIPTING (regen_seq = 1)
video-script {videoId, seq}      LLM 원고(장면 JSON) → RENDERING, revision+1
video-render {videoId}           문장별 TTS → 프레임 PNG → ffmpeg mp4 → 검사 → 저장소 업로드 → PENDING_REVIEW
video-review {videoId, ifUnsent?} Telegram: 원고 메시지 + 영상(sendVideo, 파일 업로드)과 버튼
  ✅ 승인 → (한 트랜잭션) 슬롯 확보 + 플랫폼마다 video_publications SCHEDULED + APPROVED
  🔁 다시 만들기 / 답장 피드백 → SCRIPTING (regen_seq+1, 피드백은 DB에)
  수정N:/화면N: 답장 → 원고 교체 → RENDERING
  제목:/캡션: 답장 → 텍스트만 교체 → 검수 메시지 다시 보냄 (재렌더 없음)
  🗑 폐기 → REJECTED
video-publish-due (*/5)          기한이 된 발행 행, 멈춘 PUBLISHING 행 → video-publish
                                 Shorts 처리 결과 확인, 안 보낸 실패 알림
video-publish {publicationId}    REELS: 컨테이너 → FINISHED 대기 → media_publish
                                 SHORTS: resumable 세션 → 업로드 → 처리 결과는 sweep이 확인
  모든 발행이 끝나면 videos.status = PUBLISHED
video-maintenance (매시)         72시간 방치된 검수 영상 EXPIRED, 안 간 검수 메시지 재전송,
                                 멈춘 원고·렌더 재투입(최대 2번, 그다음 FAILED)
video-insights (매일 05:30)      발행 30일 이내 영상의 성과 스냅숏
video-cleanup (매일 04:30)       끝난 영상 파일을 저장소에서 지움
video-refresh-token (매일 04:10) Instagram 장기 토큰 갱신
```

## 3. 결정

### 3-1. 테이블을 따로 둔다 (`posts.platform` 확장이 아님)

roadmap은 `posts.platform`으로 구분하자고 했지만, 영상은 `videos`와 `video_publications`로 따로 둔다.

- `posts`는 Threads 글에 묶여 있다. 500자 제한, `post_parts`, `unique (topic_id, platform)`, 모든 글이 같이 쓰는 슬롯 유니크 인덱스(`003`), 문체 학습(`style.ts`)이 모두 글을 전제한다.
- 영상 하나가 Reels와 Shorts 두 곳에 올라간다. 원고·렌더·검수는 한 번이고 발행만 플랫폼별이다. 그래서 검수 단위(`videos`)와 발행 단위(`video_publications`)를 나눈다.
- 영상은 원본 글을 `videos.post_id`로 가리키고, 글 하나로는 영상을 하나만 만든다(`unique (post_id)`).

### 3-2. 렌더는 satori + resvg + ffmpeg-static, 클라우드 워커에서

roadmap은 Remotion과 로컬 PC 렌더 워커를 먼저 검토하자고 했다. 실제로 재 보니 더 가벼운 방법으로 충분하다.

- **장면 그림:** satori(객체 트리 → SVG, flex 레이아웃과 `word-break: keep-all` 한국어 줄바꿈)로 그리고 resvg로 PNG를 만든다. 글꼴은 Pretendard(OFL)를 `assets/fonts`에 넣는다. 이 PC에서 1080×1920 프레임 1장에 0.7초가 걸렸다.
- **인코딩:** `ffmpeg-static`(npm 설치 때 플랫폼별 바이너리를 받는다)을 비동기 자식 프로세스로 돌린다. concat demuxer → H.264 `yuv420p` 30fps(`-tune stillimage`, `-threads 2`) + AAC 48kHz, `+faststart`, 5분 제한 시간. 이 PC에서 2초짜리에 1.5초가 걸렸다.
- **자원:** 렌더 큐는 한 번에 하나만 돌고(`localConcurrency` 1), 프레임과 TTS는 순서대로 만든다. 임시 파일은 작업마다 `os.tmpdir()` 아래 폴더에 만들고 끝나면 지운다. 실제 Railway 사양에서 45초 영상 시간과 메모리를 첫 배포 때 잰다.
- Remotion은 헤드리스 Chrome과 번들러가 필요해서 Railway에서 무겁다. 로컬 렌더 워커는 PC가 켜져 있어야 하고 없앤 워커 역할 구분을 되살려야 한다. 지금 필요한 화면(문구 카드 + 자막)에 비해 둘 다 비용이 크다.
- 화면은 자막 조각마다 한 장이고 컷 전환이다. 움직임 효과는 반응을 본 뒤 `zoompan`이나 `xfade`로 붙인다.
- **결과 검사:** 렌더 뒤 `ffmpeg -i`로 실제 길이를 읽어 타임라인과 1초 넘게 다르면 실패로 본다. 길이는 15~75초, 크기는 45MB 이하여야 한다(Telegram 업로드 50MB 제한). 75초를 넘으면 다시 시도해도 같으니 바로 FAILED로 두고 재생성을 안내한다.

### 3-3. TTS는 문장마다 합성해서 자막을 맞춘다

- 문장마다 TTS를 한 번씩 부르고 PCM 길이로 재생 시간을 계산한다. 그래서 단어 타임스탬프를 주는 TTS가 아니어도 자막이 맞는다(roadmap에 적었던 Whisper 재정렬이 필요 없다).
- 문장 사이에 0.15초, 장면 사이에 0.35초 쉼을 넣는다. 한 문장이 자막 상자(최대 3줄, 약 42자)에 안 들어가면 자막만 쉼표·띄어쓰기에서 나누고 글자 수 비율로 시간을 배분한다.
- 공급자는 `VIDEO_TTS_PROVIDER`로 고른다. 응답 형식이 서로 다르므로 어댑터가 24kHz 16bit 모노 PCM으로 맞춘다.
  - `google`(Cloud TTS REST, 기본 음성 `ko-KR-Chirp3-HD-Charon`): `LINEAR16`, `sampleRateHertz=24000` → base64를 풀고 **RIFF 청크를 읽어** `fmt`의 샘플레이트·채널과 `data`만 꺼낸다. 헤더가 44바이트라고 가정하지 않는다.
  - `openai`(`gpt-4o-mini-tts`): `response_format=pcm` → 헤더 없는 24kHz 16bit 모노.
  - `elevenlabs`(`eleven_multilingual_v2`): `output_format=pcm_24000`을 꼭 붙인다(기본은 MP3).
  - `silent`(기본): 키 없이 개발할 때 쓰는 무음. 글자 수 ÷ 7초 길이다. 운영에서 실수로 무음 영상이 나가지 않게, 검수 메시지에 “🔇 무음(silent) TTS”라고 표시한다.
- 고르는 방법(V0): `npm run cli -- video:tts-sample "<문장>"`이 키가 있는 공급자마다 WAV를 만든다. 권장은 `google`(한국어 자연스러움과 단가의 균형)이지만 최종 선택은 샘플을 듣고 한다.

### 3-4. 원고는 발행된 글에서만 사실을 가져온다

- 후보는 **실제로 발행된 단일 출처 Threads 글**(`origin`이 `news` 또는 `revived`)뿐이다. 사람이 승인하고 발행한 글이라 사실 확인이 끝난 상태다. 묶음 글은 출처가 여럿이고 만료 초안은 승인된 적이 없어서 뺀다.
- LLM(`LLM_MODEL`, `chatJson`)에 본 글과 답글, 주제 제목, 출처 도메인을 주고 장면 JSON을 받는다. 원문 기사는 다시 읽지 않는다.
- 스키마: `{ title, caption, hashtags[], scenes: [{ heading, narration }] }`. 장면은 3~5개이고 첫 장면이 훅이다.
  - `title` 60자 이내, `heading` 18자 이내, `narration` 1~2문장, `caption` 300자 이내, 해시태그 5개 이내.
  - 내레이션 합계 180~330자(대략 25~45초). 360자를 넘으면 한 번 줄여 달라고 다시 요청하고, 그래도 넘으면 실패(재시도 대상)다.
  - 장면 하나에는 반드시 개발자 관점의 해석을 넣는다(재가공 콘텐츠로 분류되는 위험 줄이기, 결정 3).
  - 말투는 Threads와 같은 반말이다(결정 7). 원본 글에 없는 사실·숫자는 쓰지 않는다.
- **코드가 붙이는 것(LLM이 쓰지 않음):** 마지막 출처 장면(“출처 <도메인>” + `VIDEO_BRAND`, 내레이션 없이 2.5초), 캡션 끝의 `출처: <URL>`과 해시태그. 결정 12와 같은 원칙이다.
- 사람이 고치는 경로(`수정N:` 등)도 같은 길이 제한을 거친다. YouTube 제목은 100자, 설명은 **5000바이트(UTF-8)**이고 둘 다 `<`, `>`를 쓸 수 없다. 조립을 마친 최종 문자열로 검사하고, `<`, `>`는 `‹`, `›`로 바꾼다.

### 3-5. 단계마다 소유권을 확인해서 오래된 결과가 덮어쓰지 못하게 한다

- **원고:** 재생성 요청은 `regen_seq+1`과 피드백(`regen_feedback`)을 같은 UPDATE로 남기고 `SCRIPTING`으로 바꾼다. 원고 작업은 `status='SCRIPTING' and regen_seq = seq`일 때만 결과를 쓴다. 그래서 오래된 요청이나 재투입된 중복 작업은 아무것도 바꾸지 못한다. 피드백이 DB에 있으니 enqueue 전에 죽어도 maintenance가 같은 요청을 다시 넣을 수 있다.
- **렌더:** 렌더 작업은 시작할 때 `(revision, 장면, 렌더 입력 해시)`를 읽고, 끝나면 `status='RENDERING' and revision = 읽은 값`일 때만 `video_url`, `render_hash`, `PENDING_REVIEW`를 쓴다. 조건이 안 맞으면(그사이 수정·재생성) 방금 올린 파일을 지우고 끝낸다.
- **렌더 입력 해시**에는 장면, 출처 표시, 브랜드, TTS 공급자·음성·모델, 화면 템플릿 버전(글꼴 포함), 배경음악 파일 이름·크기가 들어간다. 해시가 같으면 렌더를 건너뛴다. 저장 파일 이름은 렌더 실행마다 새로 만드는 id와 완성 mp4 SHA-256 앞부분이다. 실행마다 키가 달라서, 반영되지 못한 렌더가 지우는 파일은 자기 파일뿐이다.
- **장면 수정:** `수정N:`/`화면N:`은 `scenes` 교체, `revision+1`, `RENDERING` 전환을 UPDATE 한 번으로 한다. 그래서 수정 전에 시작한 렌더는 revision이 달라져 반영되지 못한다.
- **검수 불변식:** `PENDING_REVIEW`인 영상은 항상 현재 장면으로 만든 파일을 가리킨다. 장면을 바꾸는 모든 경로가 상태를 `RENDERING`이나 `SCRIPTING`으로 옮기기 때문이다. 제목·캡션 교체는 렌더 결과에 영향이 없어 `PENDING_REVIEW`를 유지하고 `revision`만 올린다.
- **멈춘 단계:** `SCRIPTING`/`RENDERING`이 45분 넘게 그대로면 maintenance가 같은 작업을 다시 넣는다(`stage_recoveries`+1). 두 번 넣어도 안 끝나면 `FAILED`와 알림이다. 큐의 마지막 재시도가 실패해도 `FAILED`와 알림이다.

### 3-6. 검수는 Telegram, 두 메시지를 한 버전으로 묶는다

- 원고가 영상 캡션(1024자)에 다 안 들어가서 메시지를 두 개 보낸다. 먼저 원고 메시지(제목, 장면별 화면 문구·내레이션, 캡션, 길이, 4096자 이내로 자름), 그다음 영상(`sendVideo`, 저장소에서 받은 파일을 직접 업로드, 짧은 캡션 + `✅ 승인` / `🔁 다시 만들기` / `🗑 폐기`).
- 두 메시지는 같은 시점에 읽은 내용으로 만들고, 다 보낸 뒤 **UPDATE 한 번**으로 `script_message_id`, `review_message_id`, `review_revision`을 등록한다(`status='PENDING_REVIEW' and revision = 보낸 revision`일 때만). 등록에 실패하면 방금 보낸 영상의 버튼을 지운다. 등록되면 이전 메시지들의 버튼을 지운다.
- 버튼은 `vid:<action>:<videoId>:<revision>`이다. 누르면 승인·폐기·재생성의 **실제 UPDATE**가 `status='PENDING_REVIEW' and revision = 버튼의 revision and review_message_id = 누른 메시지 and review_revision = revision`을 조건으로 한다.
- 답장은 등록된 두 메시지에만 받고, 고치는 UPDATE도 같은 조건(답장한 메시지가 등록된 둘 중 하나, `review_revision = revision`)을 건다.
  - `수정N: <문장>` → N번 장면 내레이션, `화면N: <문구>` → N번 장면 화면 문구. 둘 다 다시 렌더한다.
  - `제목: …`, `캡션: …` → 그대로 교체하고 검수 메시지를 다시 보낸다.
  - 그 밖의 답장 → 피드백으로 원고 재생성.
- 72시간 동안 손대지 않은 검수 영상은 `EXPIRED`가 되고 버튼이 사라진다.

### 3-7. 승인은 한 트랜잭션

- 영상 행을 잠그고(`for update`, 위 버튼 조건 포함) → `video_url`이 있는지 확인 → 슬롯을 고르고 → 플랫폼마다 발행 행을 만들고 → `APPROVED`로 바꾸는 것을 한 트랜잭션에서 한다. 슬롯 충돌(유니크 위반)이면 트랜잭션 전체를 다시 한다.
- 발행 행에는 승인 시점의 대상 계정(`account_user_id`)을 적는다. 발행할 때 현재 계정과 다르면 보내지 않고 `FAILED`로 알린다.
- 승인 뒤에는 원고·영상이 얼어 있다. 원고를 바꾸는 모든 UPDATE는 `status='PENDING_REVIEW'`를 조건으로 하므로 승인된 영상은 바뀌지 않는다. 다시 시도는 발행 행에만 있다.
- `VIDEO_PLATFORMS`가 비어 있으면(V1) 발행 행 없이 `APPROVED`로 두고, 캡션 복사용 메시지와 `📤 직접 올림` 버튼을 보낸다. 누르면 `PUBLISHED`가 되고 `published_at`이 찍힌다(정리 기준 시각).
- `videos.status`: `APPROVED`는 “승인했고 발행 대기”, `PUBLISHED`는 “모든 발행 행이 PUBLISHED이거나 직접 올림”이다.

### 3-8. 슬롯과 한도

- 영상 발행 시각은 `VIDEO_PUBLISH_SLOT` **하나**(기본 `19:00`)다. 날마다 슬롯이 하나라서 플랫폼마다 `unique (platform, scheduled_at)`이면 하루 1편이 보장된다. 실패한 행의 `🔁 다시 시도`는 그 행을 다음 빈 슬롯으로 다시 예약한다(오늘 슬롯이 아직 비어 있고 지나지 않았으면 오늘).
- 워커가 오래 멈췄다가 살아나도 밀린 영상이 한꺼번에 나가지 않게, 슬롯이 6시간 넘게 지난 `SCHEDULED` 행은 발행하지 않고 다음 빈 슬롯으로 옮긴 뒤 알린다. 멈춘 `PUBLISHING` 행은 이미 외부에 요청이 갔을 수 있으니 그대로 이어서 한다.
- 자동 선택(`video-pick`)은 최근 7일에 만든 영상(폐기 포함)이 `VIDEO_WEEKLY_MAX`(기본 3)개 이상이면 건너뛴다. `/video <번호>`는 사람이 고른 것이라 한도를 보지 않는다.

### 3-9. 발행은 플랫폼별 행, 글과 같은 claim 모델

- `status='PUBLISHING', attempts+1, claim_seq+1`로 가져가고, 이후 모든 쓰기는 `claim_seq` 토큰을 조건으로 한다. 15분 넘게 멈춘 `PUBLISHING`은 다시 가져간다. 큐 작업은 `expireInSeconds` 1800이고, 재시도는 sweep만 한다(`retryLimit: 0`).
- 외부 호출에는 모두 제한 시간이 있다(일반 30초, 파일 업로드 5분). 15분 lease는 가장 긴 단일 호출보다 길다.
- **실패 분류:** 인증 오류(HTTP 401, Meta 오류 코드 190, Google `invalid_grant`)와 계정 불일치는 다시 해도 같으니 바로 `FAILED`와 “토큰/계정 확인” 알림이다. 나머지는 3번까지 다시 하고, 결과를 모르는 경우(아래)는 6번까지 기다린다. `FAILED` 알림은 `alerted_at`으로 한 번만 가고, `🔁 다시 시도` 버튼이 붙는다.
- **Reels** (Instagram 로그인 방식 API, `graph.instagram.com`, Facebook 페이지 불필요)

  | 단계 | 처리 |
  |---|---|
  | 컨테이너 없음 | `POST /{ig-user-id}/media` (`media_type=REELS`, `video_url`, `caption`, `share_to_feed=true`) → id를 소유권 조건으로 먼저 저장 |
  | `IN_PROGRESS` | 10초마다 확인, 확인할 때마다 heartbeat. 8분 안에 안 끝나면 `SCHEDULED`로 돌리고 시도 횟수를 되돌린다(처리 지연은 실패가 아님). 컨테이너를 만든 지 2시간이 지나도 안 끝나면 실패 1회 |
  | `FINISHED` | 소유권 재확인 → `media_publish` |
  | `PUBLISHED` | 이미 나간 것(응답 유실). 다시 발행하지 않는다 |
  | `ERROR` / `EXPIRED` | 컨테이너를 버리고 실패 1회. 다음 시도는 새 컨테이너 |
  | 조회 실패 | 결과 모름. 컨테이너를 유지하고 다시 시도(최대 6번) |
  | `media_publish` 예외 | 컨테이너 상태를 다시 조회해서 위 표대로 판단 |

  응답 유실로 media id를 모를 때는 최근 미디어 중 `media_product_type=REELS`, 시도 시작 시각 이후, 캡션이 정확히 같은 것이 **하나뿐일 때만** 채운다. 아니면 비워 두고(성과 수집만 빠짐) 완료 알림에 “media id 모름”이라고 적는다.
- **Shorts** (YouTube Data API `videos.insert` resumable)

  | 단계 | 처리 |
  |---|---|
  | 세션 없음 | 세션 생성 요청(제목, 설명, 카테고리 28, `selfDeclaredMadeForKids=false`, `YOUTUBE_PRIVACY`, 태그 `capub<발행 행 id>`) → 세션 URL을 소유권 조건으로 먼저 저장 → 소유권 재확인 → 파일 PUT |
  | 세션 있음 | `Content-Range: bytes */<크기>`로 상태 조회. 200/201이면 이미 올라간 것(id 저장), 308이면 받은 바이트 다음부터 이어 올림 |
  | 세션 404/410 | **새 세션을 바로 만들지 않는다.** 이전 업로드가 끝났을 수 있기 때문이다. 내 채널 최근 업로드에서 태그 `capub<id>`가 붙은 영상을 찾아 있으면 그 id를 쓰고, 없으면 `FAILED`와 “업로드 여부를 확인하고 다시 시도” 알림. 이 경우의 `🔁 다시 시도`만 세션을 비우고 새로 올린다 |

  업로드가 끝나면 `PUBLISHED`(id 있음)로 두고, sweep이 24시간 동안 `videos.list(part=status,processingDetails)`로 처리 결과를 확인한다. `processed`면 `verified_at`을 찍고, `failed`/`rejected`이거나 공개 범위가 기대와 다르면 한 번 알린다. 처리 실패를 새 업로드로 자동 해결하지 않는다.
- `VIDEO_PUBLISH_DRY_RUN`(기본 `true`)이면 로그만 남기는 클라이언트를 쓰고, media id는 `dry-`로 시작한다. 성과 수집과 리포트는 `dry-` id를 뺀다. Threads의 dry-run과 같게 dry-run 발행도 `PUBLISHED`로 끝난다. 실제로 켠 뒤 같은 영상을 다시 내보내려면 `video:reset-dry <videoId>`가 `dry-` 발행 행을 다음 빈 슬롯의 `SCHEDULED`로 되돌린다.
- 미검증 API 프로젝트가 올린 영상도 이제 비공개로 잠기지 않는다(`videos.insert` 문서, 2026-10-24 확인). 그래서 Shorts는 YouTube 감사를 기다리지 않는다. OAuth 동의 화면이 Testing이면 refresh token이 7일 만에 만료되므로 “프로덕션”으로 바꾸는 것만 필요하다. 업로드 할당량은 하루 100회다.

### 3-10. 저장소는 Supabase Storage 공개 버킷

- Instagram은 컨테이너를 만들 때 공개 `video_url`을 요구한다. 이미 쓰는 Supabase 프로젝트에 공개 버킷(`VIDEO_STORAGE_BUCKET`, 기본 `videos`)을 만든다.
  - 업로드: `POST {SUPABASE_URL}/storage/v1/object/{bucket}/{key}`, `Authorization: Bearer <service key>`, `Content-Type: video/mp4`, `x-upsert: false`.
  - 공개 URL: `{SUPABASE_URL}/storage/v1/object/public/{bucket}/{key}`.
  - 삭제: `DELETE {SUPABASE_URL}/storage/v1/object/{bucket}`에 `{ "prefixes": [key] }`.
- 키는 `v<videoId>/<렌더 실행 id>-<sha256 앞 16자>.mp4`다. 같은 실행이 응답 유실 뒤 같은 키로 다시 올리다 “이미 있음”(409)이 나면 성공으로 본다.
- 로컬 개발은 `VIDEO_STORAGE=local`(기본)로 `VIDEO_LOCAL_DIR`(기본 `.data/videos`, `.gitignore`)에 저장한다. `VIDEO_PLATFORMS`에 `reels`가 있는데 `supabase`가 아니면 설정 검증에서 시작을 거부한다.
- **정리(`video-cleanup`):** 지울 수 있는 것은 (1) `REJECTED`/`EXPIRED`가 된 지 3일 지난 영상, (2) `PUBLISHED`가 된 지 14일 지난 영상의 파일뿐이다. `APPROVED`(발행 대기·실패 포함)는 지우지 않는다. 지우기 직전에 같은 조건으로 행을 다시 확인하고, 삭제가 성공한 뒤에만 `storage_deleted_at`을 쓴다. 새 렌더로 대체된 파일과 반영되지 못한 렌더 파일은 렌더 작업이 그 자리에서 지운다. 렌더 도중 프로세스가 죽어 남은 파일은 드물어서 감수한다.

### 3-11. 계정과 토큰

- `platform_accounts`의 `platform`에 `INSTAGRAM`, `YOUTUBE`를 더하고 `refresh_token` 열을 추가한다.
- **Instagram:** 앱 대시보드에서 테스터 계정의 장기 토큰(60일)을 발급해 `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN`으로 처음 한 번 넣으면 DB로 옮겨진다. 이후 `video-refresh-token`이 만료 14일 전부터 `GET /refresh_access_token?grant_type=ig_refresh_token`으로 갱신한다. 권한: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
- **YouTube:** 데스크톱 OAuth 클라이언트(`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`)로 `npm run cli -- youtube:auth`를 실행한다. CLI가 `127.0.0.1`의 임시 포트에서 리디렉션을 받아(`access_type=offline`, `prompt=consent`) 코드를 바꾸고, `channels.list(mine=true)`로 채널 id를 확인한 뒤 채널 id·access token·만료 시각·refresh token을 한 번에 저장한다. 범위는 `youtube.upload`, `youtube.readonly`이다. access token은 만료 5분 전부터 refresh token으로 새로 받고, 응답에 refresh token이 없으면 기존 값을 유지한다. `invalid_grant`면 “`youtube:auth`로 다시 인증” 알림이다.

### 3-12. 성과와 리포트 (V4)

- `video_insights`에 발행 행마다 하루 한 번 스냅숏을 쌓는다(조회, 좋아요, 댓글, 공유, 저장, 모르는 값은 null). 리포트는 발행 행마다 **최신 스냅숏 하나**만 쓰고 그 값을 더한다(누적값을 날마다 더하지 않는다).
  - Reels: `GET /{media-id}/insights?metric=views,likes,comments,shares,saved`
  - Shorts: `GET youtube/v3/videos?part=statistics&id=…`
- 주간 리포트(`/report`, 월 09:00)에 “🎬 영상” 구역을 붙인다: 최근 7일 발행한 영상의 플랫폼별 개수와 조회 합계, 조회가 가장 많은 영상.

## 4. 데이터 모델 (`021_videos.sql`)

```sql
videos
  id, post_id (unique → posts), status
    SCRIPTING | RENDERING | PENDING_REVIEW | APPROVED | PUBLISHED | REJECTED | EXPIRED | FAILED
  title, caption, hashtags text[], scenes jsonb ([{heading, narration}]),
  source_url, source_label, generation jsonb,
  revision, regen_seq, regen_feedback, stage_recoveries,
  render_hash, video_url, storage_key, duration_ms, size_bytes, rendered_at,
  review_chat_id, review_message_id, script_message_id, review_revision,
  last_error, published_at, storage_deleted_at, created_at, updated_at

video_publications
  id, video_id → videos, platform REELS | SHORTS, unique (video_id, platform)
  status SCHEDULED | PUBLISHING | PUBLISHED | FAILED
  scheduled_at, account_user_id, attempts, claim_seq, container_id, container_created_at,
  upload_url, platform_media_id, permalink, published_at, verified_at,
  last_error, error_kind, alerted_at, created_at, updated_at
  unique (platform, scheduled_at)

video_insights
  id, publication_id → video_publications, collected_at, views, likes, comments, shares, saves

platform_accounts: platform check에 INSTAGRAM, YOUTUBE 추가, refresh_token 열 추가
```

## 5. 화면 구성 (1080×1920)

- 배경은 남색 그라데이션, 강조색 하나. 위쪽에 `VIDEO_BRAND`(예: `@devbrief.kr`)와 장면 진행 막대.
- 가운데 위쪽에 화면 문구(굵게, 88px), 그 아래 자막 상자(반투명, 54px, 최대 3줄).
- Reels·Shorts의 하단 UI(아래 약 400px)와 오른쪽 버튼 영역(약 140px)에는 글자를 두지 않는다.
- 첫 장면은 훅 문구를 크게(112px), 마지막은 출처 카드다.
- `VIDEO_BGM_PATH`가 있으면 배경음악을 낮게(-22dB) 깔고 영상 길이에 맞춰 자른다. 기본 음악은 넣지 않는다.

## 6. 설정

| 키 | 기본 | 뜻 |
|---|---|---|
| `VIDEO_ENABLED` | false | 자동 선택 일정(`video-pick`)을 켠다. 꺼져 있어도 `/video`와 CLI는 동작한다 |
| `VIDEO_CRON` | `0 7 * * 2,4,6` | 자동 선택 시각 |
| `VIDEO_WEEKLY_MAX` | 3 | 자동 선택의 7일 한도 |
| `VIDEO_PUBLISH_SLOT` | `19:00` | 영상 발행 시각(하루 하나) |
| `VIDEO_PLATFORMS` | (비어 있음) | `reels`, `shorts` 중 자동 발행할 것. 비면 직접 업로드 |
| `VIDEO_PUBLISH_DRY_RUN` | true | Instagram·YouTube를 실제로 부르지 않는다 |
| `VIDEO_BRAND` | (비어 있음) | 화면 위쪽과 출처 카드에 나오는 이름 |
| `VIDEO_TTS_PROVIDER` | `silent` | `google`, `openai`, `elevenlabs`, `silent` |
| `VIDEO_TTS_VOICE` | 공급자별 기본 | google `ko-KR-Chirp3-HD-Charon`, openai `alloy`, elevenlabs는 필수 |
| `GOOGLE_TTS_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | | 공급자 키 |
| `VIDEO_BGM_PATH` | | 배경음악 파일 |
| `VIDEO_STORAGE` | `local` | `local` 또는 `supabase` |
| `VIDEO_LOCAL_DIR` | `.data/videos` | 로컬 저장 위치 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `VIDEO_STORAGE_BUCKET` | `videos` | Supabase Storage |
| `INSTAGRAM_API_BASE` | `https://graph.instagram.com/v24.0` | |
| `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN` | | 처음 한 번 넣는 값. 이후 DB가 기준 |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | | 데스크톱 OAuth 클라이언트 |
| `YOUTUBE_PRIVACY` | `public` | `public`, `unlisted`, `private` |

## 7. 코드 배치

```
src/video/
  types.ts        상태, 장면 타입, 길이·바이트 검사
  prompts.ts      원고 프롬프트
  script.ts       원고 생성(LLM)과 검증, 출처 장면·캡션 조립
  subtitles.ts    문장 나누기, 자막 조각, 타임라인
  wav.ts          RIFF 파싱, PCM 이어 붙이기, WAV 쓰기
  tts.ts          공급자 인터페이스와 google/openai/elevenlabs/silent
  frames.ts       satori 장면 그림
  render.ts       타임라인 → PNG → ffmpeg mp4 → 검사, 렌더 입력 해시
  storage.ts      local / supabase
  store.ts        videos 쿼리와 상태 전이(조건부 update)
  pipeline.ts     원고·렌더 단계(소유권 조건으로 반영)
  pick.ts         후보 고르기
  approve.ts      승인 트랜잭션·슬롯
  publish.ts      발행 claim, 실패 분류, sweep
  instagram.ts    Instagram 클라이언트(+dry-run)
  youtube.ts      YouTube 클라이언트(+dry-run), resumable 상태 해석
  accounts.ts     platform_accounts의 INSTAGRAM/YOUTUBE, YouTube OAuth
  insights.ts     성과 수집과 리포트 구역
  cleanup.ts      저장소 정리
  telegram.ts     검수 메시지, 버튼, 답장, /video, /videos
  jobs.ts         큐 정의와 작업
```

CLI: `video:tts-sample`, `video:script <postId>`(읽기 전용), `video:render <postId>`(DB에 쓰지 않고 mp4만), `video:make <postId>`, `video:list`, `video:show <id>`, `video:approve <id>`, `video:publish-now <id>`, `video:reset-dry <id>`, `video:insights`, `instagram:check`, `youtube:auth`, `youtube:check`.

## 8. 테스트

- 단위: 문장 나누기와 자막 타임라인, RIFF 파싱(헤더 길이가 다른 WAV 포함)과 PCM 이어 붙이기, 원고 검증(길이, 장면 수, 줄이기 재요청), 캡션 조립과 YouTube 바이트 제한, 답장 파싱, 콜백 인코딩, Reels 상태 전이표, resumable 상태 해석, 실패 분류, 리포트 구역.
- 렌더 스모크: `silent` TTS로 장면 2개짜리 mp4를 실제로 만들어 길이를 확인한다(ffmpeg-static 바이너리가 있을 때만).
- 통합(로컬 Postgres): 원고·렌더 소유권(오래된 seq·revision), 검수 메시지 등록과 오래된 버튼, 승인 트랜잭션과 슬롯 충돌, 발행 claim(잃어버린 claim, 응답 유실, 멈춘 행 재개, 처리 지연, 인증 실패, 3회 실패), 만료·재전송·멈춘 단계 복구, 정리 조건.

## 9. 리스크와 남은 확인

- Instagram API 버전, Reels 처리 시간, 하루 발행 한도는 V0 테스트 업로드로 확인한다.
- `ffmpeg-static`이 Railway 빌드에서 바이너리를 받는지, 실제 사양에서 렌더 시간과 메모리는 첫 배포 때 확인한다.
- TTS 품질은 샘플로만 판단할 수 있다. 처음 몇 편은 공급자를 바꿔 가며 반응을 본다.
- 같은 틀의 영상이 반복되면 노출이 떨어질 수 있다. 4주 뒤 성과를 보고 화면 구성이나 빈도를 다시 정한다.
