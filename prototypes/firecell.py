#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Firecell — the percolation ceiling of assumptions.
===================================================

WHAT THIS DEMONSTRATES
----------------------
An organisation's documents form a *belief dependency graph*: claim A is used as
the basis for claim B.  Those edges are semantic, buried in unstructured prose,
and were not extractable before LLMs.

Once you have that graph you can ask a question nobody sells today:

    "How much of the connectivity budget (p) has this org already spent,
     and is it above the percolation threshold (p_c) where one wrong
     assumption reaches everything?"

This single file:
  1. builds a belief-dependency graph (synthetic by default; real via --corpus
     or --llm which calls Claude to extract 'A -> is used as basis of -> B'),
  2. measures p  = fraction of dependency links carried by *unverified
     inheritance* (B cites A instead of re-deriving from the primary source),
  3. estimates p_c by Monte-Carlo bond percolation (susceptibility peak) and
     cross-checks it against the analytic Molloy–Reed criterion,
  4. ranks LOAD-BEARING CLAIMS by blast radius (how much of the corpus dies if
     this one claim is wrong),
  5. computes the HONEYCOMB FIREWALL PLAN: the smallest set of claims that must
     be forcibly re-derived from the primary source so that no belief cell
     exceeds the ceiling.

RUN
---
    python firecell.py                       # synthetic org, full report
    python firecell.py --ceiling 0.10        # tighter firewall spec
    python firecell.py --seed 7 --json out.json
    python firecell.py --corpus edges.jsonl  # your own extracted edges
    python firecell.py --llm docs/           # extract edges with Claude first

No third-party dependency for the analysis (stdlib only).
`--llm` additionally needs:  pip install anthropic
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from collections import Counter, defaultdict, deque

# --------------------------------------------------------------------------
# 0. Graph container
# --------------------------------------------------------------------------


class BeliefGraph:
    """Directed graph. Edge (a -> b) means: claim b inherits its warrant from a."""

    def __init__(self):
        self.nodes = []                 # list of dicts: id, text, domain, source
        self.index = {}                 # node id -> position
        self.edges = []                 # (u, v, inherited: bool)

    def add_node(self, nid, text, domain, source):
        if nid in self.index:
            return self.index[nid]
        self.index[nid] = len(self.nodes)
        self.nodes.append({"id": nid, "text": text, "domain": domain, "source": source})
        return self.index[nid]

    def add_edge(self, u, v, inherited=True):
        self.edges.append((self.index[u], self.index[v], bool(inherited)))

    @property
    def n(self):
        return len(self.nodes)

    def live_edges(self):
        """Edges that actually carry belief weight (unverified inheritance)."""
        return [(u, v) for u, v, inh in self.edges if inh]

    def domains(self):
        return sorted({nd["domain"] for nd in self.nodes})


# --------------------------------------------------------------------------
# 1. Corpus: synthetic organisation (default) / jsonl / LLM extraction
# --------------------------------------------------------------------------

DOMAINS = {
    "Pricing":  ("ราคา/มาร์จิ้น", ["enterprise tier converts at 4%",
                                   "churn is price-driven",
                                   "COGS per seat is $3.10"]),
    "Growth":   ("การเติบโต",     ["CAC payback is 11 months",
                                   "SMB channel is saturated",
                                   "referral loop k-factor = 0.6"]),
    "Infra":    ("โครงสร้างพื้นฐาน", ["p99 latency budget is 300ms",
                                   "single-region is acceptable",
                                   "storage grows 8%/mo"]),
    "Roadmap":  ("แผนสินค้า",      ["customers want automation, not analytics",
                                   "Q3 launch is board-committed"]),
}


