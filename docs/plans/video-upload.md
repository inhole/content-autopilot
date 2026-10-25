# 관리자 콘솔에서 영상 직접 올리기 (설계)

상태: 설계 (2026-10-25, Codex 설계 리뷰 2회 반영). 숏폼 파이프라인(`docs/plans/video.md`, 결정 15) 위에 얹는다.

## 1. 목표

주인이 따로 만든 영상(CapCut, 폰 편집 등)을 관리자 콘솔에서 올리면, 생성 영상과 같은 검수·예약 발행·성과 수집을 탄다. 덤으로 관리자 콘솔에 영상 목록과 상세(미리보기, 승인·승인 취소·폐기·수정, 발행 상태, 다시 시도)를 둔다. 지금은 영상을 Telegram과 CLI로만 다룰 수 있다.

하지 않는 것:

- 서버에서 다시 인코딩하지 않는다. Railway CPU로 1080p 60초 변환은 몇 분씩 걸리고 워커의 다른 일을 막는다. 규격에 맞지 않으면 이유를 알려 주고 거절한다(폰·CapCut 기본 내보내기는 대부분 H.264/AAC mp4라 맞는다). 컨테이너만 MP4로 다시 묶는다(`-c copy`, 몇 초).
- 올린 파일 교체는 하지 않는다. 잘못 올렸으면 폐기하고 다시 올린다(승인한 뒤라도 발행 전이면 승인 취소 → 폐기).
- Telegram으로 파일을 받는 경로는 만들지 않는다(봇 API로 받는 파일은 20MB까지라 쓸모가 적다).
- 저작권(음악 클레임)은 로컬에서 판정하지 않는다. 화면에서 안내만 한다(7절).

## 2. 흐름

```
관리자 /videos/new: 파일 + 제목·캡션·해시태그·출처(선택) + [올리면서 바로 승인]
 1) POST /api/videos            (JSON) → videos 행 UPLOADING (origin 'upload', post_id 없음)
 2) POST /api/videos/:id/file?approve=0|1   (영상 바이트)
      a. 시작: UPLOADING이면 upload_started_at = now() (조건부, 만료 기준)
      b. 임시 폴더로 스트리밍(실제 수신량 상한, sha256) → ffprobe 검사 → MP4로 다시 묶기
      c. 업로드 시도 키를 video_upload_attempts에 기록 → 저장소 업로드
      d. 트랜잭션: UPLOADING인 경우에만 파일 반영 + PENDING_REVIEW, 시도 행 삭제
      e. approve=1이면 승인 시도. 실패해도 파일 반영은 그대로이고 응답에 이유를 담는다
      f. 승인하지 않았거나 실패했으면 Telegram 검수 메시지를 큐에 넣는다
 이후는 생성 영상과 같다: 승인 → video_publications → video-publish → 성과 수집 → 정리
```

- 두 단계로 나누는 이유: 제목·캡션(최대 2200자)은 JSON으로, 파일은 원시 바이트로 보내야 한다. multipart 파서를 들이지 않고, 헤더나 쿼리에 한국어 캡션을 싣지도 않는다(헤더 16KB 한도). 상태는 `videos` 행이 들고 있으니 단계 사이에 끊겨도 남는 것은 `UPLOADING` 행뿐이고 maintenance가 치운다.
- 전송은 **서버 경유**다. 브라우저가 Supabase에 서명 URL로 직접 올리는 방식은 CSP `connect-src`, Supabase CORS, 업로드 뒤 서버의 재다운로드 검사가 필요하다. 서버 경유는 서비스 키와 검사가 한곳에 있고 로컬 저장소(`VIDEO_STORAGE=local`)에서도 그대로 돈다. 대가는 최대 50MB가 Railway를 지나가는 것인데, 가끔 하는 일이라 문제없다.
- **응답 계약:** 파일 경로는 `{ stored: true, approval: { ok: true, at } | { ok: false, error } | null, detail }`을 돌려준다. 파일 저장과 승인은 결과가 따로 온다.
- **화면의 재시도 규칙:** 파일 요청이 네트워크 오류나 5xx로 끝나면 화면은 먼저 `GET /api/videos/:id`로 상태를 다시 읽는다. `UPLOADING`이면 같은 행에 파일을 다시 보내고, `PENDING_REVIEW`면 파일은 들어간 것이니 상세로 가서 승인 버튼을 보여 주고, `APPROVED`면 완료로 본다. `EXPIRED`면 같은 입력값으로 새 행을 만든다.

