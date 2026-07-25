#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recovery_line.py -- The Recovery Line (เส้นคืนตัว) working prototype.

Demonstrates the core mechanism of the idea, end to end, with zero dependencies:

  1. Simulates two HUMAN queues (approval / review) fed by an AI-accelerated
     upstream. Queue A drifts toward saturation as AI adoption ramps.
     Queue B is a control queue with the same shocks but no drift.
  2. Computes the two numbers nobody sells today, per week:
        R  = recovery time  -> days for the queue to return to its own baseline
                               after a top-decile peak (censored at MAX_R)
        r1 = lag-1 autocorrelation of the linearly-detrended daily backlog
             (critical-slowing-down early-warning statistic)
  3. Fires an alarm when R is trending up AND r1 crosses the CSD threshold,
     then reports the LEAD TIME versus the day the ordinary 30-day mean
     wait time finally goes red. Lead time > 0 is the whole thesis.
  4. Prices a recovery-time warranty off rho (implied utilisation derived from
     R), not off ticket volume or tokens.
  5. Keeps a "kintsugi ledger" of human corrections to AI output and turns
     catalogued failure seams into a premium discount for the next period.

Run:  python recovery_line.py
      python recovery_line.py --seed 7
Output is ASCII only (safe on any Windows console).
"""

import argparse
import math
import random

# ---------------------------------------------------------------- parameters
DAYS = 240
CAPACITY = 100.0          # human items closed per day, nominal
WINDOW = 28               # rolling window for r1 and baseline
PEAK_Q = 0.90             # "peak" = above this quantile of trailing backlog
MAX_R = 45                # recovery censoring horizon (days)
SLA_MEAN_WAIT = 3.0       # the "green" number ops already watches (days)
R_SLOPE_TRIGGER = 0.40    # days of recovery time added per week
R1_TRIGGER = 0.70         # lag-1 autocorrelation alarm level
TREND_WEEKS = 4           # weeks of R slope used by the alarm
R_LEVEL_MULT = 2.25       # R must also be this far above the queue's own baseline
PERSIST_WEEKS = 3         # conditions must hold this many weeks in a row
BASELINE_WEEKS = 8        # weeks used to learn each queue's own normal R / r1


# ------------------------------------------------------------------ simulator
def simulate(rng, days=DAYS, drift=True, label=""):
    """Daily backlog of a human queue. Returns dict of series."""
    backlog = 0.0
    out = {"label": label, "backlog": [], "arrivals": [], "closed": [],
           "wait": [], "cap": []}
    shock_days = set()
    d = 12
    while d < days:                      # a demand shock roughly every 3 weeks
        shock_days.add(d)
        shock_days.add(d + 1)
        d += rng.randint(17, 24)

    for t in range(days):
        # AI adoption ramp: upstream production gets cheap, human queue does not
        ramp = min(1.0, t / 210.0)
        base = 68.0 + (18.0 * ramp if drift else 0.0)
        dow = [1.22, 1.08, 1.00, 0.96, 0.92, 0.42, 0.35][t % 7]   # Mon..Sun
        arrivals = base * dow * rng.gauss(1.0, 0.10)
        if t in shock_days:
            arrivals *= 1.85
        arrivals = max(0.0, arrivals)

        cap = max(0.0, CAPACITY * [1.0, 1.0, 1.0, 1.0, 0.98, 0.15, 0.10][t % 7]
                  * rng.gauss(1.0, 0.07))
        closed = min(backlog + arrivals, cap)
        backlog = max(0.0, backlog + arrivals - closed)

        out["arrivals"].append(arrivals)
        out["closed"].append(closed)
        out["cap"].append(cap)
        out["backlog"].append(backlog)
        out["wait"].append(backlog / CAPACITY)      # Little's law, days
    return out


# ------------------------------------------------------------------- statistics
def quantile(xs, q):
    if not xs:
        return 0.0
    s = sorted(xs)
    i = q * (len(s) - 1)
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (i - lo)


def median(xs):
    return quantile(xs, 0.5)


def detrend(xs):
    """Remove the linear trend so r1 measures memory, not drift."""
    n = len(xs)
    mx = (n - 1) / 2.0
    my = sum(xs) / n
    sxx = sum((i - mx) ** 2 for i in range(n))
    if sxx == 0:
        return [x - my for x in xs]
    sxy = sum((i - mx) * (xs[i] - my) for i in range(n))
    b = sxy / sxx
    return [xs[i] - (my + b * (i - mx)) for i in range(n)]


def lag1_autocorr(xs):
    z = detrend(xs)
    n = len(z)
    m = sum(z) / n
    num = sum((z[i] - m) * (z[i + 1] - m) for i in range(n - 1))
    den = sum((v - m) ** 2 for v in z)
    return num / den if den > 1e-12 else 0.0


def rolling_r1(backlog, window=WINDOW):
    out = [None] * len(backlog)
    for t in range(window, len(backlog)):
        out[t] = lag1_autocorr(backlog[t - window:t])
    return out


def recovery_events(backlog, window=WINDOW, peak_q=PEAK_Q, max_r=MAX_R):
    """Find top-decile peaks; measure days back to the pre-peak baseline."""
    events, t = [], window
    n = len(backlog)
    while t < n:
        hist = backlog[max(0, t - 90):t]
        if len(hist) < window:
            t += 1
            continue
        thresh = quantile(hist, peak_q)
        baseline = median(backlog[t - window:t])
        if backlog[t] > thresh and backlog[t] > baseline * 1.15:
            k = t + 1
            while k < n and k - t < max_r and backlog[k] > baseline:
                k += 1
            censored = (k - t >= max_r) or (k >= n)
            events.append({"start": t, "days": min(k - t, max_r),
                           "censored": censored, "baseline": baseline})
            t = k + 1                     # skip the event itself
        else:
            t += 1
    return events


def weekly_table(sim):
    """One row per week: recovery time R, lag-1 r1, and the 30d mean wait."""
    backlog, wait = sim["backlog"], sim["wait"]
    r1 = rolling_r1(backlog)
    events = recovery_events(backlog)
    by_week = {}
    for e in events:
        by_week.setdefault(e["start"] // 7, []).append(e)

    rows, last_r = [], None
    for w in range(len(backlog) // 7):
        t = min(w * 7 + 6, len(backlog) - 1)
        if r1[t] is None:
            continue
        evs = by_week.get(w, [])
        if evs:
            last_r = sum(e["days"] for e in evs) / len(evs)
        mean_wait = sum(wait[max(0, t - 29):t + 1]) / len(wait[max(0, t - 29):t + 1])
        rows.append({"week": w, "day": t, "R": last_r, "r1": r1[t],
                     "mean_wait": mean_wait,
                     "censored": any(e["censored"] for e in evs)})
    return rows


def slope(ys):
    n = len(ys)
    if n < 2:
        return 0.0
    mx = (n - 1) / 2.0
    my = sum(ys) / n
    sxx = sum((i - mx) ** 2 for i in range(n))
    return sum((i - mx) * (ys[i] - my) for i in range(n)) / sxx if sxx else 0.0


def alarm_week(rows):
    """First week where ALL of these hold, PERSIST_WEEKS in a row:
         (1) recovery time R is trending up,
         (2) R is well above this queue's own learned baseline,
         (3) lag-1 autocorrelation is high AND above this queue's own baseline.
    Conditions (2) and (3) are what stop a merely shocky-but-healthy queue
    from firing: the control queue bounces, it does not drift."""
    base_R = [r["R"] for r in rows[:BASELINE_WEEKS] if r["R"] is not None]
    base_r1 = [r["r1"] for r in rows[:BASELINE_WEEKS] if r["r1"] is not None]
    if not base_R or not base_r1:
        return None
    b_R, b_r1 = median(base_R), median(base_r1)

    streak = 0
    for i in range(max(TREND_WEEKS, BASELINE_WEEKS), len(rows)):
        seg = [r["R"] for r in rows[i - TREND_WEEKS:i + 1] if r["R"] is not None]
        row = rows[i]
        ok = (len(seg) >= TREND_WEEKS
              and slope(seg) >= R_SLOPE_TRIGGER
              and row["R"] is not None and row["R"] >= R_LEVEL_MULT * b_R
              and row["r1"] >= max(R1_TRIGGER, b_r1 + 0.08))
        streak = streak + 1 if ok else 0
        if streak >= PERSIST_WEEKS:
            return rows[i - PERSIST_WEEKS + 1]
    return None


def first_red_week(rows):
    for r in rows:
        if r["mean_wait"] > SLA_MEAN_WAIT:
            return r
    return None


# ------------------------------------------------------- pricing off rho, not volume
def rho_from_recovery(R, window=WINDOW):
    """M/M/1 relaxation: return-to-baseline time ~ 1/(mu*(1-rho)).
    Invert it, so the warranty is priced on utilisation implied by R itself."""
    R = max(0.5, min(float(R), MAX_R))
    return max(0.05, min(0.995, 1.0 - (1.0 / R)))


def premium(R, insured_days, seam_coverage=0.0, base=2500.0):
    """Monthly premium for a 'we guarantee recovery within N days' contract.
    Grows with rho/(1-rho); shrinks with catalogued kintsugi seams.
    rho is capped at 0.97 -- past that the queue is uninsurable, not expensive."""
    rho = min(0.97, rho_from_recovery(R))
    risk = rho / (1.0 - rho)                       # expected queue length term
    tightness = max(0.5, 10.0 / max(1.0, insured_days))
    gross = base * (risk / 8.0) * tightness
    discount = min(0.35, 0.45 * seam_coverage)     # capped at 35%
    return gross * (1.0 - discount), rho, discount


# ---------------------------------------------------- kintsugi ledger (gold seams)
SEAMS = [
    ("tone-off-brand",          0.24),
    ("stale-policy-citation",   0.19),
    ("wrong-entity-resolution", 0.17),
    ("units-and-currency",      0.13),
    ("missing-edge-case",       0.11),
    ("hallucinated-reference",  0.09),
    ("formatting-only",         0.07),
]


def kintsugi_ledger(rng, sim, edit_rate=0.18):
    """Every human touch on AI output is logged as a crack -> gold seam."""
    ledger = {}
    total = 0
    names = [s[0] for s in SEAMS]
    weights = [s[1] for s in SEAMS]
    for closed in sim["closed"]:
        edits = int(closed * edit_rate * rng.gauss(1.0, 0.20))
        for _ in range(max(0, edits)):
            seam = rng.choices(names, weights=weights, k=1)[0]
            ledger[seam] = ledger.get(seam, 0) + 1
            total += 1
    return ledger, total


# ---------------------------------------------------------------------- display
BARS = " .:-=+*#%@"


def spark(xs, lo=None, hi=None, width=72):
    xs = [x for x in xs if x is not None]
    if not xs:
        return ""
    step = max(1, len(xs) // width)
    xs = xs[::step][:width]
    lo = min(xs) if lo is None else lo
    hi = max(xs) if hi is None else hi
    rng_ = (hi - lo) or 1.0
    return "".join(BARS[min(len(BARS) - 1,
                            max(0, int((x - lo) / rng_ * (len(BARS) - 1))))]
                   for x in xs)


def show_queue(sim, rows):
    print("\n" + "=" * 78)
    print("QUEUE: %s" % sim["label"])
    print("=" * 78)
    print("backlog     |%s|" % spark(sim["backlog"]))
    print("mean wait   |%s|   (SLA %.1f d)" % (spark(sim["wait"]), SLA_MEAN_WAIT))
    print("lag-1 r1    |%s|   (alarm %.2f)" %
          (spark([r["r1"] for r in rows], 0.0, 1.0), R1_TRIGGER))
    print("recovery R  |%s|   (0..%d d)" %
          (spark([r["R"] for r in rows], 0.0, MAX_R), MAX_R))
    print()
    print(" week  day    R(days)   r1     mean_wait   ops_dashboard")
    print(" ----  ---   --------  -----   ---------   -------------")
    for r in rows:
        if r["week"] % 2:
            continue
        rr = "  --  " if r["R"] is None else ("%5.1f%s" %
                                              (r["R"], "+" if r["censored"] else " "))
        light = "GREEN" if r["mean_wait"] <= SLA_MEAN_WAIT else "RED"
        print("  %3d  %3d    %s    %5.2f    %6.2f d     %s"
              % (r["week"], r["day"], rr, r["r1"], r["mean_wait"], light))


def sweep(n):
    """Self-validation: repeat the whole experiment over n seeds and report
    detection rate, false-positive rate, and median lead time."""
    leads, hits, miss, fp, no_breach = [], 0, 0, 0, 0
    for s in range(n):
        rng = random.Random(1000 + s)
        rows = weekly_table(simulate(rng, drift=True))
        a, red = alarm_week(rows), first_red_week(rows)
        if a and red:
            leads.append(red["day"] - a["day"])
            hits += 1
        elif a and not red:
            hits += 1
            no_breach += 1
        elif red and not a:
            miss += 1
        rng = random.Random(9000 + s)
        rows_b = weekly_table(simulate(rng, drift=False))
        if alarm_week(rows_b):
            fp += 1
    print("SWEEP over %d seeds" % n)
    print("  drifting queue  : alarm fired %d/%d, missed %d" % (hits, n, miss))
    print("  control queue   : false alarms %d/%d" % (fp, n))
    if leads:
        print("  lead time (days): median %.0f  min %d  max %d  (n=%d breaches)"
              % (median(leads), min(leads), max(leads), len(leads)))
    if no_breach:
        print("  %d run(s) alarmed while the average never went red at all" % no_breach)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--sweep", type=int, default=0,
                    help="run N seeds and print detection / false-positive rates")
    args = ap.parse_args()

    if args.sweep:
        sweep(args.sweep)
        return

    print("THE RECOVERY LINE -- proof-of-mechanism simulation (seed=%d)" % args.seed)
    print("Hypothesis: recovery-time-after-peak and lag-1 autocorrelation of the")
    print("daily backlog turn red BEFORE the average-based dashboard does.")

    results = {}
    for label, drift in (("A / AI-fed approval queue (drifting)", True),
                         ("B / control queue (same shocks, no drift)", False)):
        rng = random.Random(args.seed + (0 if drift else 991))
        sim = simulate(rng, drift=drift, label=label)
        rows = weekly_table(sim)
        show_queue(sim, rows)

        a = alarm_week(rows)
        red = first_red_week(rows)
        results[label] = (sim, rows, a, red)

        print()
        if a:
            print("  RECOVERY-LINE ALARM  : week %d (day %d)  R=%.1fd  r1=%.2f"
                  % (a["week"], a["day"], a["R"], a["r1"]))
        else:
            print("  RECOVERY-LINE ALARM  : never fired")
        if red:
            print("  AVERAGE GOES RED     : week %d (day %d)  mean_wait=%.2f d"
                  % (red["week"], red["day"], red["mean_wait"]))
        else:
            print("  AVERAGE GOES RED     : never (dashboard stayed green all period)")
        if a and red:
            print("  >> LEAD TIME         : %d days of warning" % (red["day"] - a["day"]))
        elif a and not red:
            print("  >> Alarm fired while the ops dashboard was still fully green.")
        elif red and not a:
            print("  >> MISS: average went red with no prior recovery-line alarm.")
        else:
            print("  >> No alarm, no breach -- correct silence on a healthy queue.")

    # ---------------- warranty pricing + kintsugi, on the drifting queue --------
    label_a = "A / AI-fed approval queue (drifting)"
    sim_a, rows_a, _, _ = results[label_a]
    rng = random.Random(args.seed + 7)
    ledger, total_edits = kintsugi_ledger(rng, sim_a)

    print("\n" + "=" * 78)
    print("WARRANTY PRICING -- priced on rho implied by R, not on volume/tokens")
    print("=" * 78)
    print(" quarter   R(days)   implied_rho   true_rho   monthly_premium  items/mo")
    print(" -------  --------  ------------  ---------  ---------------  --------")
    per_q = max(1, len(rows_a) // 4)
    for q in range(4):
        chunk = rows_a[q * per_q:(q + 1) * per_q]
        seg = [r["R"] for r in chunk if r["R"] is not None]
        if not seg or not chunk:
            continue
        d0, d1 = chunk[0]["day"], chunk[-1]["day"] + 1
        true_rho = sum(sim_a["arrivals"][d0:d1]) / max(1e-9, sum(sim_a["cap"][d0:d1]))
        volume = sum(sim_a["closed"][d0:d1]) / max(1, (d1 - d0)) * 30.0
        R = sum(seg) / len(seg)
        p, rho, _ = premium(R, insured_days=5.0)
        print("   Q%d      %6.1f       %5.3f      %5.3f      $%9.0f    %7.0f"
              % (q + 1, R, rho, true_rho, p, volume))
    print("   note: monthly item volume is nearly flat while the premium moves --")
    print("         the price tracks rho (fragility), not throughput or tokens.")

    print("\n" + "=" * 78)
    print("KINTSUGI LEDGER -- where humans repaired the AI (%d repairs logged)" % total_edits)
    print("=" * 78)
    catalogued = 0
    for i, (seam, n) in enumerate(sorted(ledger.items(), key=lambda kv: -kv[1])):
        share = n / total_edits
        if i < 4:
            catalogued += share
        print("   %-26s %7d  %5.1f%%  %s%s"
              % (seam, n, share * 100, "#" * int(share * 60),
                 "   <- gold seam (catalogued)" if i < 4 else ""))

    R_last = [r["R"] for r in rows_a if r["R"] is not None][-1]
    p0, rho0, _ = premium(R_last, 5.0, seam_coverage=0.0)
    p1, _, disc = premium(R_last, 5.0, seam_coverage=catalogued)
    print("\n   catalogued failure mass : %.1f%% of all human repairs" % (catalogued * 100))
    print("   next-period premium     : $%.0f -> $%.0f  (-%.0f%%)" % (p0, p1, disc * 100))
    print("   the asset that stays    : this seam table is the customer's, not the model's.")
    print("\nDone. The claim to falsify on real logs: alarm day < red day, on queue A,")
    print("and no alarm at all on queue B.")


if __name__ == "__main__":
    main()