def build_synthetic_corpus(seed=42, per_domain=48, ai_outputs=40,
                           inherit_rate=0.88, cross_rate=0.16):
    """
    Model of a real corpus:
      * a few PRIMARY-SOURCE claims per domain (roots: measured, sourced),
      * derived claims that attach preferentially to well-cited claims
        (rich-get-richer = how internal citation actually behaves),
      * AI-generated artefacts that fuse 2-3 existing claims at once — the
        thing that has been quietly raising p in every org since 2023.
    """
    rng = random.Random(seed)
    g = BeliefGraph()
    by_domain = defaultdict(list)

    # roots -- the primary-source claims
    for dom, (_, roots) in DOMAINS.items():
        for i, txt in enumerate(roots):
            nid = f"{dom}:root{i}"
            g.add_node(nid, txt, dom, "primary")
            by_domain[dom].append(nid)

    # derived claims, preferential attachment inside the domain
    for dom in DOMAINS:
        for i in range(per_domain):
            nid = f"{dom}:c{i}"
            g.add_node(nid, f"{dom} derived claim #{i}", dom, "doc")
            pool = by_domain[dom]
            parent = _preferential_pick(rng, g, pool)
            g.add_edge(parent, nid, rng.random() < inherit_rate)
            # occasional cross-domain borrow — how a pricing error reaches infra
            if rng.random() < cross_rate:
                other = rng.choice([d for d in DOMAINS if d != dom])
                if by_domain[other]:
                    p2 = _preferential_pick(rng, g, by_domain[other])
                    g.add_edge(p2, nid, rng.random() < inherit_rate)
            by_domain[dom].append(nid)

    # AI outputs: synthesise across several existing claims at once
    all_ids = [nd["id"] for nd in g.nodes]
    for i in range(ai_outputs):
        nid = f"AI:gen{i}"
        dom = rng.choice(list(DOMAINS))
        g.add_node(nid, f"AI-generated synthesis #{i}", dom, "ai_output")
        for parent in rng.sample(all_ids, k=rng.choice([2, 2, 3])):
            g.add_edge(parent, nid, rng.random() < 0.95)  # AI almost never re-derives
        by_domain[dom].append(nid)
        all_ids.append(nid)

    return g


def _preferential_pick(rng, g, pool):
    """Pick a parent with probability ~ (1 + out-degree): rich get richer."""
    if len(pool) <= 2:
        return rng.choice(pool)
    outdeg = Counter()
    for u, _v, _i in g.edges:
        outdeg[g.nodes[u]["id"]] += 1
    weights = [1.0 + outdeg[nid] for nid in pool]
    total = sum(weights)
    r = rng.random() * total
    acc = 0.0
    for nid, w in zip(pool, weights):
        acc += w
        if r <= acc:
            return nid
    return pool[-1]


def load_jsonl_corpus(path):
    """Each line: {"from": "...", "to": "...", "domain": "...", "inherited": true}"""
    g = BeliefGraph()
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            dom = rec.get("domain", "unknown")
            for key in ("from", "to"):
                g.add_node(rec[key], rec.get(key + "_text", rec[key]), dom,
                           rec.get("source", "doc"))
            g.add_edge(rec["from"], rec["to"], rec.get("inherited", True))
    return g


# ---- optional: extract the graph from real documents with Claude ----------

EXTRACTION_PROMPT = """You are extracting a BELIEF DEPENDENCY GRAPH from an internal document.

A dependency edge exists when the document treats claim A as already-settled and
builds claim B on top of it. Mark `inherited: true` when B simply relies on A
without re-deriving it from a primary source (measurement, dataset, contract,
experiment). Mark `inherited: false` when B independently re-derives or cites a
primary source.

Return every edge you can support with a verbatim span from the text.
Do not invent claims that are not in the document."""

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                    "domain": {"type": "string"},
                    "inherited": {"type": "boolean"},
                    "evidence": {"type": "string"},
                },
                "required": ["from", "to", "domain", "inherited", "evidence"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["edges"],
    "additionalProperties": False,
}


def extract_with_claude(folder, model="claude-opus-5", max_files=200):
    """Sweep a folder of text files and pull dependency edges out with Claude."""
    import anthropic  # imported lazily so the offline path has no dependency

    client = anthropic.Anthropic()
    g = BeliefGraph()
    seen = 0
    for root, _dirs, files in os.walk(folder):
        for fn in files:
            if not fn.lower().endswith((".md", ".txt", ".rst")):
                continue
            if seen >= max_files:
                break
            path = os.path.join(root, fn)
            with open(path, encoding="utf-8", errors="ignore") as fh:
                body = fh.read()[:40000]
            resp = client.messages.create(
                model=model,
                max_tokens=8000,
                thinking={"type": "adaptive"},
                output_config={
                    "effort": "high",
                    "format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA},
                },
                system=EXTRACTION_PROMPT,
                messages=[{"role": "user",
                           "content": f"<document path=\"{path}\">\n{body}\n</document>"}],
            )
            if resp.stop_reason == "refusal":
                print(f"  [skip] {path}: refused", file=sys.stderr)
                continue
            text = next(b.text for b in resp.content if b.type == "text")
            for e in json.loads(text)["edges"]:
                for key in ("from", "to"):
                    g.add_node(e[key], e[key], e["domain"], "doc")
                g.add_edge(e["from"], e["to"], e["inherited"])
            seen += 1
            print(f"  [ok] {path}: {len(g.edges)} edges so far", file=sys.stderr)
    return g


