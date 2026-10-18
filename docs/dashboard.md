# 웹 대시보드

읽기 전용 현황 페이지다. Telegram을 열지 않고도 폰에서 파이프라인 상태, 체험단 진행, 최근 Threads 글을 볼 수 있다. DB에는 쓰지 않는다. 승인·패스·재시도 같은 조작은 계속 Telegram에서 한다.

워커 안에서 뜬다. 별도 프로세스나 의존성 없이 `node:http`로 같은 워커 안에서 돈다 (`src/web/`).

## 켜기

| 환경 변수 | 설명 |
|---|---|
| `DASHBOARD_PASSWORD` | 설정하면 대시보드가 켜진다. 비어 있으면 시작하지 않고 로그만 남긴다. |
| `PORT` | 수신 포트. Railway가 자동으로 주입하고, 없으면 8080이다. |

로그인은 HTTP Basic 인증이다. 사용자 이름은 아무 값이나 되고, 비밀번호가 `DASHBOARD_PASSWORD`와 같아야 한다. 긴 무작위 문자열을 쓴다 (예: `openssl rand -base64 24`).

## Railway 설정

1. 클라우드 워커 서비스의 Variables에 `DASHBOARD_PASSWORD`를 추가한다.
2. Settings > Networking에서 **Generate Domain**으로 공개 도메인을 만든다. 대상 포트는 Railway가 주입한 `PORT`를 따른다.

HTTPS는 Railway가 처리한다. Basic 인증은 비밀번호가 평문으로 가므로 반드시 HTTPS 주소로만 접속한다.

로컬에서 확인할 때는 `DASHBOARD_PASSWORD=test npm start` 후 http://localhost:8080 을 연다.

## 페이지

- `/` 현황: Threads 검수 대기, 발행 예정, 최근 24시간 발행, 실패와 체험단 단계별 개수(검수 대기, 신청함·결과 대기, 선정·리뷰 전, 리뷰 초안, 최근 30일 리뷰 완료)를 보여준다. 체험단 마지막 수집 시각과 그때 확인한 체험단 수(가장 최근 `last_seen_at`에서 10분 이내)도 함께 나온다. 「출처별」 카드는 출처마다 진행 중 개수(검수 대기, 신청함, 선정, 초안 검수의 합)와 전체 개수를 보여주고, 누르면 그 출처의 목록(`/campaigns?source=…`)으로 간다.
- `/campaigns?status=active|all|<STATUS>&source=kakao-gift|musinsa` 체험단 목록. 상태 칩 위에 출처 칩(전체 / 선물하기 / 무신사)이 있어 출처로 거를 수 있다. 알 수 없는 `source` 값은 전체로 본다. 상태 필터와 출처 필터는 함께 걸린다. 제목(상세 링크), 출처, 브랜드, 상태, 경쟁률(`1,234:1`, 모르면 `-`. 무신사는 인원이 없어 항상 `-`), 마감 D-n, 점수를 보여준다. 신청 전·결과 대기 단계는 신청 마감, 선정·리뷰 초안 단계는 리뷰 마감을 쓴다. 신청 마감은 남은 일수로 추정한 값이라 `추정`이라고 표시한다. 마감이 가까운 순으로 정렬하고 마감이 없는 행은 뒤로 간다. 최대 300건.
- `/campaigns/<id>` 체험단 상세: 썸네일, 제목, 출처, 브랜드, 상품 ID, 모집·신청 인원과 경쟁률(선물하기만. 무신사는 대신 정가, 상품 수, 리뷰 형식 영상/사진), 남은 일수, 신청 마감(추정), 처음·마지막으로 본 시각, 점수와 이유, 제외·패스 사유, 신청·선정·결과·리뷰 완료 시각, 리뷰 마감, 보낸 리마인더, 메모, 리뷰 초안, 출처 링크(`선물하기에서 열기` / `무신사에서 열기`).
- `/posts` 최근 Threads 글 50개와 최신 반응 수치.
- `/healthz` 인증 없이 `ok`를 돌려준다. 헬스체크용이다.

목록 페이지는 60초마다 자동으로 새로고침된다.

## 보안

- GET/HEAD만 허용하고 나머지는 405를 돌려준다.
- 비밀번호는 양쪽을 해시한 뒤 `timingSafeEqual`로 비교한다.
- 모든 동적 텍스트는 HTML 이스케이프하고, `http(s)` URL만 링크로 만든다.
- 썸네일은 `https`이고 호스트가 `st.kakaocdn.net`, `t1.daumcdn.net`, `img1.kakaocdn.net`, `gift-s.kakaocdn.net`(선물하기), `image.msscdn.net`(무신사)인 URL만 그린다. CSP `img-src`도 같은 호스트만 허용한다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보낸다.

## 알려진 한계

- Threads 글의 permalink는 DB에 없어서 표시하지 않는다.
- 인증 실패 횟수 제한이 없다. 비밀번호를 충분히 길게 둔다.
