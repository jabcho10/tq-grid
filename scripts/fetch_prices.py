# -*- coding: utf-8 -*-
"""
TQQQ 그리드 주문서용 종가 수집기.

- TQQQ 전일(직전 세션) 종가
- 이번 주 모드 판정에 쓰는 '직전 완료 주 마지막 QQQ 종가'
- 주문 대상 거래일

결과를 data/prices.json 으로 쓴다. 외부 키가 필요 없는 Yahoo chart API를 쓰고,
실패하면 Stooq CSV로 한 번 더 시도한다.
"""
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0 (compatible; tqqq-grid-order-desk/1.0)"}
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "prices.json")
HIST = os.path.join(os.path.dirname(__file__), "..", "data", "history.json")

# NYSE 휴장일 (index.html 의 목록과 동일하게 유지할 것)
HOLIDAYS = {
    "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
    "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18",
    "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04",
    "2028-09-04", "2028-11-23", "2028-12-25",
    "2029-01-01", "2029-01-15", "2029-02-19", "2029-03-30", "2029-05-28", "2029-06-19",
    "2029-07-04", "2029-09-03", "2029-11-22", "2029-12-25",
    "2030-01-01", "2030-01-21", "2030-02-18", "2030-04-19", "2030-05-27", "2030-06-19",
    "2030-07-04", "2030-09-02", "2030-11-28", "2030-12-25",
}


def is_trading_day(d: dt.date) -> bool:
    return d.weekday() < 5 and d.isoformat() not in HOLIDAYS


def next_trading_day(d: dt.date) -> dt.date:
    x = d + dt.timedelta(days=1)
    while not is_trading_day(x):
        x += dt.timedelta(days=1)
    return x


def get(url: str, timeout: int = 30) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def get_retry(url: str, attempts: int = 4) -> bytes:
    """429/5xx 는 러너 IP 공유 때문에 흔하다. 지수 백오프로 재시도."""
    delay, last = 3, None
    for i in range(attempts):
        try:
            return get(url)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (429, 500, 502, 503, 504):
                raise
        except Exception as exc:                                  # noqa: BLE001
            last = exc
        if i < attempts - 1:
            time.sleep(delay)
            delay *= 2
    raise last            # type: ignore[misc]


def from_yahoo(symbol: str) -> dict:
    """{date(ISO): close} — 실제 거래 종가(수정주가 아님)."""
    errors = []
    payload = None
    for host in ("query1", "query2"):
        url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{symbol}"
               f"?interval=1d&range=3mo")
        try:
            payload = json.loads(get_retry(url))
            break
        except Exception as exc:                                  # noqa: BLE001
            errors.append(f"{host}: {type(exc).__name__} {exc}")
    if payload is None:
        raise RuntimeError(" / ".join(errors))
    res = payload["chart"]["result"][0]
    stamps = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    out = {}
    for ts, close in zip(stamps, closes):
        if close is None:
            continue
        day = dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone(ET).date()
        out[day.isoformat()] = round(float(close), 4)

    # 마감 직후 몇 시간은 그날 일봉의 close 가 null 로 비어 있다. 그대로 두면
    # 한 세션 뒤처진 종가로 주문이 나간다. 정규장이 끝났으면(= 마지막 정규장
    # 체결 시각이 20분 넘게 지났으면 — 조기 마감일도 함께 걸린다) meta 의
    # 확정 종가로 그날 값을 채운다. 장중에는 건드리지 않는다.
    meta = res.get("meta") or {}
    stamp, price = meta.get("regularMarketTime"), meta.get("regularMarketPrice")
    if stamp and price is not None:
        last = dt.datetime.fromtimestamp(stamp, dt.timezone.utc).astimezone(ET)
        over = (dt.datetime.now(ET) - last) >= dt.timedelta(minutes=20)
        if over and last.date().isoformat() not in out:
            out[last.date().isoformat()] = round(float(price), 4)
    return out


def from_stooq(symbol: str) -> dict:
    today = dt.datetime.now(ET).date()
    start = today - dt.timedelta(days=120)
    url = (f"https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d"
           f"&d1={start:%Y%m%d}&d2={today:%Y%m%d}")
    text = get_retry(url, attempts=2).decode("utf-8", "replace")
    if not text.lstrip().lower().startswith("date"):
        raise ValueError("stooq returned a non-CSV body")
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        if row.get("Close") in (None, "", "N/A"):
            continue
        out[row["Date"]] = round(float(row["Close"]), 4)
    return out


