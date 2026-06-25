#!/usr/bin/env python3
"""Fetch Wind Lujiazui + Wall Street CN breakfast articles to data/."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
ARTICLES = DATA / "articles"
WSCN_DIR = DATA / "wscn"
LOG = DATA / "fetch.log"

WSCN_API = "https://api-one-wscn.awtmt.com/apiv1"
WSCN_APP_ID = "01EAG2E98SBX2KRVFF0EVR20KV"
HEADERS = {"x-app-id": WSCN_APP_ID, "User-Agent": "Mozilla/5.0"}


def log(msg: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    line = f"{datetime.now().isoformat()} {msg}\n"
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line)
    print(msg)


def market_reference_date(breakfast: date) -> date:
    """Breakfast published morning of D describes prior trading day."""
    d = breakfast - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def strip_html(html: str) -> str:
    text = re.sub(r"<[^>]+>", "", html or "")
    return re.sub(r"\s+", " ", text).strip()


def fetch_wscn_by_date(target: date) -> dict | None:
    title_pat = f"早餐FM-Radio | {target.year}年{target.month}月{target.day}日"
    for offset in range(0, 200, 20):
        url = f"{WSCN_API}/content/articles?channel=global-channel&limit=20&cursor={offset}&accept=article"
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        payload = r.json()
        items = payload.get("data", {})
        if isinstance(items, dict):
            items = items.get("items", [])
        elif isinstance(items, str):
            continue
        for item in items or []:
            if title_pat in item.get("title", ""):
                aid = item["id"]
                detail = requests.get(f"{WSCN_API}/content/articles/{aid}?extract=0", headers=HEADERS, timeout=30)
                detail.raise_for_status()
                art = detail.json()["data"]
                return {
                    "breakfast_date": target.isoformat(),
                    "market_reference_date": market_reference_date(target).isoformat(),
                    "title": art.get("title", ""),
                    "source": "wallstreetcn",
                    "article_id": aid,
                    "content": strip_html(art.get("content", "")),
                }
    return None


def fetch_wind_163(target: date) -> dict | None:
    """Best-effort Wind mirror via 163 search API pattern."""
    q = f"陆家嘴财经早餐{target.year}年{target.month}月{target.day}日"
    search = requests.get(
        "https://www.163.com/search",
        params={"keyword": q},
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=30,
    )
    m = re.search(r"/dy/article/([A-Z0-9]+)", search.text)
    if not m:
        return None
    url = f"https://www.163.com/dy/article/{m.group(1)}.html"
    page = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    page.raise_for_status()
    # extract body lines between numbered items
    lines = []
    for line in page.text.split("\n"):
        line = re.sub(r"<[^>]+>", "", line).strip()
        if re.match(r"^\d+、", line) or re.match(r"^•", line) or "陆家嘴" in line:
            lines.append(line)
    content = "\n".join(lines[:80]) if lines else strip_html(page.text)[:12000]
    weekdays = "一二三四五六日"
    wd = weekdays[target.weekday()]
    return {
        "breakfast_date": target.isoformat(),
        "market_reference_date": market_reference_date(target).isoformat(),
        "title": f"陆家嘴财经早餐{target.year}年{target.month}月{target.day}日星期{wd}",
        "source": "wind_163_mirror",
        "url": url,
        "content": content,
    }


def backfill_window(today: date) -> list[date]:
    days = [today - timedelta(days=i) for i in range(2, -1, -1)]
    if any(d.weekday() >= 5 for d in days):
        days = [today - timedelta(days=i) for i in range(4, -1, -1)]
    return days


def save_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def run_fetch(target: date | None, fetch_only: bool) -> int:
    DATA.mkdir(parents=True, exist_ok=True)
    today = target or date.today()
    dates = backfill_window(today)
    window = 5 if len(dates) > 3 else 3

    missing_wind: list[str] = []
    missing_wscn: list[str] = []
    recent_articles: list[str] = []
    recent_wscn: list[str] = []

    for d in dates:
        ds = d.isoformat()
        wind_path = ARTICLES / f"{ds}.json"
        wscn_path = WSCN_DIR / f"{ds}.json"

        if not wind_path.exists():
            try:
                wind = fetch_wind_163(d)
                if wind and wind.get("content"):
                    save_json(wind_path, wind)
                else:
                    missing_wind.append(ds)
            except Exception as e:
                log(f"Wind fetch failed {ds}: {e}")
                missing_wind.append(ds)

        if not wscn_path.exists():
            try:
                wscn = fetch_wscn_by_date(d)
                if wscn and wscn.get("content"):
                    save_json(wscn_path, wscn)
                else:
                    missing_wscn.append(ds)
            except Exception as e:
                log(f"WSCN fetch failed {ds}: {e}")
                missing_wscn.append(ds)

        if wind_path.exists():
            recent_articles.append(str(wind_path))
        if wscn_path.exists():
            recent_wscn.append(str(wscn_path))

    main_ds = today.isoformat()
    article_path = ARTICLES / f"{main_ds}.json"
    wscn_article = WSCN_DIR / f"{main_ds}.json"

    title = ""
    if article_path.exists():
        title = json.loads(article_path.read_text(encoding="utf-8")).get("title", "")

    print(f"ARTICLE_PATH={article_path}")
    print(f"DATE={main_ds}")
    print(f"TITLE={title}")
    print(f"WSCN_ARTICLE_PATH={wscn_article}")
    print(f"WSCN_DATE={main_ds}")
    wscn_title = ""
    if wscn_article.exists():
        wscn_title = json.loads(wscn_article.read_text(encoding="utf-8")).get("title", "")
    print(f"WSCN_TITLE={wscn_title}")
    print(f"BACKFILL_WINDOW={window}")
    print(f"BACKFILL_DATES={','.join(x.isoformat() for x in dates)}")
    print(f"RECENT_ARTICLES={','.join(recent_articles)}")
    print(f"RECENT_WSCN_ARTICLES={','.join(recent_wscn)}")
    if missing_wind:
        print(f"MISSING_BACKFILL_WIND={','.join(missing_wind)}")
    if missing_wscn:
        print(f"MISSING_BACKFILL_WSCN={','.join(missing_wscn)}")
    return 0 if article_path.exists() and wscn_article.exists() else 1


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--fetch-only", action="store_true")
    p.add_argument("--date", type=str, help="YYYY-MM-DD")
    p.add_argument("--qq-id", type=str, help="Tencent news article id for Wind mirror")
    args = p.parse_args()
    target = date.fromisoformat(args.date) if args.date else None
    sys.exit(run_fetch(target, args.fetch_only))


if __name__ == "__main__":
    main()
