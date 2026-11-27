# DART MCP 서버 (Claude 커스텀 커넥터용)

OpenDART API를 Claude 커넥터로 쓰기 위한 원격 MCP 서버. Cloudflare Workers에서 돈다.
한 번 등록하면 웹·데스크톱·모바일의 모든 Claude 대화방에서 DART를 직접 조회할 수 있다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `search_company` | 회사명 → DART 고유번호(corp_code). 상장사는 부분 일치, 비상장사는 앞부분 일치 |
| `search_disclosures` | 공시 목록 검색 (회사·기간·공시유형·보고서명 키워드). 접수번호와 DART 링크 포함 |
| `get_disclosure_text` | 접수번호로 공시 원문 본문 추출. `keyword`를 주면 해당 부분만 발췌 |
| `get_company_info` | 기업개황 (대표자, 주소, 업종코드, 설립일, 결산월 등) |
| `get_financials` | 정기보고서 재무제표 주요 계정의 당기·전기·전전기 금액과 전년비 증감률 |

회사명 → corp_code 변환은 `corp-index/` 폴더의 인덱스를 쓴다. 이 인덱스는
`.github/workflows/corp-index.yml`이 매주 월요일 새벽 OpenDART `corpCode.xml`로 다시 만든다.

## 설치 (처음 한 번)

1. **인덱스 만들기**: GitHub 저장소 → Actions → "DART 회사코드 인덱스" → Run workflow.
   (`DART_API_KEY` 비밀값은 기존 공시 모니터용으로 이미 등록돼 있어야 함.) 끝나면 `corp-index/` 폴더가 생긴다.
2. **Cloudflare에 Worker 만들기**: dash.cloudflare.com → Workers & Pages → Create → Import a repository
   → GitHub 연결 → 이 저장소 선택.
   - Project name: `dart-mcp` (wrangler.toml의 name과 같아야 함)
   - Root directory(경로): `mcp-server`
   - Build command는 비워두고, Deploy command는 기본값 `npx wrangler deploy`
3. **비밀값 등록**: 만든 Worker → Settings → Variables and Secrets → Add (Type: Secret)
   - `DART_API_KEY` = OpenDART 인증키
   - `MCP_TOKEN` = 길고 무작위인 문자열 (커넥터 주소의 비밀번호 역할)
   등록 후 Deployments에서 다시 배포하거나 저장소에 커밋을 하나 푸시한다.
4. **주소 확인**: `https://dart-mcp.<내 서브도메인>.workers.dev/health` 가 `ok`를 돌려주면 정상.
5. **Claude에 등록**: claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가
   - 이름: `DART`
   - URL: `https://dart-mcp.<내 서브도메인>.workers.dev/mcp/<MCP_TOKEN>`
   - OAuth 설정은 비워둔다.

## 보안

- 커넥터 URL 자체가 비밀번호다. URL을 아는 사람은 내 OpenDART 키 한도로 조회할 수 있으니 공유하지 말 것.
  새어나가면 Cloudflare에서 `MCP_TOKEN`만 바꾸고 커넥터 URL을 새로 등록하면 된다.
- API 키는 Cloudflare 비밀값에만 있고 응답·오류 메시지에 들어가지 않는다.

## 한계

- Cloudflare 무료 플랜은 요청당 CPU 10ms 제한이 있다. 목록·기업개황·재무 조회는 대체로 문제없지만,
  사업보고서처럼 큰 원문을 `get_disclosure_text`로 풀면 1102 오류(resource limits)가 날 수 있다.
  그때는 Workers Paid(월 5달러) 플랜으로 올리면 된다.
- 회사를 지정하지 않은 전체 공시 검색은 OpenDART 규칙상 기간이 3개월 이내여야 한다.
- 원문 추출은 표를 `|`로 이어 붙인 텍스트다. 숫자를 기사에 쓸 때는 DART 링크로 원본을 확인할 것.

## 테스트

```
cd mcp-server && node test/smoke.mjs
```
OpenDART 응답을 흉내 낸 오프라인 테스트 (MCP 프로토콜, 회사 찾기, 원문 압축 해제·EUC-KR, 재무 증감률).
