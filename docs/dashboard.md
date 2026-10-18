# 웹 대시보드

읽기 전용 현황 페이지다. Telegram을 열지 않고도 폰에서 파이프라인 상태, 체험단 진행, 최근 Threads 글을 볼 수 있다. DB에는 쓰지 않는다. 승인·패스·재시도 같은 조작은 계속 Telegram에서 한다.

클라우드 워커(`WORKER_ROLE=cloud`)에서만 뜬다. 별도 프로세스나 의존성 없이 `node:http`로 같은 워커 안에서 돈다 (`src/web/`).

## 켜기

| 환경 변수 | 설명 |
|---|---|
| `DASHBOARD_PASSWORD` | 설정하면 대시보드가 켜진다. 비어 있으면 시작하지 않고 로그만 남긴다. |
| `PORT` | 수신 포트. Railway가 자동으로 주입하고, 없으면 8080이다. |

로그인은 HTTP Basic 인증이다. 사용자 이름은 아무 값이나 되고, 비밀번호가 `DASHBOARD_PASSWORD`와 같아야 한다. 긴 무작위 문자열을 쓴다 (예: `openssl rand -base64 24`).

## Railway 설정

1. 클라우드 워커 서비스의 Variables에 `DASHBOARD_PASSWORD`를 추가한다.
2. Settings > Networking에서 **Generate Domain**으로 공개 도메인을 만든다. 대상 포트는 Railway가 주입한 `PORT`를 따른다.
3. 로컬 워커(Windows PC)에는 `DASHBOARD_PASSWORD`를 넣지 않는다. 넣어도 로컬 역할에서는 시작하지 않는다.

HTTPS는 Railway가 처리한다. Basic 인증은 비밀번호가 평문으로 가므로 반드시 HTTPS 주소로만 접속한다.

로컬에서 확인할 때는 `DASHBOARD_PASSWORD=test npm start` 후 http://localhost:8080 을 연다.

## 페이지

- `/` 현황: Threads 검수 대기, 발행 예정, 최근 24시간 발행, 실패, 체험단 단계별 개수, 로컬 워커 마지막 응답 (30분 넘으면 경고 표시).
- `/campaigns?status=active|all|<STATUS>` 체험단 목록. 단계별 다음 마감 순으로 정렬한다 (신청 전은 신청 마감, `APPLIED`는 발표일, 그 밖은 리뷰 마감). 최대 300건.
- `/campaigns/<id>` 체험단 상세: 공고 내용, 선별 점수와 이유, 신청 메시지, 오류, 단계별 시각, 보낸 리마인더, 사진 수, 블로그 초안.
- `/posts` 최근 Threads 글 50개와 최신 반응 수치.
- `/healthz` 인증 없이 `ok`를 돌려준다. 헬스체크용이다.

목록 페이지는 60초마다 자동으로 새로고침된다.

## 보안

- GET/HEAD만 허용하고 나머지는 405를 돌려준다.
- 비밀번호는 양쪽을 해시한 뒤 `timingSafeEqual`로 비교한다.
- 모든 동적 텍스트는 HTML 이스케이프하고, `http(s)` URL만 링크로 만든다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보낸다.

## 알려진 한계

- Threads 글의 permalink는 DB에 없어서 표시하지 않는다.
- 인증 실패 횟수 제한이 없다. 비밀번호를 충분히 길게 둔다.
