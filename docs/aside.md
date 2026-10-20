# Aside 브라우저 스크립트

Aside는 주인 PC에서 주인 계정으로 로그인된 채로 도는 브라우저다. 로그인이 필요한 사이트를 읽거나, 나중에 자동 신청을 붙일 때 쓴다. 이 저장소는 `aside repl`(Playwright 형식 JavaScript를 Aside 브라우저에서 실행)로 돌릴 스크립트를 `aside/scripts/`에 파일로 모아 두고 CLI로 실행한다.

워커는 Aside를 쓰지 않는다. 지금은 사람이 CLI로 돌리는 조사·점검 도구다.

## 실행

Aside 데스크톱 앱이 켜져 있어야 한다. 로그인이 필요한 사이트는 Aside에서 먼저 직접 로그인해 둔다.

```bash
npm run cli -- aside:list                               # 스크립트 목록과 인자
npm run cli -- aside:run tabs                           # Aside에 열린 탭
npm run cli -- aside:run snapshot url=https://kream.co.kr/ interactive=true
npm run cli -- aside:run links url=https://kream.co.kr/ match=이벤트
npm run cli -- aside:run fetch url=https://example.com/api/list
```

결과는 JSON으로 출력된다. `aside` 실행 파일은 `ASIDE_BIN`, 없으면 `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`, 그것도 없으면 PATH의 `aside`를 쓴다. Aside 계정이 여럿이면 `ASIDE_ACCOUNT`(예: `u1`)로 고른다.

## 들어 있는 스크립트

| 이름 | 인자 | 하는 일 |
|---|---|---|
| `tabs` | 없음 | 열린 탭의 제목과 주소. 탭에 붙지 않는다 |
| `snapshot` | `url`, `interactive`(선택) | 새 탭으로 열고 접근성 트리를 돌려준 뒤 탭을 닫는다. `interactive=true`면 누를 수 있는 요소만 |
| `links` | `url`, `match`(선택) | 새 탭으로 열고 링크(텍스트, 절대 주소)를 돌려준 뒤 닫는다. `match`가 들어간 것만 |
| `fetch` | `url` | 주인 쿠키로 GET 하고 상태, 형식, 본문(JSON이면 파싱)을 돌려준다. 그 도메인 탭이 없으면 잠깐 열었다 닫는다 |

모두 읽기만 한다. 클릭·입력·신청처럼 사이트 상태를 바꾸는 스크립트를 추가할 때는 이름과 설명에 그 사실을 적고, 실행 전에 사람이 확인하는 흐름을 둔다.

## 스크립트 추가하기

`aside/scripts/<이름>.js` 파일 하나가 스크립트 하나다. 이름은 영어 소문자, 숫자, `-`만 쓴다.

```js
// 한 줄 이상의 설명. aside:list에 그대로 나온다.
// args: url, match?
const tab = await openTab(args.url)
try {
  return { title: await tab.title() }
} finally {
  await closeTab(tab)
}
```

- 맨 위 `//` 주석이 설명이고, `// args:` 줄이 인자 선언이다. `?`가 붙으면 선택 인자다. 선언하지 않은 인자나 빠진 필수 인자는 실행 전에 거절한다.
- 파일 본문은 async 함수 몸통으로 실행된다. `args`(문자열 객체)를 쓸 수 있고 `return` 값이 JSON으로 출력된다. `import`/`require`는 못 쓴다.
- 쓸 수 있는 전역: `openTab`, `closeTab`, `listBrowserTabs`, `attachBrowserTab`, `snapshot`, `fetch`, `sleep` 등. 자세한 것은 `aside guide repl`.
- 연 탭은 `finally`에서 `closeTab`으로 닫는다. `page.close()`나 `newPage()`는 쓰지 않는다.
- 한 번 실행은 120초 안에 끝나야 한다(`aside repl` 제한).

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| `Aside is not running on this machine` | Aside 앱을 켠다. CLI가 없으면 `ASIDE_BIN`을 설정한다 |
| `aside repl printed no result` | 스크립트가 중간에 예외를 냈다. 출력 앞부분에 Aside의 오류 메시지가 있다 |
| 로그인 페이지가 나온다 | Aside 브라우저에서 그 사이트에 직접 로그인한 뒤 다시 돌린다 |