## 3. 데이터 (`024_video_uploads.sql`)

- `videos.post_id`의 `not null`을 뺀다. 생성 영상은 여전히 글 하나에 영상 하나(unique 유지, null은 여러 개 허용).
- `videos.origin text not null default 'generated'`, `check (origin in ('generated', 'upload'))`, `check (origin = 'upload' or post_id is not null)`.
- `videos.status`에 `UPLOADING`을 더한다. 파일이 아직 없는 업로드 행이다.
- `videos.upload_started_at timestamptz`: 마지막 파일 요청이 시작한 시각(만료 기준, 4절).
- `videos.original_name text`(표시용, 120자로 자름), `videos.width`, `videos.height integer`(표시 방향 기준 해상도. Telegram 전송과 화면에 쓴다). 생성 영상은 렌더할 때 1080×1920을 채운다.
- `video_upload_attempts(key text primary key, video_id bigint, created_at timestamptz, reclaiming boolean)`: 저장소에 올리기 직전에 기록한 키. 파일 반영 트랜잭션이 `reclaiming = false`인 그 행을 **먼저 지우고**(0행이면 반영하지 않는다) 영상 행을 갱신한다. 남아 있는 행은 결과를 모르는 시도이고 정리 작업이 회수한다(8절).
- `video_publications.status`에 `CANCELLED`를 더한다. 발행을 포기한 행이다(4절).

업로드 영상은 `scenes`, `generation`, `render_hash`가 없고 `regen_seq`는 1에 머문다. 공유 타입(`VideoStatus`, `VideoRow`, 목록 타입, 웹 계약)은 `post_id: number | null`, `origin`, `UPLOADING`을 반영한다.

## 4. 상태

```
UPLOADING ─ 파일 검사·저장 성공 → PENDING_REVIEW (→ 기존 흐름)
          └ greatest(created_at, upload_started_at)에서 1시간 동안 반영이 없으면 → EXPIRED
APPROVED ─ 승인 취소(발행 행이 모두 한 번도 시도되지 않은 SCHEDULED일 때) → PENDING_REVIEW
         └ 발행 행이 모두 끝나면(PUBLISHED 또는 CANCELLED) → 하나라도 PUBLISHED면 PUBLISHED, 아니면 FAILED
발행 행 FAILED ─ 다시 시도 → SCHEDULED / 중단 → CANCELLED
```

