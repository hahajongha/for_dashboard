"""Macro regime engine (v3.0 logic, made as-of aware).

Look-ahead control
- Daily series are truncated at data_as_of.
- Monthly series: obs month m is labelled at end of month m+lag (v3.0 rule). In lag-rule mode a
  current-month guard also drops observations whose typical release day is after data_as_of.
- Weekly series are shifted by `weekly_lag_days` (publication delay).
- Series obtained as ALFRED as-of vintages are already point-in-time (no extra guard/lag).
"""
from __future__ import annotations
import numpy as np
import pandas as pd


def _rz(s, w=120, minp=60):
    return (s - s.rolling(w, min_periods=minp).mean()) / s.rolling(w, min_periods=minp).std()


def _rpct(s, w=120, minp=60):
    return s.rolling(w, min_periods=minp).apply(lambda x: (x[:-1] < x[-1]).mean() * 100, raw=True)


def _cls_dir(chg, up, dn, labels=("Improving", "Stable", "Deteriorating")):
    return np.where(chg > up, labels[0], np.where(chg < dn, labels[2], labels[1]))


def _yoy(s):
    return (s / s.shift(12) - 1) * 100


def build_macro(F: dict, as_of, series_cfg: list, vintage_ids=frozenset()):
    as_of = pd.Timestamp(as_of)
    me_end = as_of + pd.offsets.MonthEnd(0)
    ME = pd.date_range("1999-12-31", me_end, freq="ME")
    meta = {s["id"]: s for s in series_cfg}
    missing = [k for k, s in meta.items() if s.get("required") and k not in F]
    if missing:
        raise KeyError(f"required FRED series missing: {missing}")

    def cut(sid):
        return F[sid].loc[:as_of]

    def me_last(s):
        return s.reindex(s.index.union(ME)).ffill().reindex(ME)

    def daily(sid):
        return me_last(cut(sid))

    def weekly(sid, pre=None):
        s = F[sid]
        if pre is not None:
            s = pre(s)
        lagd = 0 if sid in vintage_ids else int(meta[sid].get("weekly_lag_days", 0) or 0)
        s2 = s.copy()
        s2.index = s2.index + pd.Timedelta(days=lagd)
        return me_last(s2.loc[:as_of])

    def monthly(sid, lag=None):
        s = F[sid].dropna()
        lag = meta[sid]["lag_months"] if lag is None else lag
        lab = (s.index + pd.offsets.MonthEnd(0)) + pd.offsets.MonthEnd(lag)
        keep = lab <= me_end
        if sid not in vintage_ids and meta[sid].get("release_day"):
            rd = int(meta[sid]["release_day"])
            first = s.index.to_period("M").to_timestamp() + pd.DateOffset(months=lag)
            days_in = first.days_in_month
            avail = first + pd.to_timedelta(np.minimum(rd, days_in) - 1, unit="D")
            keep = keep & (avail <= as_of)
        s2 = pd.Series(s.values[keep], index=lab[keep])
        s2 = s2[~s2.index.duplicated(keep="last")]
        return s2.reindex(ME).ffill()

    def quarterly(sid, lag_months=1):
        s = F[sid].dropna()
        lab = (s.index + pd.offsets.QuarterEnd(0)) + pd.offsets.MonthEnd(lag_months)
        keep = lab <= me_end
        if sid not in vintage_ids and meta[sid].get("release_day"):
            qe = s.index + pd.offsets.QuarterEnd(0)
            avail = qe + pd.to_timedelta(int(meta[sid]["release_day"]), unit="D")
            keep = keep & (avail <= as_of)
        s2 = pd.Series(s.values[keep], index=lab[keep])
        return s2.reindex(ME).ffill()

    M = pd.DataFrame(index=ME)
    # ---- Growth
    ip = monthly("INDPRO"); M["INDPRO_yoy"] = _yoy(ip); M["INDPRO_3m_ann"] = ((ip / ip.shift(3)) ** 4 - 1) * 100
    pay = monthly("PAYEMS"); M["PAYEMS_3m_avg_chg"] = pay.diff().rolling(3).mean(); M["PAYEMS_yoy"] = _yoy(pay)
    un = monthly("UNRATE"); M["UNRATE"] = un; M["UNRATE_3m_chg"] = un.diff(3); M["SAHM"] = un.rolling(3).mean() - un.rolling(12).min()
    ic = weekly("ICSA", pre=lambda s: s.rolling(4).mean()); M["ICSA_4wk"] = ic; M["ICSA_yoy"] = _yoy(ic)
    rs = monthly("RSXFS"); M["RSXFS_yoy"] = _yoy(rs)
    if "GDPC1" in F:
        gdp = quarterly("GDPC1", 1); M["GDP_qoq_ann"] = ((gdp / gdp.shift(3)) ** 4 - 1) * 100
    # ---- Inflation
    cpi, core, pce, cpce = monthly("CPIAUCSL"), monthly("CPILFESL"), monthly("PCEPI"), monthly("PCEPILFE")
    M["CPI_yoy"] = _yoy(cpi); M["CoreCPI_yoy"] = _yoy(core); M["CoreCPI_3m_ann"] = ((core / core.shift(3)) ** 4 - 1) * 100
    M["PCE_yoy"] = _yoy(pce); M["CorePCE_yoy"] = _yoy(cpce); M["CorePCE_3m_ann"] = ((cpce / cpce.shift(3)) ** 4 - 1) * 100
    M["T5YIE"] = daily("T5YIE"); M["T10YIE"] = daily("T10YIE"); M["MICH"] = monthly("MICH", 0)
    # ---- Rates
    for s in ["DFF", "DGS2", "DGS5", "DGS10", "DGS30", "T10Y2Y", "T10Y3M"]:
        M[s] = daily(s)
    if "DGS3MO" in F:
        M["DGS3MO"] = daily("DGS3MO")
    for k in (1, 3, 6):
        M[f"DGS10_{k}m_chg"] = M["DGS10"].diff(k) * 100
    M["DGS2_3m_chg"] = M["DGS2"].diff(3) * 100
    # ---- Credit
    M["HY_OAS"] = daily("BAMLH0A0HYM2"); M["IG_OAS"] = daily("BAMLC0A0CM"); M["BAA10Y"] = daily("BAA10Y")
    if "AAA10Y" in F:
        M["AAA10Y"] = daily("AAA10Y")
    for k in (1, 3, 6):
        M[f"BAA10Y_{k}m_chg"] = M["BAA10Y"].diff(k) * 100
        M[f"HY_OAS_{k}m_chg"] = M["HY_OAS"].diff(k) * 100
    # ---- Volatility
    vix = cut("VIXCLS"); M["VIX"] = me_last(vix)
    vm = vix.resample("ME").mean()
    M["VIX_1m_avg"] = vm.reindex(ME); M["VIX_3m_avg"] = vm.rolling(3).mean().reindex(ME)
    for k in (1, 3, 6):
        M[f"VIX_{k}m_chg"] = M["VIX"].diff(k)
    # ---- Liquidity
    M["NFCI"] = weekly("NFCI")
    if "ANFCI" in F:
        M["ANFCI"] = weekly("ANFCI")
    for k in (1, 3, 6):
        M[f"NFCI_{k}m_chg"] = M["NFCI"].diff(k)
    if "WALCL" in F:
        M["WALCL_yoy"] = _yoy(weekly("WALCL"))
    if "RRPONTSYD" in F:
        M["RRP_bn"] = daily("RRPONTSYD")
    if "WRESBAL" in F:
        M["RESERVES_yoy"] = _yoy(weekly("WRESBAL"))
    if "DRTSCILM" in F:
        M["SLOOS_tight"] = quarterly("DRTSCILM", 1)
    # ---- Dollar
    M["DXY_broad"] = daily("DTWEXBGS")
    for k in (1, 3, 6, 12):
        M[f"DXY_{k}m_chg"] = (M["DXY_broad"] / M["DXY_broad"].shift(k) - 1) * 100
    # ---- composites & z
    gz = pd.concat([_rz(M["INDPRO_yoy"]), _rz(M["PAYEMS_3m_avg_chg"]), -_rz(M["UNRATE_3m_chg"]), -_rz(M["ICSA_yoy"]), _rz(M["RSXFS_yoy"])], axis=1).mean(axis=1)
    iz = pd.concat([_rz(M["CoreCPI_3m_ann"]), _rz(M["CoreCPI_yoy"]), _rz(M["CorePCE_yoy"]), _rz(M["T5YIE"]), _rz(M["MICH"])], axis=1).mean(axis=1)
    M["GROWTH_z"], M["INFL_z"] = gz, iz
    for k in (1, 3, 6):
        M[f"GROWTH_z_{k}m_chg"] = gz.diff(k)
        M[f"INFL_z_{k}m_chg"] = iz.diff(k)
    M["RATES_z"] = _rz(M["DGS10"]); M["CREDIT_z"] = _rz(M["BAA10Y"]); M["VIX_z"] = _rz(M["VIX"])
    M["NFCI_z"] = _rz(M["NFCI"]); M["DXY_z"] = _rz(M["DXY_broad"]); M["HY_OAS_z"] = _rz(M["HY_OAS"])
    # ---- regimes (v3.0 thresholds)
    M["GROWTH_regime"] = _cls_dir(M["GROWTH_z_3m_chg"], 0.25, -0.25)
    M["INFL_regime"] = _cls_dir(M["INFL_z_3m_chg"], 0.25, -0.25, ("Rising", "Stable", "Falling"))
    M["RATES_regime"] = _cls_dir(M["DGS10_3m_chg"], 25, -25, ("Rising", "Stable", "Falling"))
    M["CREDIT_regime"] = _cls_dir(-M["BAA10Y_3m_chg"], 15, -15)
    M["VOL_regime"] = np.where(M["VIX_1m_avg"] > 25, "High", np.where(M["VIX_1m_avg"] < 15, "Low", "Normal"))
    M["LIQ_regime"] = np.where(M["NFCI"] > 0, "Tight", np.where(M["NFCI"] < -0.4, "Loose", "Neutral"))
    M["DXY_regime"] = _cls_dir(M["DXY_3m_chg"], 2.0, -2.0, ("Rising", "Stable", "Falling"))

    def combined(r):
        g, i, v, c, gz_ = r["GROWTH_regime"], r["INFL_regime"], r["VOL_regime"], r["CREDIT_regime"], r["GROWTH_z"]
        if v == "High" or (c == "Deteriorating" and v != "Low"):
            return "Risk-Off"
        if g == "Deteriorating" and (gz_ is not None and gz_ < -1.0):
            return "Recession"
        if g == "Deteriorating" and i == "Rising":
            return "Stagflation"
        if g == "Deteriorating":
            return "Slowdown"
        if i == "Rising" and g == "Improving":
            return "Reflation"
        if i == "Rising":
            return "Inflation"
        return "Growth + Disinflation"

    M["REGIME"] = M.apply(combined, axis=1)
    for k in ["DGS10", "DGS2", "HY_OAS", "BAA10Y", "VIX", "NFCI", "DXY_broad", "CoreCPI_yoy", "UNRATE", "GROWTH_z", "INFL_z", "T5YIE"]:
        M[k + "_pct10y"] = _rpct(M[k])

    def risk_state(r):
        if r["VOL_regime"] == "High" or r["CREDIT_regime"] == "Deteriorating":
            return "RiskOff"
        if r["VOL_regime"] == "Low" and r["GROWTH_regime"] != "Deteriorating":
            return "RiskOn"
        return "Neutral"

    def def_state(r):
        if r["VOL_regime"] == "High" and (r["CREDIT_regime"] == "Deteriorating" or r["GROWTH_regime"] == "Deteriorating"):
            return "Crisis"
        if r["VOL_regime"] == "High" or r["CREDIT_regime"] == "Deteriorating" or r["GROWTH_regime"] == "Deteriorating":
            return "HighRisk"
        return "Normal"

    M["RISK_STATE"] = M.apply(risk_state, axis=1)
    M["DEF_STATE"] = M.apply(def_state, axis=1)
    return M


