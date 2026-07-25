'''
Anneal Cellar - runnable prototype (Python 3.8+, stdlib only)

    python anneal_cellar.py            # 300 engagements per arm
    python anneal_cellar.py 60         # faster

What it demonstrates, end to end:
  1) TEMPERATURE AUDIT - read a changelog, compute the client temperature
     = share of changes kept even though week 1 got worse. Near zero = frozen.
  2) SHADOW CELLAR     - 6 weeks, 5 percent carved traffic, several parallel vats,
     noisy measurement, Metropolis acceptance under a cooling schedule.
  3) GUARDRAILS        - per-vat drawdown floor, cumulative pain budget, one-button
     restore to the day-zero checkpoint.
  4) CONFIRM + BILL    - the deliverable is a CONFIG STATE. It is re-measured in a
     long low-noise window and must clear the noise threshold. No delta, no invoice.
  5) CONTROL ARM       - the same budget spent by a monotone optimizer, which is what
     every current contract, OKR and demo forces a vendor to be.

The headline number to watch: the monotone arm escapes the local optimum 0 percent
of the time no matter how much compute it is given. That zero is the product.
'''

import math
import random
import statistics
import sys

# ---------------------------------------------------------------- landscape
# Two config knobs, e.g. price ladder step and queue priority weight.
# The client sits on a narrow local peak. A broader, better peak exists across a
# valley that can only be crossed by first getting measurably worse.
START = (8, 8)
LOCAL_PEAK = (8, 8)
GLOBAL_PEAK = (30, 28)
LO, HI = 0, 40


def true_score(x, y):
    '''Ground truth margin index. The cellar never observes this directly.'''
    g = 38.0 * math.exp(-((x - GLOBAL_PEAK[0]) ** 2 + (y - GLOBAL_PEAK[1]) ** 2) / 260.0)
    l = 22.0 * math.exp(-((x - LOCAL_PEAK[0]) ** 2 + (y - LOCAL_PEAK[1]) ** 2) / 60.0)
    ripple = 1.2 * math.sin(x / 1.7) * math.cos(y / 1.9)
    return 60.0 + g + l + ripple


# ---------------------------------------------------------------- engagement
WEEKS = 6
VATS = 5                                # parallel shadow lineages, one engagement
MOVES = 180                             # config states visited per vat (30 per week)
TRAFFIC_SHARE = 0.05                    # the fermentation vat, per engagement
NOISE_SD = 1.30                         # measurement noise at 5 percent traffic
CONFIRM_NOISE_SD = 0.40                 # long confirmation window, less noise
T0, T_END = 10.0, 0.20                  # cooling schedule
CRYSTALLISE = 0.20                      # last 20 percent of moves = pure hill climb
FLOOR_DRAWDOWN = 22.0                   # kill switch on a vat, in index points
LOSS_BUDGET = 1400.0                    # cumulative point-moves of allowed pain
BILL_THRESHOLD = 1.5                    # confirmed delta must clear noise to invoice
VALUE_PER_POINT = 120000.0              # THB of annual profit per index point
FEE_SHARE = 0.25                        # share of the confirmed delta


def measure(state, rng, sd=NOISE_SD):
    return true_score(*state) + rng.gauss(0.0, sd)


def propose(state, rng):
    x, y = state
    if rng.random() < 0.5:
        x += rng.choice([-3, -2, -1, 1, 2, 3])
    else:
        y += rng.choice([-3, -2, -1, 1, 2, 3])
    return (min(HI, max(LO, x)), min(HI, max(LO, y)))


def temperature_at(i):
    k = i / max(1, MOVES - 1)
    if k > 1.0 - CRYSTALLISE:
        return 0.0                       # cool down: only improvements survive
    return T0 * (T_END / T0) ** (k / (1.0 - CRYSTALLISE))


# ---------------------------------------------------------------- one vat
def run_vat(rng, anneal):
    '''Returns (visited_states, aborted, max_dip, worse_moves).
       anneal=False is the control arm: accept only if measured better.'''
    checkpoint = START                   # one-button restore point
    cur = START
    cur_m = measure(cur, rng)
    base_m = cur_m
    visited = {cur: [cur_m]}
    spent, max_dip, worse = 0.0, 0.0, 0

    for i in range(MOVES):
        cand = propose(cur, rng)
        cand_m = measure(cand, rng)
        delta = cand_m - cur_m
        T = temperature_at(i) if anneal else 0.0
        accept = delta > 0 or (T > 0 and rng.random() < math.exp(delta / T))
        if accept:
            cur, cur_m = cand, cand_m
            visited.setdefault(cur, []).append(cand_m)

        dip = base_m - cur_m             # what the carved traffic is feeling now
        if dip > 0:
            spent += dip
            max_dip = max(max_dip, dip)
            worse += 1
        if dip > FLOOR_DRAWDOWN or spent > LOSS_BUDGET:
            cur = checkpoint             # ROLLBACK: this vat is restored to day zero
            return visited, True, max_dip, worse

    return visited, False, max_dip, worse