- 파일 단계는 시작할 때 `upload_started_at`을 조건부(`status='UPLOADING'`)로 찍고, 끝에 `status='UPLOADING' and origin='upload'`일 때만 반영한다. 한 요청은 수신 5분(Node `requestTimeout`) + 검사 1분 + 다시 묶기 2분 + 저장소 5분 안에 끝나니, 시작 뒤 1시간 동안 만료되지 않으면 진행 중인 요청이 만료와 겹치지 않는다.
- 같은 행에 파일 요청이 동시에 두 개 오면 서버의 업로드 처리 슬롯(동시 1개, 6절)이 두 번째를 바로 429로 돌려준다. 다른 프로세스는 없지만(워커 하나), 혹시 둘 다 끝까지 가도 조건부 반영에서 먼저 끝난 쪽만 이긴다.
- 반영 UPDATE의 결과가 **조건 불일치로 확정**되면(행이 0개) 그 요청은 자기 파일을 지우고 시도 행도 지운 뒤 409를 돌려준다. **예외로 결과를 모르면** 파일을 지우지 않는다. 시도 행이 남아 있으니 정리 작업이 나중에 DB 참조를 확인하고 처리한다.
- **승인 취소(`unapprove`)**: 한 트랜잭션에서 영상 행과 발행 행들을 `for update`로 잠그고, 발행 행이 모두 `SCHEDULED`이면서 **한 번도 claim되지 않았을 때(`claim_seq = 0`)**만(또는 발행 행이 없는 직접 올리기) 발행 행을 지우고 `PENDING_REVIEW`, `revision+1`, 검수 메시지 id를 비운다. 처리 대기나 결과 불명으로 `SCHEDULED`에 돌아온 행은 이미 외부에 요청이 갔을 수 있어(Reels 컨테이너, Shorts 세션) 취소하지 않는다. 발행 claim은 같은 행 잠금을 기다린 뒤 행이 없어 아무것도 하지 않는다. 생성 영상에도 쓸 수 있다.
- **발행 중단(`cancel`)**: `FAILED` 발행 행을 `CANCELLED`로 바꾼다. 화면이 본 실패 시도의 `claim_seq`가 맞아야 하고, 결과를 모르는 실패(`error_kind = 'session'`)는 "채널에 올라가지 않은 것을 확인했어요"가 있어야 한다. 중단 뒤 발행 행이 모두 끝났으면(`PUBLISHED`/`CANCELLED`) 부모 영상을 마무리한다: 하나라도 `PUBLISHED`면 `PUBLISHED`(정리 14일), 아니면 `FAILED`(정리 3일). `completeIfAllPublished`와 `completePublishedVideos`도 같은 규칙을 쓴다.
- **다시 시도·중단·직접 올림의 가드는 웹과 Telegram이 같다.** 다시 시도와 중단은 `claim_seq`를 받아 `status = 'FAILED' and claim_seq = # 관리자 콘솔에서 영상 직접 올리기 (설계)

상태: 설계 (2026-10-25, Codex 설계 리뷰 2회 반영). 숏폼 파이프라인(`docs/plans/video.md`, 결정 15) 위에 얹는다.

## 1. 목표

주인이 따로 만든 영상(CapCut, 폰 편집 등)을 관리자 콘솔에서 올리면, 생성 영상과 같은 검수·예약 발행·성과 수집을 탄다. 덤으로 관리자 콘솔에 영상 목록과 상세(미리보기, 승인·승인 취소·폐기·수정, 발행 상태, 다시 시도)를 둔다. 지금은 영상을 Telegram과 CLI로만 다룰 수 있다.

하지 않는 것:

- 서버에서 다시 인코딩하지 않는다. Railway CPU로 1080p 60초 변환은 몇 분씩 걸리고 워커의 다른 일을 막는다. 규격에 맞지 않으면 이유를 알려 주고 거절한다(폰·CapCut 기본 내보내기는 대부분 H.264/AAC mp4라 맞는다). 컨테이너만 MP4로 다시 묶는다(`-c copy`, 몇 초).
- 올린 파일 교체는 하지 않는다. 잘못 올렸으면 폐기하고 다시 올린다(승인한 뒤라도 발행 전이면 승인 취소 → 폐기).
- Telegram으로 파일을 받는 경로는 만들지 않는다(봇 API로 받는 파일은 20MB까지라 쓸모가 적다).
- 저작권(음악 클레임)은 로컬에서 판정하지 않는다. 화면에서 안내만 한다(7절).

## 2. 흐름

```
관리자 /videos/new: 파일 + 제목·캡션·해시태그·출처(선택) + [올리면서 바로 승인]
 1) POST /api/videos            (JSON) → videos 행 UPLOADING (origin 'upload', post_id 없음)
 2) POST /api/videos/:id/file?approve=0|1   (영상 바이트)
      a. 시작: UPLOADING이면 upload_started_at = now() (조건부, 만료 기준)
      b. 임시 폴더로 스트리밍(실제 수신량 상한, sha256) → ffprobe 검사 → MP4로 다시 묶기
      c. 업로드 시도 키를 video_upload_attempts에 기록 → 저장소 업로드
      d. 트랜잭션: UPLOADING인 경우에만 파일 반영 + PENDING_REVIEW, 시도 행 삭제
      e. approve=1이면 승인 시도. 실패해도 파일 반영은 그대로이고 응답에 이유를 담는다
      f. 승인하지 않았거나 실패했으면 Telegram 검수 메시지를 큐에 넣는다
 이후는 생성 영상과 같다: 승인 → video_publications → video-publish → 성과 수집 → 정리