# --------------------------------------------------------------------------
# 2. Percolation core
# --------------------------------------------------------------------------


class UnionFind:
    __slots__ = ("parent", "size")

    def __init__(self, n):
        self.parent = list(range(n))
        self.size = [1] * n

    def find(self, x):
        p = self.parent
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.size[ra] < self.size[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]


def component_sizes(n, edges, nodes_subset=None):
    """Sizes of connected components of the undirected graph (n nodes, given edges)."""
    uf = UnionFind(n)
    for u, v in edges:
        uf.union(u, v)
    members = nodes_subset if nodes_subset is not None else range(n)
    return Counter(uf.find(i) for i in members)


def cluster_stats(n, edges, nodes_subset=None):
    """Return (giant_fraction, susceptibility). Susceptibility excludes the giant."""
    sizes = list(component_sizes(n, edges, nodes_subset).values())
    total = sum(sizes)
    if total == 0:
        return 0.0, 0.0
    sizes.sort(reverse=True)
    giant = sizes[0]
    rest = sizes[1:]
    denom = sum(rest)
    chi = (sum(s * s for s in rest) / denom) if denom else 0.0
    return giant / total, chi


def percolation_sweep(n, edges, nodes_subset=None, steps=41, trials=24, seed=0):
    """
    Bond percolation: occupy each dependency link with probability p, watch the
    giant belief cluster form. p_c is read off the susceptibility peak — the
    classic finite-size estimator for the threshold.
    """
    rng = random.Random(seed)
    grid, curve, chis = [], [], []
    for i in range(steps):
        p = i / (steps - 1)
        gsum = chisum = 0.0
        for _ in range(trials):
            occupied = [(u, v) for (u, v) in edges if rng.random() < p]
            gf, chi = cluster_stats(n, occupied, nodes_subset)
            gsum += gf
            chisum += chi
        grid.append(p)
        curve.append(gsum / trials)
        chis.append(chisum / trials)
    pc = grid[max(range(steps), key=lambda i: chis[i])]
    return {"grid": grid, "giant": curve, "chi": chis, "p_c_empirical": pc}


def molloy_reed_pc(n, edges, nodes_subset=None):
    """
    Analytic cross-check: a giant component survives bond occupation p when
    p > <k> / (<k^2> - <k>).  Degrees are taken on the undirected projection.
    """
    members = set(nodes_subset) if nodes_subset is not None else set(range(n))
    deg = Counter()
    for i in members:
        deg[i] = 0
    for u, v in edges:
        if u in members and v in members:
            deg[u] += 1
            deg[v] += 1
    if not deg:
        return None
    ks = list(deg.values())
    k1 = sum(ks) / len(ks)
    k2 = sum(k * k for k in ks) / len(ks)
    denom = k2 - k1
    if denom <= 0 or k1 == 0:
        return None
    return max(0.0, min(1.0, k1 / denom))


# --------------------------------------------------------------------------
# 3. Load-bearing claims + honeycomb firewall plan
# --------------------------------------------------------------------------


def blast_radius(g, live_only=True):
    """For each claim: how many downstream claims collapse if it is wrong."""
    adj = defaultdict(list)
    for u, v, inh in g.edges:
        if inh or not live_only:
            adj[u].append(v)
    out = {}
    for s in range(g.n):
        seen = {s}
        dq = deque([s])
        while dq:
            x = dq.popleft()
            for y in adj[x]:
                if y not in seen:
                    seen.add(y)
                    dq.append(y)
        out[s] = len(seen) - 1
    return out


def largest_cell(n, edges):
    sizes = component_sizes(n, edges)
    return max(sizes.values()) if sizes else 0