def composite_label(r):
    parts = [r["REGIME"]]
    if r["RATES_regime"] == "Rising":
        parts.append("Rising Rates")
    elif r["RATES_regime"] == "Falling":
        parts.append("Falling Rates")
    if r["CREDIT_regime"] == "Deteriorating" and r["REGIME"] != "Risk-Off":
        parts.append("Credit Stress")
    return " + ".join(parts)


def factor_table(M, t):
    r = M.loc[t]

    def f(x, nd=2):
        return None if pd.isna(x) else round(float(x), nd)

    rows = [
        dict(factor="Growth", level=f(r.GROWTH_z), level_fmt=f"{r.GROWTH_z:+.2f} (복합 z)", unit="z",
             chg_1m=f(r.GROWTH_z_1m_chg), chg_3m=f(r.GROWTH_z_3m_chg), chg_6m=f(r.GROWTH_z_6m_chg), chg_unit="Δz",
             z=f(r.GROWTH_z), pct=f(r.GROWTH_z_pct10y, 0), regime=r.GROWTH_regime,
             detail=f"고용 3M평균 {r.PAYEMS_3m_avg_chg:+.0f}k · 실업률 {r.UNRATE:.1f}% · 산업생산 yoy {r.INDPRO_yoy:+.1f}% · 소매판매 yoy {r.RSXFS_yoy:+.1f}%",
             rule="복합 z(10년 롤링)의 3개월 변화가 ±0.25를 넘으면 개선/악화"),
        dict(factor="Inflation", level=f(r.INFL_z), level_fmt=f"{r.INFL_z:+.2f} (복합 z)", unit="z",
             chg_1m=f(r.INFL_z_1m_chg), chg_3m=f(r.INFL_z_3m_chg), chg_6m=f(r.INFL_z_6m_chg), chg_unit="Δz",
             z=f(r.INFL_z), pct=f(r.INFL_z_pct10y, 0), regime=r.INFL_regime,
             detail=f"근원CPI 3M연율 {r.CoreCPI_3m_ann:.1f}% · 근원PCE yoy {r.CorePCE_yoy:.1f}% · 5Y BEI {r.T5YIE:.2f}% · 미시간 기대 {r.MICH:.1f}%",
             rule="복합 z의 3개월 변화가 ±0.25를 넘으면 상승/하락"),
        dict(factor="Rates", level=f(r.DGS10), level_fmt=f"10Y {r.DGS10:.2f}%", unit="%",
             chg_1m=f(r.DGS10_1m_chg, 0), chg_3m=f(r.DGS10_3m_chg, 0), chg_6m=f(r.DGS10_6m_chg, 0), chg_unit="bp",
             z=f(r.RATES_z), pct=f(r.DGS10_pct10y, 0), regime=r.RATES_regime,
             detail=f"2Y {r.DGS2:.2f}% · 5Y {r.DGS5:.2f}% · 30Y {r.DGS30:.2f}% · FF {r.DFF:.2f}% · 10Y-2Y {r.T10Y2Y*100:+.0f}bp · 10Y-3M {r.T10Y3M*100:+.0f}bp",
             rule="10년물 3개월 변화가 ±25bp를 넘으면 상승/하락"),
        dict(factor="Credit", level=f(r.HY_OAS), level_fmt=f"HY OAS {r.HY_OAS:.2f}%", unit="%",
             chg_1m=f(r.HY_OAS_1m_chg, 0), chg_3m=f(r.HY_OAS_3m_chg, 0), chg_6m=f(r.HY_OAS_6m_chg, 0), chg_unit="bp",
             z=f(r.CREDIT_z), pct=f(r.BAA10Y_pct10y, 0), regime=r.CREDIT_regime,
             detail=f"IG OAS {r.IG_OAS:.2f}% · Baa-10Y {r.BAA10Y:.2f}% (3M {r.BAA10Y_3m_chg:+.0f}bp) — 국면·z·백분위는 장기 이력이 있는 Baa-10Y 기준",
             rule="Baa-10Y 스프레드 3개월 변화가 ±15bp를 넘으면 악화/개선"),
        dict(factor="Volatility", level=f(r.VIX, 1), level_fmt=f"VIX {r.VIX:.1f}", unit="pt",
             chg_1m=f(r.VIX_1m_chg, 1), chg_3m=f(r.VIX_3m_chg, 1), chg_6m=f(r.VIX_6m_chg, 1), chg_unit="pt",
             z=f(r.VIX_z), pct=f(r.VIX_pct10y, 0), regime=r.VOL_regime,
             detail=f"1M 평균 {r.VIX_1m_avg:.1f} · 3M 평균 {r.VIX_3m_avg:.1f} · VIX 기간구조: FRED 미제공",
             rule="VIX 1개월 평균 25 초과 High, 15 미만 Low"),
        dict(factor="Liquidity", level=f(r.NFCI), level_fmt=f"NFCI {r.NFCI:.2f}", unit="idx",
             chg_1m=f(r.NFCI_1m_chg), chg_3m=f(r.NFCI_3m_chg), chg_6m=f(r.NFCI_6m_chg), chg_unit="Δ",
             z=f(r.NFCI_z), pct=f(r.NFCI_pct10y, 0), regime=r.LIQ_regime,
             detail=(f"Fed 자산 yoy {r.get('WALCL_yoy', np.nan):+.1f}% · 지준 yoy {r.get('RESERVES_yoy', np.nan):+.1f}% · "
                     f"RRP ${r.get('RRP_bn', np.nan):.0f}bn · SLOOS 대출기준 강화 {r.get('SLOOS_tight', np.nan):+.1f}%"),
             rule="NFCI 0 초과 Tight, −0.4 미만 Loose"),
        dict(factor="Dollar", level=f(r.DXY_broad, 1), level_fmt=f"Broad USD {r.DXY_broad:.1f}", unit="idx",
             chg_1m=f(r.DXY_1m_chg), chg_3m=f(r.DXY_3m_chg), chg_6m=f(r.DXY_6m_chg), chg_unit="%",
             z=f(r.DXY_z), pct=f(r.DXY_broad_pct10y, 0), regime=r.DXY_regime,
             detail="FRED Broad Dollar Index 사용 (ICE DXY는 FRED 미제공)",
             rule="3개월 변화가 ±2%를 넘으면 상승/하락"),
    ]
    return rows
