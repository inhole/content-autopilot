# 웹 대시보드

읽기 전용 현황 페이지입니다. 폰에서 Telegram 없이도 파이프라인 상태, 체험단 진행, 최근 Threads 글을 볼 수 있습니다. DB에는 절대 쓰지 않습니다.

## 켜기

| 환경 변수 | 설명 |
|---|---|
| `DASHBOARD_PASSWORD` | 설정하면 대시보드가 켜집니다. 비우면 시작하지 않고 로그만 남깁니다. |
| `PORT` | 수신 포트. Railway가 자동 주입하며, 없으면 8080입니다. |

로그인은 HTTP Basic 인증입니다. 사용자 이름은 아무 값이나 되고, 비밀번호가 `DASHBOARD_PASSWORD`와 같아야 합니다. 긴 무작위 문자열을 쓰세요.

## Railway 설정

1. 클라우드 워커 서비스의 Variables에 `DASHBOARD_PASSWORD`를 추가합니다.
2. Settings > Networking에서 Generate Domain으로 공개 도메인을 만듭니다. 대상 포트는 Railway가 주입한 `PORT`를 따릅니다.
3. 로컬 워커(Windows PC)에는 `DASHBOARD_PASSWORD`를 넣지 마세요. 클라우드 역할에서만 시작합니다.

HTTPS는 Railway가 처리합니다. Basic 인증은 HTTPS에서만 쓰세요.

## 페이지

- `/` 현황: Threads 검수 대기, 발행 예정, 최근 24시간 발행, 실패, 체험단 단계별 개수, 로컬 워커 마지막 신호(30분 넘으면 경고).
- `/campaigns?status=active|all|<STATUS>` 체험단 목록. 가장 가까운 마감 순.
- `/campaigns/<id>` 체험단 상세: 공고, 평가, 신청 메시지, 오류, 시각, 알림 발송, 사진 수, 블로그 초안.
- `/posts` 최근 Threads 글 50개와 최신 반응 수치.
- `/healthz` 인증 없이 `ok`를 돌려줍니다. 헬스체크용입니다.

목록 페이지는 60초마다 자동 새로고침됩니다.

## 보안

- GET/HEAD만 허용하고 나머지는 405입니다.
- 비밀번호는 해시 후 `timingSafeEqual`로 비교합니다.
- 모든 동적 텍스트는 HTML 이스케이프하고, `http(s)` URL만 링크로 만듭니다.
- CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`를 보냅니다.

## 알려진 한계

- Threads 글의 permalink는 DB에 저장하지 않아 표시하지 않습니다.
- 인증 실패 횟수 제한은 없습니다. 비밀번호를 충분히 길게 두세요.