def edge_betweenness(adj, members):
    """
    Brandes' algorithm, edge variant, on the undirected subgraph induced by
    `members`.  The highest-betweenness link is the one carrying the most
    belief traffic — cut it and the comb splits, not frays.
    """
    bt = defaultdict(float)
    for s in members:
        # --- BFS ---
        stack, pred = [], defaultdict(list)
        sigma = {s: 1.0}
        dist = {s: 0}
        dq = deque([s])
        while dq:
            v = dq.popleft()
            stack.append(v)
            for w in adj[v]:
                if w not in dist:
                    dist[w] = dist[v] + 1
                    dq.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] = sigma.get(w, 0.0) + sigma[v]
                    pred[w].append(v)
        # --- accumulation ---
        delta = defaultdict(float)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                c = (sigma[v] / sigma[w]) * (1.0 + delta[w])
                bt[(v, w) if v < w else (w, v)] += c
                delta[v] += c
    return bt


def honeycomb_plan(g, ceiling_frac=0.15, max_steps=400):
    """
    The intervention is FORCED RE-DERIVATION of one dependency: claim B may no
    longer take claim A on faith — it must be re-grounded in a primary source.
    That severs exactly one inherited link.

    Which link? The one carrying the most belief traffic (highest edge
    betweenness inside the oversized cell). Removing it splits the cell rather
    than shaving a leaf off it. Repeat until every cell sits under the ceiling.
    Bee-hive logic: many small sealed cells beat one big flammable comb.
    """
    n = g.n
    live = {(u, v) for u, v, inh in g.edges if inh}
    remaining = set(live)
    ceiling = max(1, int(math.ceil(ceiling_frac * n)))
    plan, trace = [], []

    def undirected(edges):
        return [(u, v) for (u, v) in edges]

    start = largest_cell(n, undirected(remaining))
    trace.append({"step": 0, "cut": None, "largest_cell": start,
                  "largest_cell_pct": round(100 * start / n, 1)})

    for step in range(1, max_steps + 1):
        sizes = component_sizes(n, undirected(remaining))
        biggest_root, biggest = max(sizes.items(), key=lambda kv: kv[1])
        if biggest <= ceiling:
            break

        # membership + adjacency of the oversized cell only
        uf = UnionFind(n)
        for u, v in remaining:
            uf.union(u, v)
        members = [i for i in range(n) if uf.find(i) == biggest_root]
        mset = set(members)
        adj = defaultdict(list)
        cell_edges = [(u, v) for (u, v) in remaining if u in mset and v in mset]
        for u, v in cell_edges:
            adj[u].append(v)
            adj[v].append(u)
        if not cell_edges:
            break

        bt = edge_betweenness(adj, members)
        # map the undirected key back to the directed dependency we stored
        key = max(bt, key=bt.get)
        target = next(((u, v) for (u, v) in cell_edges
                       if (min(u, v), max(u, v)) == key), None)
        if target is None:
            break

        remaining.discard(target)
        after = largest_cell(n, undirected(remaining))
        u, v = target
        plan.append({"from": g.nodes[u]["id"], "from_text": g.nodes[u]["text"],
                     "to": g.nodes[v]["id"], "to_text": g.nodes[v]["text"],
                     "domain": g.nodes[v]["domain"],
                     "traffic": round(bt[key], 1),
                     "largest_cell_after": after,
                     "largest_cell_after_pct": round(100 * after / n, 1)})
        trace.append({"step": step, "cut": f"{g.nodes[u]['id']}->{g.nodes[v]['id']}",
                      "largest_cell": after,
                      "largest_cell_pct": round(100 * after / n, 1)})

    final_sizes = sorted(component_sizes(n, undirected(remaining)).values(),
                         reverse=True)
    final = final_sizes[0] if final_sizes else 0
    return {"ceiling_nodes": ceiling, "ceiling_frac": ceiling_frac,
            "largest_cell_before": start, "largest_cell_after": final,
            "under_ceiling": final <= ceiling,
            "cells_after": len(final_sizes),
            "cell_sizes_after": final_sizes[:12],
            "cuts": plan, "trace": trace,
            "links_severed_total": len(live) - len(remaining),
            "links_total": len(live)}


# --------------------------------------------------------------------------
# 4. Report
# --------------------------------------------------------------------------


