"""Interpretation layer. Explains the quantitative result; it never changes weights, limits or the universe."""
from __future__ import annotations
import json
import requests

LLM_SYSTEM = ("당신은 퀀트 포트폴리오 모델의 결과를 설명하는 해설 담당자입니다. 입력 JSON의 사실만 사용해 한국어 보고서체로 "
              "6~8문장 해설을 작성하세요. ETF 추가·삭제, 비중 변경, 한도 완화, 매수·매도 권고를 새로 제안하지 마세요. "
              "숫자는 입력값을 그대로 인용하고, 입력에 없는 사실은 쓰지 마세요.")


def _pct(x, nd=1):
    return "–" if x is None else f"{x*100:.{nd}f}%"


def build_facts(result, prev=None):
    m, meta, cons = result["metrics"], result["meta"], result["constraints"]
    rows = result["portfolio"]["rows"]
    f = dict(data_as_of=meta["data_as_of"], target_month=meta["target_month"], regime=result["macro"]["composite_long"],
             factors={r["factor"]: r["regime"] for r in result["macro"]["factors"]},
             rates=next(r for r in result["macro"]["factors"] if r["factor"] == "Rates"),
             income=dict(target=meta["params"]["income_target"], ttm=m["IncomeYield"], avg12=m["Income_12M"],
                         shortfall=max(0.0, meta["params"]["income_target"] - m["Income_12M"])),
             binding=cons["binding_order"], exp_ret=m["ExpTotalReturn"], beta=m["EffEquityBeta"], duration=m["Duration"],
             cc=m["CoveredCall"], credit=m["CreditRisk"], clo_aaa=m["CLO_AAA"], defensive=m["Defensive"], pure_eq=m["PureEquity"],
             band=meta["params"]["band"], current_basis=meta["current_basis"])
    f["trades_model"] = [dict(ticker=r["ticker"], current=r["model_current"], target=r["target"]) for r in rows
                         if r["model_current"] is not None and abs(r["target"] - r["model_current"]) > 1e-4]
    mv = sorted([r for r in rows if r["model_current"] is not None], key=lambda r: -abs(r["raw_opt"] - r["model_current"]))[:3]
    f["raw_moves"] = [dict(ticker=r["ticker"], delta=r["raw_opt"] - r["model_current"]) for r in mv]
    sc = sorted([r for r in result["scores"] if r["total"] is not None], key=lambda r: -r["total"])
    f["top_scores"] = [[r["ticker"], r["total"]] for r in sc[:3]]
    worst = min(result["stress"]["rows"], key=lambda r: r["loss"])
    f["worst_stress"] = dict(scenario=worst["scenario"], loss=worst["loss"], top=worst["top"][0])
    if prev:
        pf = {r["factor"]: r["regime"] for r in prev["macro"]["factors"]}
        f["regime_changes"] = [[k, pf.get(k), v] for k, v in f["factors"].items() if pf.get(k) != v]
        ps = {r["ticker"]: r["total"] for r in prev["scores"]}
        ch = [[r["ticker"], r["total"] - ps[r["ticker"]]] for r in sc if ps.get(r["ticker"]) is not None]
        f["score_changes"] = sorted(ch, key=lambda x: -abs(x[1]))[:3]
        pt = {r["ticker"]: r["target"] for r in prev["portfolio"]["rows"]}
        f["target_changes"] = sorted([[r["ticker"], r["target"] - pt.get(r["ticker"], 0.0)] for r in rows], key=lambda x: -abs(x[1]))[:3]
        f["prev_month"] = prev["meta"]["month"]
    rb = result.get("rebalance")
    if rb:
        f["actual"] = dict(n_buy=rb["totals"]["n_buy"], n_sell=rb["totals"]["n_sell"], turnover=rb["totals"]["turnover"],
                           cost=rb["totals"]["est_cost"], largest=max(rb["rows"], key=lambda r: r["abs_dev"])["ticker"])
    return f