# ---------------------------------------------------------------- engagement
def run_engagement(seed, anneal):
    rng = random.Random(seed)
    pool, aborts, max_dip, worse = {}, 0, 0.0, 0
    for v in range(VATS):
        visited, aborted, dip, w = run_vat(rng, anneal)
        aborts += int(aborted)
        max_dip = max(max_dip, dip)
        worse += w
        if not aborted:                  # an aborted vat ships nothing
            for s, ms in visited.items():
                pool.setdefault(s, []).extend(ms)

    # confirmation: re-measure the strongest candidates in a long low-noise window
    ranked = sorted(pool.items(), key=lambda kv: -statistics.mean(kv[1]))[:3]
    cands = [s for s, _ in ranked] + [START]
    conf, final = max((measure(s, rng, CONFIRM_NOISE_SD), s) for s in cands)
    delta = conf - measure(START, rng, CONFIRM_NOISE_SD)

    if delta <= BILL_THRESHOLD:          # inside the noise -> restore, invoice nothing
        final, delta = START, 0.0

    return {
        'final': final,
        'true_delta': true_score(*final) - true_score(*START),
        'billed_delta': delta,
        'fee': FEE_SHARE * delta * VALUE_PER_POINT,
        'vats_rolled_back': aborts,
        'max_dip': max_dip,
        'worse_moves': worse,
        'escaped': math.dist(final, GLOBAL_PEAK) < 7.0,
    }


# ---------------------------------------------------------------- step 1 audit
CHANGELOG = [  # (name, week-1 delta, kept?) - the raw material of the first sales slide
    ('price_floor_v3', -2.1, False), ('bid_cap_relax', -0.8, False),
    ('routing_wt_a', +1.2, True), ('queue_sla_tier', -3.4, False),
    ('approval_2step', +0.4, True), ('surge_curve_b', -1.9, False),
    ('discount_ladder', +0.9, True), ('carrier_mix', -2.7, False),
    ('bundle_rule', +0.2, True), ('sla_penalty', -1.1, False),
    ('reprice_cadence', -4.0, False), ('promo_guard', +0.6, True),
    ('lane_priority', -0.5, False), ('tier_threshold', +1.5, True),
    ('fallback_rule', -2.2, True),  # the single survivor of a bad first week
]


def audit_temperature(log):
    worse = [c for c in log if c[1] < 0]
    kept = [c for c in worse if c[2]]
    return (len(kept) / len(worse)), len(kept), len(worse)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300

    print('=' * 74)
    print('STEP 1  TEMPERATURE AUDIT   (this is the first sales slide)')
    print('=' * 74)
    t, kept, worse = audit_temperature(CHANGELOG)
    print('changes shipped              : {}'.format(len(CHANGELOG)))
    print('worse in week 1              : {}'.format(worse))
    print('...kept anyway               : {}'.format(kept))
    print('CLIENT TEMPERATURE           : {:.3f}   {}'.format(
        t, 'FROZEN - structurally unable to leave its own hole' if t < 0.15 else 'has slack'))
    print()
    print('start config {}   true score {:.2f}'.format(START, true_score(*START)))
    print('reachable peak {} true score {:.2f}   (+{:.1f} points on the table)'.format(
        GLOBAL_PEAK, true_score(*GLOBAL_PEAK),
        true_score(*GLOBAL_PEAK) - true_score(*START)))
    print('the valley between (18,18)     true score {:.2f}   <- must be crossed'.format(
        true_score(18, 18)))

    print()
    print('=' * 74)
    print('STEP 2  {} ENGAGEMENTS PER ARM | {} weeks, {} vats x {} moves, {:.0%} traffic'
          .format(n, WEEKS, VATS, MOVES, TRAFFIC_SHARE))
    print('=' * 74)

    out = {}
    for arm, anneal in (('MONOTONE (industry default)', False), ('ANNEAL CELLAR', True)):
        runs = [run_engagement(9000 + i, anneal) for i in range(n)]
        out[arm] = runs
        gains = [r['true_delta'] for r in runs]
        fees = [r['fee'] for r in runs]
        print('{:<28} escape {:>4.0%} | mean d {:>5.2f} | median d {:>5.2f} | '
              'worst d {:>6.2f} | mean fee {:>9,.0f} THB'.format(
                  arm,
                  sum(r['escaped'] for r in runs) / n,
                  statistics.mean(gains), statistics.median(gains), min(gains),
                  statistics.mean(fees)))

    a = out['ANNEAL CELLAR']
    print()
    print('=' * 74)
    print('STEP 3  WHAT THE CONTRACT CAN HONESTLY PROMISE')
    print('=' * 74)
    dips = [r['max_dip'] for r in a]
    over = [r['billed_delta'] - r['true_delta'] for r in a if r['billed_delta'] > 0]
    paid = [r for r in a if r['fee'] > 0]
    print('deepest dip inside a vat, p50 / p95 : {:.1f} / {:.1f} index points'.format(
        statistics.median(dips), sorted(dips)[int(0.95 * len(dips)) - 1]))
    print('...felt by the whole business       : {:.2f} / {:.2f} points blended'
          ' (only {:.0%} of traffic is in the cellar)'.format(
              statistics.median(dips) * TRAFFIC_SHARE,
              sorted(dips)[int(0.95 * len(dips)) - 1] * TRAFFIC_SHARE, TRAFFIC_SHARE))
    print('vats hitting the kill switch        : {:.2f} of {} per engagement'.format(
        statistics.mean(r['vats_rolled_back'] for r in a), VATS))
    print('engagements billed nothing          : {:.0%}'.format(1 - len(paid) / len(a)))
    print('mean invoice when billed            : {:,.0f} THB'.format(
        statistics.mean(r['fee'] for r in paid) if paid else 0.0))
    print('CONFIRMATION OVERCLAIM (billed-true): {:+.2f} points mean'.format(
        statistics.mean(over) if over else 0.0))
    print('   ^ if this is not near zero the gainshare invoice is charging for noise;')
    print('     it is the single number that decides whether the business is honest.')
    print()
    print('The deliverable is the config state, not a report. Below the noise')
    print('threshold the state is restored to day zero and nothing is billed.')


if __name__ == '__main__':
    main()
