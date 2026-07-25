#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
UNPLUG INDEX - prototype harness (stdlib only, deterministic)

    python unplug_index.py            # run full demo report
    python unplug_index.py --seed 7   # different world, same mechanics

Demonstrates the 4 mechanisms of the idea:
  1) RESIDUAL   - run the same 20 tasks twice: real stack vs unplugged stack
                  (frontier model swapped for a commodity one). Score = what is left.
  2) SILENT LOSS- tasks the pre-AI deterministic path solved, that the plugged-in
                  stack now fails. Capability lost quietly while the plug is in.
  3) HYSTERESIS - after a public fail the vendor patches; the way back is measured
                  on HELD-OUT task variants, so recovery != the original path.
  4) SCAR CREDIT- fail -> fix -> re-pass on unseen variants = unfakeable credit.

To go real: replace Stack.attempt() with an HTTP call to the vendor API, and set
UNPLUGGED by pinning the cheapest model the vendor exposes (or the vendor runs the
signed harness itself in cooperative mode).
"""

import argparse
import math
import random
import sys
from collections import OrderedDict

try:                       # keep Thai readable on cp874/cp1252 consoles
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

FRONTIER = 0.92   # "โมเดลชายขอบ"
COMMODITY = 0.46  # "โมเดลโหล"
STEEP = 9.0       # logistic steepness


# ----------------------------------------------------------------- world model
class Task:
    def __init__(self, tid, capability, difficulty, det_solvable, variant=0):
        self.tid = tid
        self.capability = capability
        self.difficulty = difficulty
        self.det_solvable = det_solvable   # a pre-AI rule/template could do it
        self.variant = variant


class Stack:
    """A vendor product = scaffold (what they built) + model (what they rent)."""

    def __init__(self, name, claim, scaffold, det_trust, polish=0.0):
        self.name = name
        self.claim = claim
        self.scaffold = dict(scaffold)  # capability -> owned strength 0..1
        self.det_trust = det_trust      # how often it defers to its own rule path
        self.polish = polish            # prompt/UX layer: only pays off on a strong model
        self.patches = 0

    def s(self, cap):
        return self.scaffold.get(cap, 0.05)

    def attempt(self, task, model_power, rng):
        eff_model = min(0.99, model_power * (1.0 + self.polish))
        p_model = _sig(eff_model - task.difficulty)
        own = self.s(task.capability)

        # a task the old rule path handled outright
        rule_capable = task.det_solvable and own > task.difficulty
        if rule_capable and rng.random() > self.det_trust:
            # plugged in, the product routes around its own deterministic path.
            # the model is usually better -- but it is stochastic where rules were not.
            return rng.random() < p_model * 0.82

        # otherwise two independent routes; either one suffices
        p_scaffold = _sig(own - task.difficulty) * (1.0 if task.det_solvable else 0.18)
        p = 1.0 - (1.0 - p_model) * (1.0 - p_scaffold)
        return rng.random() < p

    def deterministic_only(self, task, rng):
        """The pre-AI baseline this product replaced."""
        if not task.det_solvable:
            return False
        return rng.random() < _sig(self.s(task.capability) - task.difficulty)

    def patch(self, failed_caps, rng):
        """Targeted repair after a public failure. Real, but narrow."""
        self.patches += 1
        for cap in failed_caps:
            gain = 0.10 + 0.22 * rng.random()
            self.scaffold[cap] = min(0.95, self.s(cap) + gain)
        self.det_trust = min(0.95, self.det_trust + 0.08)


def _sig(x):
    return 1.0 / (1.0 + math.exp(-STEEP * x))


# ----------------------------------------------------------------- task suite
CAPS = ["extraction", "citation_check", "redline", "escalation_routing", "summarise"]


def build_suite(rng, n=20, variant=0):
    tasks = []
    for i in range(n):
        cap = CAPS[i % len(CAPS)]
        diff = round(0.35 + 0.55 * rng.random(), 3)
        det = rng.random() < 0.45          # ~45% were solvable before AI existed
        tasks.append(Task("T%02d" % (i + 1), cap, diff, det, variant))
    return tasks


# ----------------------------------------------------------------- the two runs
def run_condition(stack, tasks, model_power, seed):
    rng = random.Random(seed)
    return {t.tid: stack.attempt(t, model_power, rng) for t in tasks}


def baseline_run(stack, tasks, seed):
    rng = random.Random(seed)
    return {t.tid: stack.deterministic_only(t, rng) for t in tasks}


def measure(stack, tasks, seed, repeats=5):
    """Repeat both conditions to separate signal from sampling noise."""
    full_c, unp_c, base_c = OrderedDict(), OrderedDict(), OrderedDict()
    for t in tasks:
        full_c[t.tid] = unp_c[t.tid] = base_c[t.tid] = 0
    for r in range(repeats):
        f = run_condition(stack, tasks, FRONTIER, seed + 1000 * r)
        u = run_condition(stack, tasks, COMMODITY, seed + 1000 * r)   # same seed = paired
        b = baseline_run(stack, tasks, seed + 1000 * r)
        for t in tasks:
            full_c[t.tid] += f[t.tid]
            unp_c[t.tid] += u[t.tid]
            base_c[t.tid] += b[t.tid]

    per_cap = OrderedDict()
    for cap in CAPS:
        ts = [t for t in tasks if t.capability == cap]
        fp = sum(full_c[t.tid] for t in ts)
        up = sum(unp_c[t.tid] for t in ts)
        n = len(ts) * repeats
        per_cap[cap] = {
            "full": fp / n if n else 0.0,
            "unplugged": up / n if n else 0.0,
            "residual": (up / fp) if fp else 1.0,
        }

    # silent loss: on its OWN rule-solvable tasks the plugged-in product is
    # measurably worse than the deterministic tool it replaced
    silent = []
    for t in tasks:
        b, f = base_c[t.tid] / repeats, full_c[t.tid] / repeats
        if b >= 0.6 and (b - f) >= 0.2:
            silent.append((t, b, f))

    index = 100.0 * sum(c["residual"] for c in per_cap.values()) / len(per_cap)
    full_rate = sum(full_c.values()) / (len(tasks) * repeats)
    return {
        "per_cap": per_cap,
        "index": index,
        "full_rate": full_rate,
        "silent": silent,
        "failed_caps": [c for c, v in per_cap.items() if v["residual"] < 0.55],
    }


# ----------------------------------------------------------------- reporting
def bar(x, width=22):
    n = int(round(max(0.0, min(1.0, x)) * width))
    return "#" * n + "." * (width - n)


def grade(idx):
    if idx >= 75:
        return "A  ของจริง"
    if idx >= 55:
        return "B  พึ่งพาปานกลาง"
    if idx >= 35:
        return "C  พึ่งพาสูง"
    return "D  เปลือกบาง"


def vendors():
    return [
        Stack("VeritasDraft", "AI-powered contract review",
              {"extraction": .74, "citation_check": .68, "redline": .61,
               "escalation_routing": .70, "summarise": .40}, .70, polish=.01),
        Stack("LexiFlow", "AI-native legal operations",
              {"extraction": .52, "citation_check": .30, "redline": .38,
               "escalation_routing": .44, "summarise": .28}, .45, polish=.05),
        Stack("ClauseGenie", "GPT-powered, 10x faster",
              {"extraction": .14, "citation_check": .08, "redline": .10,
               "escalation_routing": .12, "summarise": .09}, .10, polish=.12),
        Stack("Paralex", "hybrid rules + AI",
              {"extraction": .66, "citation_check": .78, "redline": .30,
               "escalation_routing": .58, "summarise": .22}, .88, polish=.0),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--repeats", type=int, default=5)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    suite = build_suite(rng, 20, variant=0)
    holdout = build_suite(random.Random(args.seed + 77), 20, variant=1)

    print("=" * 68)
    print(" UNPLUG INDEX  |  vertical: legal-tech  |  20 tasks x %d runs x 2 conditions"
          % args.repeats)
    print(" full = frontier model (%.2f)   unplugged = commodity model (%.2f)"
          % (FRONTIER, COMMODITY))
    print("=" * 68)

    results = []
    for v in vendors():
        r = measure(v, suite, args.seed, args.repeats)
        results.append((v, r))

    for v, r in results:
        print("\n%-14s  \"%s\"" % (v.name, v.claim))
        print("  ผ่านตอนเสียบอยู่ %.0f%%   ->   UNPLUG INDEX %5.1f   [%s]"
              % (100 * r["full_rate"], r["index"], grade(r["index"])))
        for cap, c in r["per_cap"].items():
            print("    %-19s full %s %.2f | unplug %s %.2f | เหลือ %3.0f%%"
                  % (cap, bar(c["full"], 12), c["full"],
                     bar(c["unplugged"], 12), c["unplugged"], 100 * c["residual"]))
        if r["silent"]:
            print("    !! หายเงียบ ๆ ระหว่างเสียบอยู่ %d ข้อ (แย่กว่าเครื่องมือเดิมที่มันมาแทน):"
                  % len(r["silent"]))
            for t, b, f in r["silent"]:
                print("       %s %-19s rule-only %.0f%% -> ตอนเสียบอยู่ %.0f%%"
                      % (t.tid, t.capability, 100 * b, 100 * f))

    print("\n" + "-" * 68)
    print(" อันดับ (ส่วนต่างที่เหลืออยู่ - ไม่ใช่คะแนนความเก่ง)")
    print("-" * 68)
    for i, (v, r) in enumerate(sorted(results, key=lambda x: -x[1]["index"]), 1):
        print("  %d. %-14s index %5.1f   full-pass %.0f%%   %s"
              % (i, v.name, r["index"], 100 * r["full_rate"], grade(r["index"])))

    ranked_by_skill = sorted(results, key=lambda x: -x[1]["full_rate"])[0][0].name
    ranked_by_index = sorted(results, key=lambda x: -x[1]["index"])[0][0].name
    print("\n  เก่งที่สุดตอนเสียบอยู่ : %s" % ranked_by_skill)
    print("  เหลือมากที่สุดถ้าถอด  : %s" % ranked_by_index)
    print("  -> สองคำถามนี้ให้คำตอบคนละคน นี่คือเหตุผลที่ดัชนีนี้มีอยู่")

    # ------------------------------------------------ hysteresis + scar credit
    print("\n" + "=" * 68)
    print(" ROUND 2 - ฮิสเทอรีซิส: ทางกลับไม่ใช่เส้นเดิม (วัดบนชุดภารกิจที่ไม่เคยเห็น)")
    print("=" * 68)
    prng = random.Random(args.seed + 5)
    for v, r0 in results:
        if not r0["failed_caps"]:
            print("\n%-14s  ไม่มีหมวดที่ตก - ไม่มีแผลให้สะสมเครดิต" % v.name)
            continue
        before = r0["index"]
        v.patch(r0["failed_caps"], prng)
        r1 = measure(v, holdout, args.seed + 3, args.repeats)
        healed = [c for c in r0["failed_caps"] if r1["per_cap"][c]["residual"] >= 0.55]
        print("\n%-14s  patch #%d บนหมวดที่ตก: %s"
              % (v.name, v.patches, ", ".join(r0["failed_caps"])))
        print("   index %.1f -> %.1f (held-out)  |  ฟื้นจริง %d/%d หมวด  |  scar credit +%d"
              % (before, r1["index"], len(healed), len(r0["failed_caps"]), len(healed)))
        for c in r0["failed_caps"]:
            print("      %-19s เหลือ %3.0f%% -> %3.0f%%  %s"
                  % (c, 100 * r0["per_cap"][c]["residual"],
                     100 * r1["per_cap"][c]["residual"],
                     "ฟื้น" if c in healed else "ยังไม่ฟื้น"))
    print("\n  เครดิตที่ปลอมไม่ได้ = ตกในที่แจ้ง -> แก้ -> ผ่านบนภารกิจที่ไม่เคยเห็น")
    print("  ใครไม่เคยเข้ารับการทดสอบ ไม่มีแผล จึงไม่มีเครดิต - ไม่ใช่คะแนนเต็ม")


if __name__ == "__main__":
    main()
