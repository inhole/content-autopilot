# 코드 컨벤션

## 커밋 메시지

```
<type>: <한글 요약>

<본문 (선택): 무엇을, 왜 바꿨는지>
```

예:
```
feat: Telegram 검수 메시지에 수정 답장 기능 추가
fix: 컨테이너 만료 시 새 컨테이너로 재발행
docs: Threads 토큰 발급 절차 보완
```

| type | 언제 |
|---|---|
| `feat` | 기능 추가 |
| `fix` | 버그 수정 |
| `docs` | 문서만 변경 |
| `refactor` | 동작 변화 없는 구조 개선 |
| `test` | 테스트 추가·수정 |
| `chore` | 설정, 의존성, 빌드 등 기타 |
| `perf` | 성능 개선 |

**요약 줄**
- 한글로 쓰고, 50자 안팎으로 맞춘다.
- 끝에 마침표를 찍지 않는다.
- "~ 추가", "~ 수정"처럼 명사형으로 끝낸다.
- 범위를 밝히고 싶으면 scope를 붙인다. 예: `fix(publish): …`

**본문**
- 요약 줄 아래 한 줄을 비우고 쓴다.
- diff만 봐서는 알 수 없는 **이유**를 적는다.

**자동 검사 (commit-msg hook)**

`npm install`을 하면 `prepare` 스크립트가 `git config core.hooksPath .githooks`를 설정한다. 그 뒤로는 모든 커밋이 `scripts/commit-msg.mjs`의 검사를 거친다.

검사 항목:
- `<type>(scope)?: <요약>` 형식
- 요약에 한글이 들어 있는지
- 요약 끝에 마침표가 없는지
- 요약 줄이 72자 이하인지
- 요약 줄 다음에 빈 줄이 있는지

검사에 걸리면 커밋이 거부되고 이유가 출력된다. `Merge`, `Revert`, `fixup!`, `squash!`처럼 git이 만드는 메시지는 검사하지 않는다.

> 72자는 하드 리밋이다. 목표는 50자 안팎이다.

**커밋 단위**
- 커밋 하나에는 한 가지 목적만 담는다. 코드 변경과 그 변경을 설명하는 문서 수정은 같은 커밋에 넣어도 된다.

## 언어

| 대상 | 언어 |
|---|---|
| 코드, 식별자, 주석, 로그 | 영어 |
| LLM 프롬프트 (`src/pipeline/prompts.ts`) | 한국어 |
| Telegram 메시지 등 사용자에게 보이는 문구 | 한국어 |
| `docs/`, README | 한국어 |
| `CLAUDE.md` | 영어 |

## TypeScript

- ESM과 `tsx`로 실행하며 빌드 단계는 없다. import에는 `.ts` 확장자를 붙인다 (`import { query } from '../db/pool.ts'`).
- `strict`와 `noUncheckedIndexedAccess`를 켠다. 배열 인덱스 결과는 `undefined`일 수 있다고 보고 처리한다.
- 포맷과 lint는 Biome가 맡는다 (2칸 들여쓰기, 작은따옴표, 세미콜론 없음, 100자). 커밋 전에 `npm run format`을 실행한다.
- **외부에서 들어오는 값은 zod로 검증한다.** 대상은 env(`src/config.ts`), 외부 API 응답, LLM 출력이다. 타입 단언(`as`)으로 넘기지 않는다.
- 외부 서비스는 인터페이스 뒤에 둔다 (예: `ThreadsApi`). 테스트용 fake와 dry-run 구현을 끼워 넣을 수 있게 하기 위해서다.
- 주석은 코드만 봐서는 알 수 없는 **이유**만 적는다.

## DB

- SQL은 `query()` 헬퍼로 직접 쓴다. 값은 반드시 `$1` 파라미터로 넘긴다.
- 스키마는 `migrations/NNN_설명.sql`로 바꾼다. 이미 적용된 파일은 고치지 않고 새 번호로 추가한다.
- 상태값은 대문자 문자열로 쓰고, `check` 제약으로 허용 값을 고정한다. 상태를 추가하면 `docs/architecture.md`의 상태 그림도 같이 고친다.
- 동시에 실행될 수 있는 작업(발행 등)은 `UPDATE … WHERE status = … RETURNING`으로 행을 선점한 다음 진행한다.

## Job

- 큐, 스케줄, 핸들러는 `src/jobs.ts`에만 정의한다.
- 핸들러는 다시 실행돼도 결과가 같아야 한다(멱등). 외부에 부수효과가 있는 작업은 DB 상태를 기준으로 재시도한다. job 자체의 재시도에 기대지 않는다.
- 다시 시도해도 소용없는 실패(예: 기사 본문 없음)는 전용 에러(`SkipTopicError`)로 구분해서 재시도하지 않는다.

## 테스트

- `test/*.test.ts`에 vitest로 작성한다.
- DB나 네트워크 없이 검증할 수 있게, 핵심 로직은 순수 함수로 분리한다. 예: `nextFreeSlot`, `pickTop`, `driveContainer`.
- 실제 외부 API를 부르는 테스트는 만들지 않는다. 연결 확인은 CLI로 한다 (`threads:check`, `daily`).
- 기본값이 config에서 오는 매개변수에 `undefined`를 넘기면 로컬 `.env`의 실제 값이 쓰인다. 테스트에서는 값을 명시한다.
- DB가 필요한 시나리오는 `test/integration/`에 쓴다. CI의 `integration` job이 pgvector Postgres로 실행한다. 로컬 실행 방법은 operations.md에 있다.
- main에 push하기 전에 `npm run typecheck && npm run lint && npm test`가 통과해야 한다. CI도 같은 검사를 한다.
