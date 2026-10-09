# Content Autopilot

AI·개발 뉴스를 수집하고, LLM으로 Threads 글을 써서, Telegram 승인 한 번이면 정해진 시간에 자동 발행하는 개인용 도구.

```
RSS → LLM 주제 선정·중복 판정 → 기사 본문 기반 초안 → Telegram 승인 → Threads 발행
```

## 빠른 시작

```bash
npm install
cp .env.example .env      # DATABASE_URL 등 입력
npm run db:migrate
npm run cli -- daily      # 지금 바로 초안 만들어 보기
npm start                 # 워커 실행 (스케줄 + Telegram 봇)
```

`THREADS_DRY_RUN=true`인 동안에는 실제로 발행하지 않고 로그만 남긴다.

## 문서

- [외부 서비스 준비](docs/setup.md): Supabase, OpenRouter, Telegram, Meta(Threads)
- [아키텍처](docs/architecture.md): 파이프라인, 상태, 중복 발행 방지
- [운영](docs/operations.md): 매일 검수, CLI, 문제 해결, 배포
- [설계 결정](docs/decisions.md): 왜 Threads만, 왜 n8n 없이, 로드맵
- [코드 컨벤션](docs/conventions.md): 커밋 메시지(`feat: 한글 요약`), 코드·DB·job·테스트 규칙

## 개발

```bash
npm run typecheck
npm run lint
npm test
```

Node 22.12 이상 · TypeScript (tsx로 실행) · pg-boss · Supabase Postgres · OpenRouter · grammY