```

- 두 단계로 나누는 이유: 제목·캡션(최대 2200자)은 JSON으로, 파일은 원시 바이트로 보내야 한다. multipart 파서를 들이지 않고, 헤더나 쿼리에 한국어 캡션을 싣지도 않는다(헤더 16KB 한도). 상태는 `videos` 행이 들고 있으니 단계 사이에 끊겨도 남는 것은 `UPLOADING` 행뿐이고 maintenance가 치운다.
- 전송은 **서버 경유**다. 브라우저가 Supabase에 서명 URL로 직접 올리는 방식은 CSP `connect-src`, Supabase CORS, 업로드 뒤 서버의 재다운로드 검사가 필요하다. 서버 경유는 서비스 키와 검사가 한곳에 있고 로컬 저장소(`VIDEO_STORAGE=local`)에서도 그대로 돈다. 대가는 최대 50MB가 Railway를 지나가는 것인데, 가끔 하는 일이라 문제없다.
- **응답 계약:** 파일 경로는 `{ stored: true, approval: { ok: true, at } | { ok: false, error } | null, detail }`을 돌려준다. 파일 저장과 승인은 결과가 따로 온다.
- **화면의 재시도 규칙:** 파일 요청이 네트워크 오류나 5xx로 끝나면 화면은 먼저 `GET /api/videos/:id`로 상태를 다시 읽는다. `UPLOADING`이면 같은 행에 파일을 다시 보내고, `PENDING_REVIEW`면 파일은 들어간 것이니 상세로 가서 승인 버튼을 보여 주고, `APPROVED`면 완료로 본다. `EXPIRED`면 같은 입력값으로 새 행을 만든다.

## 3. 데이터 (`024_video_uploads.sql`)

- `videos.post_id`의 `not null`을 뺀다. 생성 영상은 여전히 글 하나에 영상 하나(unique 유지, null은 여러 개 허용).
- `videos.origin text not null default 'generated'`, `check (origin in ('generated', 'upload'))`, `check (origin = 'upload' or post_id is not null)`.
- `videos.status`에 `UPLOADING`을 더한다. 파일이 아직 없는 업로드 행이다.
- `videos.upload_started_at timestamptz`: 마지막 파일 요청이 시작한 시각(만료 기준, 4절).
- `videos.original_name text`(표시용, 120자로 자름), `videos.width`, `videos.height integer`(표시 방향 기준 해상도. Telegram 전송과 화면에 쓴다). 생성 영상은 렌더할 때 1080×1920을 채운다.
- `video_upload_attempts(key text primary key, video_id bigint, created_at timestamptz, reclaiming boolean)`: 저장소에 올리기 직전에 기록한 키. 파일 반영 트랜잭션이 `reclaiming = false`인 그 행을 **먼저 지우고**(0행이면 반영하지 않는다) 영상 행을 갱신한다. 남아 있는 행은 결과를 모르는 시도이고 정리 작업이 회수한다(8절).
- `video_publications.status`에 `CANCELLED`를 더한다. 발행을 포기한 행이다(4절).

업로드 영상은 `scenes`, `generation`, `render_hash`가 없고 `regen_seq`는 1에 머문다. 공유 타입(`VideoStatus`, `VideoRow`, 목록 타입, 웹 계약)은 `post_id: number | null`, `origin`, `UPLOADING`을 반영한다.

## 4. 상태

```
UPLOADING ─ 파일 검사·저장 성공 → PENDING_REVIEW (→ 기존 흐름)
          └ greatest(created_at, upload_started_at)에서 1시간 동안 반영이 없으면 → EXPIRED
APPROVED ─ 승인 취소(발행 행이 모두 한 번도 시도되지 않은 SCHEDULED일 때) → PENDING_REVIEW
         └ 발행 행이 모두 끝나면(PUBLISHED 또는 CANCELLED) → 하나라도 PUBLISHED면 PUBLISHED, 아니면 FAILED