def sparkline(values, width=48, height=9):
    """Tiny ASCII plot of the percolation curve — the phase transition, visible."""
    rows = []
    for r in range(height, 0, -1):
        lo = (r - 1) / height
        line = "".join("#" if v >= lo else " "
                       for v in _resample(values, width))
        rows.append(f"  {lo:>4.2f} |{line}")
    rows.append("       +" + "-" * width)
    rows.append("        0" + " " * (width - 6) + "p=1")
    return "\n".join(rows)


def _resample(values, width):
    if len(values) == width:
        return values
    out = []
    for i in range(width):
        out.append(values[int(i * (len(values) - 1) / (width - 1))])
    return out


def analyse(g, ceiling_frac=0.15, trials=24, seed=0):
    n = g.n
    live = g.live_edges()
    p = len(live) / len(g.edges) if g.edges else 0.0

    sweep = percolation_sweep(n, [(u, v) for u, v, _ in g.edges],
                              trials=trials, seed=seed)
    pc_emp = sweep["p_c_empirical"]
    pc_mr = molloy_reed_pc(n, [(u, v) for u, v, _ in g.edges])
    pc = pc_mr if pc_mr else pc_emp

    per_domain = {}
    for dom in g.domains():
        subset = [i for i, nd in enumerate(g.nodes) if nd["domain"] == dom]
        sub = set(subset)
        d_all = [(u, v) for u, v, _ in g.edges if u in sub and v in sub]
        d_live = [(u, v) for u, v, inh in g.edges if inh and u in sub and v in sub]
        if not d_all:
            continue
        d_p = len(d_live) / len(d_all)
        d_pc = molloy_reed_pc(n, d_all, subset)
        gf, _ = cluster_stats(n, d_live, subset)
        per_domain[dom] = {
            "claims": len(subset), "links": len(d_all),
            "p": round(d_p, 3),
            "p_c": round(d_pc, 3) if d_pc else None,
            "ratio": round(d_p / d_pc, 2) if d_pc else None,
            "giant_cell_pct": round(100 * gf, 1),
        }

    br = blast_radius(g)
    ranked = sorted(range(n), key=lambda i: -br[i])[:12]
    load_bearing = [{
        "rank": k + 1,
        "claim": g.nodes[i]["id"],
        "text": g.nodes[i]["text"],
        "domain": g.nodes[i]["domain"],
        "source": g.nodes[i]["source"],
        "blast_radius": br[i],
        "blast_pct": round(100 * br[i] / n, 1),
    } for k, i in enumerate(ranked)]

    plan = honeycomb_plan(g, ceiling_frac)
    gf_now, _ = cluster_stats(n, live)

    return {
        "corpus": {"claims": n, "links": len(g.edges), "inherited_links": len(live),
                   "domains": g.domains()},
        "percolation": {
            "p": round(p, 3),
            "p_c_molloy_reed": round(pc_mr, 3) if pc_mr else None,
            "p_c_empirical": round(pc_emp, 3),
            "p_over_pc": round(p / pc, 2) if pc else None,
            "above_ceiling": bool(pc and p > pc),
            "giant_cell_pct": round(100 * gf_now, 1),
            "curve": sweep,
        },
        "per_domain": per_domain,
        "load_bearing": load_bearing,
        "honeycomb": plan,
    }