def rule_based_commentary(f):
    L = []
    rt = f["rates"]
    L.append(f"{f['data_as_of']} 기준 국면은 '{f['regime']}'입니다. 10년물 {rt['level']:.2f}%(10년 백분위 {rt['pct']:.0f}, 3개월 {rt['chg_3m']:+.0f}bp)로 "
             f"금리 요인은 {rt['regime']}, 성장은 {f['factors']['Growth']}, 물가는 {f['factors']['Inflation']}, 크레딧은 {f['factors']['Credit']}입니다.")
    if "regime_changes" in f:
        L.append("전월 대비 요인 국면 변화: " + (", ".join(f"{k} {a}→{b}" for k, a, b in f["regime_changes"]) if f["regime_changes"] else "없음") + ".")
    L.append("점수 상위는 " + ", ".join(f"{t}({s:+.2f})" for t, s in f["top_scores"]) + "입니다."
             + (" 전월 대비 점수 변화가 큰 종목은 " + ", ".join(f"{t}({d:+.2f})" for t, d in f["score_changes"]) + "입니다." if f.get("score_changes") else ""))
    if f["trades_model"]:
        L.append("모델 기준 비중 변경: " + ", ".join(f"{x['ticker']} {_pct(x['current'])}→{_pct(x['target'])}" for x in f["trades_model"]) + ".")
    elif f["raw_moves"]:
        L.append(f"원 최적화 결과와 현재 비중(모델 기준)의 차이가 모두 밴드 {f['band']*100:.1f}%p 이내라 모델 거래는 없습니다"
                 f"(가장 큰 차이 {f['raw_moves'][0]['ticker']} {f['raw_moves'][0]['delta']*100:+.1f}%p).")
    if f["binding"]:
        L.append("비중을 가장 강하게 결정한 제약은 " + " > ".join(f["binding"]) + " 순입니다.")
    inc = f["income"]
    if inc["shortfall"] > 1e-6:
        L.append(f"인컴은 목표 {_pct(inc['target'])} 대비 현재 {_pct(inc['ttm'],2)}(12개월 평균 {_pct(inc['avg12'],2)})로 "
                 f"{inc['shortfall']*100:.2f}%p 부족하며, 하드 제약이 아닌 소프트 벌점으로만 반영했습니다.")
    else:
        L.append(f"인컴은 12개월 평균 {_pct(inc['avg12'],2)}로 목표 {_pct(inc['target'])}를 충족합니다.")
    L.append(f"유효 주식 베타 {f['beta']:.2f}, 듀레이션 {f['duration']:.2f}년, 커버드콜 {_pct(f['cc'])}, 신용 {_pct(f['credit'])}, "
             f"CLO AAA {_pct(f['clo_aaa'])}, 방어자산 {_pct(f['defensive'])}, 순수 주식 {_pct(f['pure_eq'])}입니다.")
    w = f["worst_stress"]
    L.append(f"가장 취약한 시나리오는 {w['scenario']}(추정 {w['loss']*100:.1f}%)이며 최대 기여는 {w['top'][0]}({w['top'][1]*100:+.1f}%p)입니다.")
    if f.get("actual"):
        a = f["actual"]
        L.append(f"실보유 대비 매수 {a['n_buy']}건·매도 {a['n_sell']}건, 회전율 {a['turnover']*100:.1f}%, 추정 거래비용 {a['cost']:,.0f}입니다.")
    return "\n".join(L)


def llm_commentary(facts, cfg):
    key = cfg.env.get("ANTHROPIC_API_KEY", "")
    if not key:
        return None, "ANTHROPIC_API_KEY 미설정 — 규칙 기반 해설만 제공합니다."
    c = cfg.settings.get("commentary", {})
    try:
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=90,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                          json={"model": c.get("llm_model", "claude-sonnet-5-5"), "max_tokens": int(c.get("max_tokens", 1500)),
                                "system": LLM_SYSTEM, "messages": [{"role": "user", "content": json.dumps(facts, ensure_ascii=False)}]})
        r.raise_for_status()
        txt = "".join(b.get("text", "") for b in r.json().get("content", []) if b.get("type") == "text")
        return txt.strip(), None
    except Exception as e:
        return None, f"AI 해설 호출 실패: {str(e)[:160]}"