발행 행 FAILED ─ 다시 시도 → SCHEDULED / 중단 → CANCELLED
```

- 파일 단계는 시작할 때 `upload_started_at`을 조건부(`status='UPLOADING'`)로 찍고, 끝에 `status='UPLOADING' and origin='upload'`일 때만 반영한다. 한 요청은 수신 5분(Node `requestTimeout`) + 검사 1분 + 다시 묶기 2분 + 저장소 5분 안에 끝나니, 시작 뒤 1시간 동안 만료되지 않으면 진행 중인 요청이 만료와 겹치지 않는다.
- 같은 행에 파일 요청이 동시에 두 개 오면 서버의 업로드 처리 슬롯(동시 1개, 6절)이 두 번째를 바로 429로 돌려준다. 다른 프로세스는 없지만(워커 하나), 혹시 둘 다 끝까지 가도 조건부 반영에서 먼저 끝난 쪽만 이긴다.
- 반영 UPDATE의 결과가 **조건 불일치로 확정**되면(행이 0개) 그 요청은 자기 파일을 지우고 시도 행도 지운 뒤 409를 돌려준다. **예외로 결과를 모르면** 파일을 지우지 않는다. 시도 행이 남아 있으니 정리 작업이 나중에 DB 참조를 확인하고 처리한다.
와 현재 `error_kind`를 한 UPDATE에서 확인한다. Telegram 버튼도 `vpub:retry:<id>:<claimSeq>`처럼 시도를 담고, 결과 불명 확인 버튼은 그 시도의 `session` 실패에만 붙는다. 예전 형식 버튼은 오래된 버튼으로 본다. 직접 올림 완료는 승인한 `revision`을 받는다(`vman:<id>:<revision>`, 웹 `{ revision }`). 그래서 승인 취소·재승인 뒤의 오래된 화면이나 버튼은 아무것도 바꾸지 못한다.
- 생성 영상 전용 경로는 업로드 영상을 건드리지 않는다: 원고 재작성(`requestRescript`, 🔁 버튼, 피드백 답장), 다시 시작(`restartVideo`), 장면 수정(`수정N:`, `화면N:`)은 `origin = 'generated'` 조건을 단다. 업로드 영상의 Telegram 검수 메시지에는 🔁 버튼이 없고, 원고 대신 제목·캡션·파일 정보를 보여 준다. 피드백 답장은 "직접 올린 영상은 다시 만들 수 없어요"로 답한다.
- 자동 선택의 주간 한도(`VIDEO_WEEKLY_MAX`)는 생성 영상(`origin='generated'`)만 센다.
- `PENDING_REVIEW`의 72시간 만료, 10분 미전송 재전송, 정리(`video-cleanup`)는 그대로 적용된다.

## 5. 파일 검사

요청마다 업로드 전용 임시 루트(`os.tmpdir()/ca-uploads/`) 아래에 `mkdtemp`로 폴더를 만들고 `finally`에서 지운다. 프로세스가 죽어 `finally`가 돌지 못한 폴더는 `video-maintenance`가 1시간 지난 것을 지운다(처리 중인 폴더는 업로드 슬롯이 알고 있어 건너뛴다). 수신은 `pipeline(req, 크기 세기+sha256, 파일)`이라 연결이 끊기거나 실제 수신량이 상한을 넘으면 바로 실패하고 정리된다. `Content-Length`가 없거나 상한보다 크면 받기 전에 413이다.

**ffprobe** (`@ffprobe-installer/ffprobe`, 플랫폼별 바이너리만 받는다)로 구조화된 JSON을 읽는다:

```
ffprobe -v error -protocol_whitelist file -f mov -print_format json -show_format -show_streams file:<임시 경로>
```

- 입력은 서버가 만든 임시 경로뿐이고, `-protocol_whitelist file`로 네트워크·다른 프로토콜을 막고, demuxer를 `-f mov`(MP4/MOV 공용)로 고정해 자동 감지(playlist 등)를 끈다. MOV 외부 참조(`enable_drefs`)는 기본값(꺼짐) 그대로 둔다.
- 자식 프로세스는 30초 제한, stdout 1MB 상한(넘으면 죽이고 거절). 다시 묶기는 2분 제한. 업로드 처리(수신~저장)는 프로세스 안에서 **동시에 하나**만 한다(나머지는 429 "다른 영상을 올리는 중이에요").

검사 기준은 Instagram Reels API 규격(Meta 공식 샘플)과 Shorts의 교집합이다.

| 항목 | 기준 | 거절 메시지 예 |
|---|---|---|
| 크기 | `VIDEO_UPLOAD_MAX_MB`(기본 50) 이하 | 50MB를 넘어요 |
| 컨테이너 | `format_name`에 `mov`/`mp4`, `major_brand`로 MP4/MOV 구분 | mp4나 mov 파일만 올릴 수 있어요 |
| 스트림 구성 | 표지 그림(`disposition.attached_pic`)을 뺀 영상 스트림 정확히 1개, 오디오 0~1개 | 영상 트랙이 하나여야 해요 |
| 영상 코덱 | h264 또는 hevc, `pix_fmt` yuv420p/yuvj420p(4:2:0), `field_order`가 progressive이거나 없음 | H.264나 HEVC(4:2:0)로 내보내 주세요 |
| 해상도 | 회전(`side_data_list`의 displaymatrix 또는 `tags.rotate`)을 반영한 높이 ≥ 너비, 가로 1920px 이하, 짧은 변 540px 이상 | 세로 영상만 / 1080p 이하로 내보내 주세요 |
| 픽셀 비율 | `sample_aspect_ratio`가 없거나 1:1 | 픽셀 비율이 1:1이어야 해요 |
| 프레임 | `avg_frame_rate`가 유한하고 23~60fps | 프레임 수가 23~60fps여야 해요 |
| 비트레이트 | 영상 25Mbps 이하(스트림 값이 없으면 크기×8/길이) | 비트레이트가 너무 높아요 |
| 오디오 | 없거나 aac, 48kHz 이하, 1~2채널, 128kbps 이하(스트림 값이 없으면 통과) | 소리는 AAC 48kHz·128kbps 이하 스테레오여야 해요 |
| 길이 | `format.duration`이 유한하고 3초 이상 180초 이하 | 3초~3분 영상만 올릴 수 있어요 |

- 9:16이 아니어도(예: 4:5) 받는다. 화면에 "Reels·Shorts는 9:16을 권장해요"만 보여 준다.
- 검사를 통과하면 `ffmpeg -protocol_whitelist file -f mov -i file:<입력> -map 0:<검사한 영상 스트림 번호> [-map 0:<오디오 번호>] -c copy -map_metadata -1 -movflags +faststart -use_editlist 0 [-tag:v hvc1] -f mp4 file:<출력>`로 다시 묶는다. 검사에서 고른 스트림 번호를 그대로 넘기므로 표지 그림이 앞에 있어도 실제 영상을 고른다. moov가 앞에 오고, 남는 트랙과 메타데이터가 빠지고, 컨테이너가 항상 MP4(`video/mp4`, `.mp4`)가 되고, Reels가 받지 않는 edit list를 쓰지 않는다. 회전 정보는 스트림 side data로 유지된다.
- 다시 묶은 파일을 한 번 더 ffprobe로 읽어 같은 규칙과 길이·해상도를 확인하고, MP4 상자 구조를 직접 읽어 `moov`가 `mdat`보다 앞에 있고 어느 트랙에도 `edts`가 없는지 확인한다.
- closed GOP와 손상된 미디어 데이터는 디코드하지 않으면 알 수 없어 검사하지 않는다. 그런 파일은 플랫폼 처리 단계에서 실패하고 기존 발행 흐름이 오류를 알린다(Reels 컨테이너 `ERROR`, Shorts 처리 실패 확인). 이때 발행 행을 중단하면(4절) 영상이 마무리된다.

## 6. API

모두 세션이 있어야 하고, 쓰기는 기존 `authorizeWrite`(같은 출처, CSRF 헤더)를 지난다. 감사 로그 이름은 `video.<action>`, `publication.<action>`이다(제목·캡션 원문은 남기지 않는다).

| 경로 | 설명 |
|---|---|
| `GET /api/videos?status=active\|all` | 목록. active = UPLOADING·SCRIPTING·RENDERING·PENDING_REVIEW·APPROVED, 그리고 최근 7일의 나머지 |
| `GET /api/videos/:id` | 상세: 영상 행, 발행 행들(`claim_seq` 포함), 합친 캡션(`fullCaption`), 원본 글(있으면), 한도(제목 100자, 캡션 2200자, 해시태그 5개, 업로드 최대 크기) |
| `POST /api/videos` | `{ title, caption, hashtags[], sourceUrl?, originalName? }` → `{ id, revision }`. 길이 검사는 `types.ts`의 한도와 `captionProblems`를 그대로 쓴다 |
| `POST /api/videos/:id/file?approve=0\|1` | 본문이 영상 바이트(`video/mp4`, `video/quicktime`). 2절의 응답. 400(검사 실패, 이유), 409(`UPLOADING`이 아님, `status` 포함), 413(크기), 415(형식), 429(다른 업로드 처리 중) |
| `POST /api/videos/:id/approve` | `{ revision }` → `approveVideo` |
| `POST /api/videos/:id/unapprove` | `{ revision }` → 승인 취소(4절) |
| `POST /api/videos/:id/reject` | `{ revision }` → `rejectVideo` |
| `POST /api/videos/:id/edit` | `{ revision, title, caption, hashtags }` → 최종 값을 한 트랜잭션에서 검증·저장, `revision+1` 한 번(`applyMetaEdit`, PENDING_REVIEW만) |
| `POST /api/videos/:id/rescript` | `{ revision, feedback? }` → `requestRescript` (생성 영상만) |
| `POST /api/videos/:id/manualDone` | `{ revision }` → `markManualPublished` (APPROVED이고 발행 행이 없고 승인한 revision일 때) |
| `POST /api/publications/:id/publishNow` | `{ scheduledAt }` → 그 발행 행이 아직 `SCHEDULED`이고 예약 시각이 화면이 본 값과 같을 때만 지금 직전으로 당긴다 |
| `POST /api/publications/:id/retry` | `{ claimSeq, confirmedNotOnChannel? }` → `FAILED`이고 `claim_seq`가 화면이 본 실패 시도와 같을 때만 다시 예약. `error_kind='session'`(Shorts 결과 불명)은 `confirmedNotOnChannel: true`가 있어야 하고 업로드 세션을 비운다(Telegram의 "확인했어요, 새로 올리기"와 같다) |
| `POST /api/publications/:id/cancel` | `{ claimSeq, confirmedNotOnChannel? }` → 같은 가드로 `CANCELLED`, 부모 영상 마무리(4절) |

- 파일 경로의 출처 검사는 JSON 대신 `Content-Type: video/mp4` 또는 `video/quicktime`을 받는다(`isSameOriginWrite`에 허용 형식을 인자로). 세션·CSRF 헤더 검사는 같고, 커스텀 헤더 때문에 다른 사이트의 단순 요청은 통과하지 못한다. 화면은 `XMLHttpRequest`로 보내며 `X-CSRF-Token`을 단다.
- 검수 동작은 화면이 본 `revision`을 가드로 쓴다(CLI와 같은 `{ revision }` 가드). 맞지 않으면 409 `{ stale: true }`이고 화면은 다시 읽는다.
- 성공한 동작은 Telegram을 버튼 누른 것과 같은 모양으로 맞춘다(최선 노력, `telegramSynced`): 검수 메시지 버튼 지우기, 승인 안내(`approvedVideoText`), 직접 올리기 안내(`sendManualUpload`).

## 7. 화면 (`web/`)

- 사이드바에 `영상`을 더한다.
- `/videos`: 상태 배지, 제목, 출처(생성 #글 / 직접 올림), 길이, 발행 행 요약(플랫폼별 상태·예약 시각), `영상 올리기` 버튼. 행을 누르면 상세 시트.
- `/videos/:id`: 플레이어(`<video controls playsinline>`, `video_url`이 https일 때만. 로컬 저장소면 "로컬 저장소라 미리보기 없음"), 제목·캡션·해시태그(PENDING_REVIEW일 때 수정), 생성 영상은 원고, 발행 행(상태, 예약·발행 시각, 링크, 오류, `지금 발행`, `다시 시도`; Shorts 결과 불명이면 "채널에 올라가지 않은 것을 확인했어요" 체크 뒤 활성), 버튼(승인, 승인 취소, 폐기, 다시 만들기, 직접 올림 완료).
- `/videos/new`: 파일 선택(파일 이름·크기·브라우저가 읽은 길이·해상도 미리 표시, 크기 초과는 바로 경고), 제목(필수), 캡션, 해시태그, 출처 주소, `올리면서 바로 승인`(기본 켬). 진행률은 `XMLHttpRequest`의 upload progress로 보여 준다. 실패하면 2절의 재시도 규칙을 따른다. 안내: "1분 넘는 Shorts에 음악이 있으면 저작권 클레임으로 재생이 막힐 수 있어요. 발행 뒤 YouTube Studio에서 확인하세요."
- CSP: `media-src 'self' <SUPABASE_URL origin>`을 더한다(설정돼 있을 때만).
- mock 모드(`npm run dev:mock`)에 영상 목록·상세·업로드 예시를 둔다.

## 8. Telegram, 정리와 만료

- 검수 메시지의 영상 전송은 저장한 `width`/`height`를 쓴다(고정 1080×1920 대신). `sendVideo`가 실패하면 같은 캡션·버튼으로 `sendDocument`를 보내고 그 메시지를 검수 메시지로 등록한다(revision 가드 동일).
- `video-maintenance`가 `greatest(created_at, upload_started_at)`에서 1시간 지난 `UPLOADING` 행을 `EXPIRED`로 바꾼다. 파일이 없으니 지울 것도 없다.
- `video-cleanup`이 1시간 넘은 `video_upload_attempts` 행을 회수한다. 먼저 `for update skip locked`로 `reclaiming = true`를 찍고 커밋한다(반영 트랜잭션이 잡고 있는 행은 건너뛴다). 이 뒤로는 그 시도가 반영될 수 없다(반영은 `reclaiming = false`인 행을 지워야만 진행한다). 그다음 어떤 `videos.storage_key`도 그 키를 참조하지 않으면 저장소에서 지우고, 성공했을 때만 행을 지운다. 참조하면(회수 표시 전에 반영이 커밋된 경우는 행이 이미 없으니 실제로는 없다) 행만 지운다. 삭제가 실패하면 행이 남아 다음 회차에 다시 한다.
- 파일 반영 트랜잭션은 `set local lock_timeout = '10s'`, `statement_timeout = '30s'`로 DB 대기를 제한한다.
- 업로드 영상의 파일도 `video-cleanup` 규칙(끝난 지 3일, 발행 14일)을 따른다. 원본은 주인에게 있다.

## 9. 설정

| 변수 | 기본 | 설명 |
|---|---|---|
| `VIDEO_UPLOAD_MAX_MB` | 50 | 올릴 수 있는 최대 크기(1~200). Supabase 무료 플랜의 파일당 한도(50MB)와 Telegram 봇의 영상 전송 한도(50MB)에 맞췄다 |

업로드는 `VIDEO_ENABLED`(자동 선택)와 상관없이 된다. 자동 발행은 기존처럼 `VIDEO_PLATFORMS`와 계정 설정을 따르고, 비어 있으면 직접 올리기 안내로 끝난다. 새 의존성은 `@ffprobe-installer/ffprobe`(Linux x64 바이너리 약 79MB)다.

## 10. 코드 배치

```
migrations/024_video_uploads.sql
src/video/probe.ts         ffprobe 실행(제한), JSON → 검사 결과(checkUpload), 다시 묶기
src/video/upload.ts        업로드 행 생성, 파일 단계(시작 기록, 시도 키, 조건부 반영, 승인), 업로드 슬롯
src/video/store.ts         origin 조건, applyMetaEdit, unapproveVideo, expireUploads, 목록·상세 로더
src/video/approve.ts       발행 행 단위 publishNow·retry 가드
src/video/cleanup.ts       업로드 시도 키 회수
src/video/telegram.ts      업로드 영상 검수 메시지(🔁 없음), sendDocument 대체, 표시 크기
src/web/video-actions.ts   경로 매칭, 본문 검증, 결과 → HTTP (post-actions.ts와 같은 모양)
src/web/server.ts          라우트, 파일 경로의 스트림 수신, CSP media-src
src/web/api-types.ts       VideoList/Detail/Action 계약
web/src/pages/videos*.tsx  목록, 상세, 업로드
```

## 11. 테스트

- 단위: ffprobe JSON 판정(회전, 오디오 없음, 표지 그림, 다중 트랙, SAR, 코덱·fps·길이·비트레이트·해상도·오디오 경계, 오디오 비트레이트), MP4 상자 읽기(edts, moov 위치), 경로 매칭과 본문 검증, 파일 경로의 출처·형식·크기·CSRF 검사(401, 403, 413, 415, 429), 수신 중 상한 초과·연결 끊김 때 임시 파일 정리, CSP.
- 실제 ffmpeg/ffprobe 스모크: B-frame이 있는 H.264/AAC mp4(다시 묶은 결과에 edts가 없음), MOV로 다시 묶은 것, 회전 메타데이터를 넣은 것, 표지 그림이 앞에 있는 것, 가로 영상(거절), 영상이 아닌 파일(거절).
- 통합(로컬 Postgres): 업로드 행 → 파일 반영 → PENDING_REVIEW, 바로 승인 성공·실패(계정 없음) 때 파일은 남고 검수 큐로 감, 조건 불일치 때 자기 파일·시도 행 삭제, 반영 예외 때 파일 유지, 시도 키 회수(참조 있음/없음/삭제 실패), 업로드 중 만료되지 않음과 1시간 만료, 승인 취소(시도 안 한 SCHEDULED만, 처리 대기로 돌아온 행이나 발행 중이면 거절, 발행 claim과의 경합), 발행 중단과 부모 마무리(일부 성공 → PUBLISHED, 전부 중단 → FAILED), 직접 올림의 revision 가드, Telegram 다시 시도 버튼의 claim_seq 가드, 회수 표시 뒤 반영 거절과 반영 중인 시도 건너뛰기, 업로드 영상의 원고 재작성·다시 시작·장면 수정 거절, 메타 수정 한 번에 revision+1, 발행 행 publishNow·retry 가드(오래된 claim_seq, session 확인 없음), 주간 한도에서 업로드 제외, 업로드 영상의 승인·발행·정리 전체 흐름.
- 웹(jsdom): 목록·상세 렌더, 업로드 폼 검증과 진행 표시, 파일 요청 실패 뒤 상태별 분기, 409 뒤 다시 읽기, 승인 취소와 다시 시도 확인 체크.