def print_report(res):
    c, perc = res["corpus"], res["percolation"]
    W = 74
    print("=" * W)
    print("FIRECELL — CONNECTIVITY BUDGET REPORT".center(W))
    print("เพดานการซึมผ่านของสมมติฐาน".center(W))
    print("=" * W)
    print(f"corpus       : {c['claims']} claims, {c['links']} dependency links, "
          f"{c['inherited_links']} unverified")
    print(f"domains      : {', '.join(c['domains'])}")
    print()
    print("-" * W)
    print("1. THE ONE NUMBER")
    print("-" * W)
    ratio = perc["p_over_pc"]
    verdict = "ABOVE CEILING — one wrong claim reaches the whole comb" \
        if perc["above_ceiling"] else "under ceiling"
    print(f"   p   (spent connectivity budget) = {perc['p']:.3f}")
    print(f"   p_c (percolation threshold)     = {perc['p_c_molloy_reed']:.3f}"
          f"   [Monte-Carlo cross-check: {perc['p_c_empirical']:.3f}]")
    print(f"   p / p_c                         = {ratio}     >>> {verdict}")
    print(f"   largest belief cell today       = {perc['giant_cell_pct']}% of the corpus")
    print()
    print("   giant belief cluster vs. link occupation p:")
    print(sparkline(perc["curve"]["giant"]))
    print()
    print("-" * W)
    print("2. PER-DOMAIN BUDGET")
    print("-" * W)
    print(f"   {'domain':<12}{'claims':>7}{'links':>7}{'p':>8}{'p_c':>8}"
          f"{'p/p_c':>8}{'cell%':>8}")
    for dom, d in res["per_domain"].items():
        flag = "  <-- over" if d["ratio"] and d["ratio"] > 1 else ""
        print(f"   {dom:<12}{d['claims']:>7}{d['links']:>7}{d['p']:>8.2f}"
              f"{(d['p_c'] if d['p_c'] else 0):>8.2f}"
              f"{(d['ratio'] if d['ratio'] else 0):>8.2f}"
              f"{d['giant_cell_pct']:>8.1f}{flag}")
    print()
    print("-" * W)
    print("3. LOAD-BEARING CLAIMS  (if this one is wrong, this much dies)")
    print("-" * W)
    for r in res["load_bearing"]:
        print(f"   {r['rank']:>2}. [{r['blast_pct']:>5.1f}%  n={r['blast_radius']:>3}] "
              f"{r['domain']:<9} {r['source']:<10} {r['text'][:34]}")
    print()
    print("   >>> hand these 12 to an executive. If they cannot state them")
    print("       unprompted, the variable is real and nobody is measuring it.")
    print()
    print("-" * W)
    hc = res["honeycomb"]
    print(f"4. HONEYCOMB FIREWALL PLAN  (ceiling = {hc['ceiling_frac']:.0%} "
          f"= {hc['ceiling_nodes']} claims per cell)")
    print("-" * W)
    print(f"   largest cell before : {hc['largest_cell_before']} claims "
          f"({100*hc['largest_cell_before']//max(1,c['claims'])}% of corpus)")
    print(f"   largest cell after  : {hc['largest_cell_after']} claims"
          f"   ({'PASS' if hc['under_ceiling'] else 'STILL OVER'})")
    print(f"   minimum intervention: force re-derivation of "
          f"{hc['links_severed_total']} of {hc['links_total']} inherited links "
          f"({100*hc['links_severed_total']/max(1,hc['links_total']):.1f}%)")
    print(f"   resulting comb      : {hc['cells_after']} sealed cells, "
          f"largest few = {hc['cell_sizes_after'][:6]}")
    print()
    for i, r in enumerate(hc["cuts"], 1):
        print(f"   {i:>2}. {r['to']:<14} must re-derive its dependence on "
              f"{r['from']:<14} -> largest cell {r['largest_cell_after_pct']:>5}%")
    print()
    print("=" * W)
    print("Every new AI deployment must show how much p it spends,")
    print("and prove the comb still sits under p_c. Like a load rating.")
    print("=" * W)


# --------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(description="Firecell — percolation ceiling of assumptions")
    ap.add_argument("--corpus", help="jsonl of pre-extracted edges")
    ap.add_argument("--llm", metavar="FOLDER", help="extract edges from docs with Claude")
    ap.add_argument("--model", default="claude-opus-5")
    ap.add_argument("--ceiling", type=float, default=0.15,
                    help="max fraction of the corpus allowed in one belief cell")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--trials", type=int, default=24, help="Monte-Carlo trials per p")
    ap.add_argument("--inherit-rate", type=float, default=0.88,
                    help="synthetic: how often a claim is inherited, not re-derived")
    ap.add_argument("--json", metavar="PATH", help="also dump the full result as JSON")
    args = ap.parse_args()

    if args.llm:
        g = extract_with_claude(args.llm, model=args.model)
    elif args.corpus:
        g = load_jsonl_corpus(args.corpus)
    else:
        g = build_synthetic_corpus(seed=args.seed, inherit_rate=args.inherit_rate)

    if g.n == 0 or not g.edges:
        print("empty graph — nothing to measure", file=sys.stderr)
        return 1

    res = analyse(g, ceiling_frac=args.ceiling, trials=args.trials, seed=args.seed)
    print_report(res)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(res, fh, ensure_ascii=False, indent=2)
        print(f"\n[json written to {args.json}]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