def series(symbol: str) -> tuple[dict, str]:
    errors = []
    for name, fn in (("yahoo", from_yahoo), ("stooq", from_stooq)):
        try:
            data = fn(symbol)
            if data:
                return data, name
            errors.append(f"{name}: empty")
        except Exception as exc:                                  # noqa: BLE001
            errors.append(f"{name}: {type(exc).__name__} {exc}")
    raise RuntimeError(f"{symbol} 조회 실패 — " + " / ".join(errors))


def week_start(d: dt.date) -> dt.date:
    """해당 날짜가 속한 주의 월요일."""
    return d - dt.timedelta(days=d.weekday())


def build() -> dict:
    tqqq, tqqq_src = series("TQQQ")
    qqq, qqq_src = series("QQQ")

    tqqq_date = max(tqqq)
    tqqq_close = tqqq[tqqq_date]

    # 직전 세션 종가로 다음 거래일 주문을 계산한다
    order_date = next_trading_day(dt.date.fromisoformat(tqqq_date))

    # 이번 주 모드 = 주문일이 속한 주의 월요일보다 앞선 마지막 QQQ 거래일 종가
    cutoff = week_start(order_date)
    prior = [d for d in qqq if dt.date.fromisoformat(d) < cutoff]
    if not prior:
        raise RuntimeError("직전 완료 주의 QQQ 종가를 찾지 못했습니다")
    qqq_date = max(prior)

    now_et = dt.datetime.now(ET)
    partial = (tqqq_date == now_et.date().isoformat()
               and now_et.time() < dt.time(16, 5))

    payload = {
        "updated": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "source": {"tqqq": tqqq_src, "qqq": qqq_src},
        "tqqq": {"date": tqqq_date, "close": tqqq_close},
        "qqq_week": {"date": qqq_date, "close": qqq[qqq_date]},
        "order_date": order_date.isoformat(),
        "partial": partial,
    }
    return payload, tqqq, qqq


def merge_history(tqqq: dict, qqq: dict) -> int:
    """백테스트가 읽는 일별 종가(history.json)에 새 거래일을 이어 붙인다.

    주문서와 백테스트가 같은 시세를 보게 하는 연결 고리다. 기존 값은 손대지
    않고 뒤에만 덧붙이므로, 과거 구간의 백테스트 결과는 그대로 유지된다.
    """
    with open(HIST, encoding="utf-8") as fh:
        hist = json.load(fh)

    last = hist["dates"][-1]
    known = set(hist["dates"])
    fresh = sorted(d for d in tqqq if d > last and d not in known and d in qqq)
    if not fresh:
        return 0

    expected = next_trading_day(dt.date.fromisoformat(last)).isoformat()
    if fresh[0] != expected:
        print(f"경고: {last} 다음 거래일 {expected} 이 수집 범위 밖입니다 — "
              f"{fresh[0]} 부터 붙입니다. 백테스트 구간에 구멍이 생깁니다.",
              file=sys.stderr)

    for day in fresh:
        hist["dates"].append(day)
        hist["tqqq"].append(round(tqqq[day], 4))
        hist["qqq"].append(round(qqq[day], 4))

    with open(HIST, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(hist, fh, separators=(",", ":"))
    return len(fresh)


def main() -> int:
    try:
        data, tqqq, qqq = build()
    except Exception as exc:                                      # noqa: BLE001
        print(f"수집 실패: {exc}", file=sys.stderr)
        return 1

    # 백테스트 시계열은 야후 종가로만 이어 붙인다. 대체 소스는 조정 방식이
    # 달라질 수 있어, 과거 구간과 섞이면 백테스트 결과를 조용히 왜곡한다.
    if data["source"]["tqqq"] == "yahoo" and data["source"]["qqq"] == "yahoo":
        try:
            added = merge_history(tqqq, qqq)
            print(f"history.json: 거래일 {added}일 추가", file=sys.stderr)
        except Exception as exc:                                  # noqa: BLE001
            print(f"history.json 갱신 실패: {exc}", file=sys.stderr)   # 시세 갱신은 계속한다
    else:
        print("history.json: 야후가 아닌 소스라 이어 붙이지 않았습니다.", file=sys.stderr)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
