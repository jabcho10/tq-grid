# TQQQ 그리드 주문서

QQQ 장기 중심주가로 매매 모드를 판정하고, 그날 낼 TQQQ LOC·MOC 주문을 지정가와
수량까지 계산하는 정적 페이지입니다. GitHub Pages로 서빙하고 종가는 GitHub
Actions가 매 거래일 자동으로 갱신합니다.

## 동작

```
매 거래일 22:00 UTC
  └─ .github/workflows/update-prices.yml
       └─ scripts/fetch_prices.py   ← Yahoo chart API (실패 시 Stooq)
            └─ data/prices.json 커밋 → Pages 재배포
                 └─ index.html 이 로드 시 fetch
```

`data/prices.json`

| 필드 | 뜻 |
|---|---|
| `tqqq` | 직전 세션 TQQQ 종가와 날짜 — 매수 지정가의 기준 |
| `qqq_week` | 주문일이 속한 주의 **직전 완료 주** 마지막 QQQ 종가 — 모드 판정의 기준 |
| `order_date` | 주문 대상 거래일 (TQQQ 종가일의 다음 거래일) |
| `partial` | 장중 수집 여부. `true`면 종가가 확정되지 않은 값 |
| `source` | 실제로 응답한 데이터 소스 |

수집 종가는 **배당 미조정 종가**입니다. 직전 세션 종가는 실제 거래 종가와 같으므로
주문 지정가에 그대로 씁니다.

## 액면분할

`data/history.json`의 종가는 **액면분할 조정 시계열**이고, `splits`에 종목별 분할
이력이 들어 있습니다. 백테스트는 이 이력으로 당시 실제 호가를 되돌려 센트 단위
지정가와 정수 주식을 실제 크기로 적용합니다(분할일에는 보유 수량 × 비율, 매수가 ÷
비율). 조정 시계열 그대로 쓰면 2011년 TQQQ가 $0.40이 되어 1센트가 가격의 2.5%가
되므로 초기 구간 성과가 부풀려집니다.

수집기는 야후가 새 분할을 알려 주면 `splits`에 추가하고 저장된 이전 종가를 같은
비율로 나눕니다. 주문서의 보유 포지션은 자동으로 바뀌지 않으니, **분할일에는 매수가와
수량을 증권사에 표시된 값으로 고쳐야** 익절가와 MOC 수량이 맞습니다.


## 보유 포지션

브라우저 `localStorage`에만 저장됩니다. 레포에는 올라가지 않으므로 공개 저장소여도
보유 내역은 노출되지 않습니다. 다만 **기기·브라우저마다 따로 저장**되므로 PC와
폰이 동기화되지 않습니다.

## 로컬 실행

```bash
python scripts/fetch_prices.py     # data/prices.json 갱신
python -m http.server 8000         # http://localhost:8000
```

`index.html`은 의존성이 없는 단일 파일입니다. 폰트만 Google Fonts에서 받아오고
나머지 CSS·JS는 모두 인라인입니다.

## 휴장일

경과 거래일 계산에 NYSE 휴장일이 필요합니다. `index.html`의 `HOLIDAYS`와
`scripts/fetch_prices.py`의 `HOLIDAYS`에 2030년까지 들어 있습니다. **두 목록은
같은 값을 유지해야 합니다.**

## 면책

백테스트 규칙을 그대로 옮긴 계산 보조 도구입니다. 실제 체결가, 수수료, 세금,
환전비용, 증권사 주문환경에 따라 결과는 달라집니다. 과거 성과는 미래 수익을
보장하지 않습니다.
