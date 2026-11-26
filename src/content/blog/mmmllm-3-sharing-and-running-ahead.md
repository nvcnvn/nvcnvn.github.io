---
title: "Sharing and running ahead: a prefix cache on an async GPU"
description: "mmmllm, part 3. Reusing a prompt's memory across requests, why a hybrid model's state must be copied, and how the counters stay right while the CPU runs a step ahead of the GPU."
date: 2026-11-26
tags: [mmmllm, llm, apple-silicon, memory]
series: mmmllm
part: 3
draft: false
---

[Part 1](/blog/mmmllm-1-dram-slab/) built the arena: 2 MiB units, a free bitmap, a step table, two
reference counts and a pending queue. [Part 2](/blog/mmmllm-2-matmuls-vs-bandwidth/) showed what lives in a unit:
K/V pages that only ever get appended to, and a state that is rewritten whole by every token. This post puts them to
work on the two things that make the bookkeeping hard: sharing memory between requests, and a GPU that is always
one step behind the CPU.

## Why share at all

Prompts repeat. A chat client re-sends the whole conversation every turn. An agent re-sends its tools and history.
Every request to the same app starts with the same system prompt. Reading a prompt is the slow part (on the 27B,
~130–190 tokens per second), so the cheapest prompt is one you already read.

Measured on the small (0.8B) model, cache off vs on:

| | without | with |
|---|---|---|
| the same 2k-token prompt again: time to first token | 435 ms | **19 ms** |
| 8 clients, 2k prompts sharing 1.5k: median time to first token | 2.30 s | **0.75 s** |
| … total throughput | 206 tok/s | **462 tok/s** |

And on the 27B, a chat's third turn: before v0.3.0 the cache held only prompt pages, so every turn re-read the previous
reply. Time to first token went from **3.50 s** to **0.49 s** once the whole conversation was cached (below).

## The prefix cache: a trie of pages

[![A prefix-cache trie of pages, keyed by chained hashes](/images/mmmllm/trie.svg)](/images/mmmllm/trie.svg)

The cache is a trie with one node per page (32 tokens). A node's key is a hash of its tokens chained with its
parent's hash, so "page *i* of this prompt" is one lookup that depends on everything before it. The tokens are
compared too, because a hash collision must never hand a request someone else's memory.

A node holds a cache ref on its unit; a request that reuses it adds a request ref on top. Most nodes are **full**
pages, and nobody ever writes a full page again, so it is shared as it is. The exception is the end of a finished
conversation, which rarely lands on a page boundary: its last, part-written page becomes a **tail node**. A request
that continues it (the chat's next turn) copies that one 2 MiB unit and writes the rest of the page in its copy. So no
shared unit is ever written, and there is no copy-on-write: one copy, up front, at most.

## The hybrid twist: K/V can resume anywhere, the state only at a snapshot

For a model with only full attention, that would be the whole story. Qwen3.6-27B also has 48 linear-attention layers
whose state is rewritten by every token. Matched K/V pages are useless without the state *as it was at the end of
those pages*, and that state no longer exists: the request that computed it has moved on.

So the cache also stores **snapshots**: copies of a request's state at chosen page boundaries. A lookup returns two
numbers: **L**, how many pages matched, and **S ≤ L**, the deepest matched page with a snapshot. The request resumes
at S. Pages between S and L are recomputed.

Snapshots are 74 units (147 MiB) each, so mmmllm takes them only where the next hit is likely to land, three per
request at most:

1. the **branch point**, where this request's match ended. The next request with the same shared prefix resumes there.
2. the prompt's **last full page**. A request that repeats this prompt with a different ending resumes there.
3. the **end** of the request: its whole sequence, prompt and reply. The next turn of the conversation resumes there.

The first two are copies taken in the middle of prefill, because the request will keep overwriting its state. The
third one costs nothing: the request is done, so its state units simply become the snapshot. This is the asymmetry
from part 2, paying off: a K/V page is shared as it is, and a state is copied unless its owner is finished with it.

## One capacity question

Every request needs units: pages for the part of its prompt that wasn't cached, a generation allowance, a state slot,
and one slot per snapshot it will make. All of that is reserved up front, in one function:

```
fits(n)     = n ≤ free_units − reserved
can_ever(n) = n ≤ free_units + cache_only_units − reserved

admit(n):
    if not can_ever(n): WAIT                # even evicting everything wouldn't help: evict nothing
    while not fits(n):  evict the cache's least recently used leaf
    reserved += n
```

`reserved ≤ free_units` always holds, so once a request is admitted, every later `alloc()` for it is guaranteed to
succeed. No request runs out of memory in the middle of a sentence, and nobody has to be killed or paused to make room.

Order matters in one place: a cache hit takes its refs on the matched pages and snapshot *before* calling `admit`,
because `admit` may evict, and it must not evict the entry this very request is about to use.

## Running ahead

If the CPU waited for each GPU step to finish before building the next, the GPU would sit idle between steps. So the
CPU builds step N+1 while the GPU runs step N:

```
CPU:  build N   build N+1   build N+2 ─ wait ─   build N+3
GPU:            run N       run N+1              run N+2
                     ▲ event = N        ▲ event = N+1
```

The GPU signals a shared event with the step number as each one finishes. The CPU is allowed at most one step ahead,
and that one rule is what makes the rest simple:

- **Two step tables** are enough: step N reads one copy while the CPU writes step N+1 into the other. Before reusing a
  copy for step N+2, the CPU checks that the event reached N (and asserts it).
- **The pending queue** (part 1) is enough: when a unit loses its last owner, it is tagged with the last step already
  sent. It counts as free for admission at once, but its bit only goes back to 1 when the event passes that step.

## One request, frame by frame

Here is the whole thing on a toy arena of 15 units, replayed from the real allocator and engine code (the state is
drawn as 2 units instead of 74). Three bands in every frame: what the GPU reads (the step tables), the arena, and the
counters only the CPU sees. Yellow cells changed since the previous frame.

### Where we start

[![B decoding; the cache holds a system prompt's two pages and a snapshot; the rest free](/images/mmmllm/arena-0.svg)](/images/mmmllm/arena-0.svg)

Request B is decoding. An earlier request left a 64-token system prompt in the cache: two pages and a snapshot (★).

### A's prefill: one page becomes shared

[![Prefill A: page 10 written by A, then inserted into the cache at the snapshot point](/images/mmmllm/arena-2b.svg)](/images/mmmllm/arena-2b.svg)

A arrives with the same system prompt plus a question. It matched the two cached pages and the snapshot, copied the
snapshot into its own state, and prefilled tokens 64–95 into unit 10. At token 96, the prompt's last full page, the
prefill lane holds back A's next chunk so A's state is exactly at 96, copies it into units 11–12, and inserts page 10
plus that copy into the cache. Unit 10 is now A's and the cache's at once, with no copy: it is full, so nobody will
write it again.

### A finishes: the whole conversation goes into the cache

[![A finishes; its whole sequence goes into the cache: page 13 as a tail node, A's state units as its snapshot](/images/mmmllm/arena-5.svg)](/images/mmmllm/arena-5.svg)

Step 41 gave A its stop token. But step 42 was already sent before the CPU knew, and it feeds that token: it writes
the token's K/V and A's state. So A ends only when step 42 is done, and no GPU work reads A any more. Then A's whole
sequence goes into the cache: page 13, holding the last 19 tokens, becomes a tail node, and A's state units become
its snapshot as they are. `release` drops A's refs, and every unit A held is now **cache-only**: still valid, ready
for A's next turn, and evictable.

### C arrives: accounted now, reused later

[![C admitted: the cache evicts A's tail and page 10 with their snapshots; they are pending until step 43](/images/mmmllm/arena-6.svg)](/images/mmmllm/arena-6.svg)

C, an unrelated request, needs 6 units. None is free, but 10 are cache-only, so `can_ever` says eviction can make
room. The cache evicts its least recently used leaf (A's tail and its snapshot), then the next (page 10 and ★@96).
Nobody owns them now, but step 43 is in flight, so they go **pending** until 43. `free_units` counts them already, so
C is admitted right away. Their free bits stay 0, so nothing can be written into them yet.

### Unit 10 comes back

[![The event reaches 43: the evicted units retire; C's state lands on A's old state units, its first page in unit 10](/images/mmmllm/arena-7.svg)](/images/mmmllm/arena-7.svg)

C's first `alloc` finds no free bit, so it waits for the GPU event: at most one step. The event reaches 43, the six
units retire, and `alloc` takes the lowest free bits: C's state lands where A's was, and C's first page in unit 10,
A's page 2 a moment ago. Nothing was erased: C simply overwrites them, and no one can be reading the old bytes,
because the GPU is past every step that could name them.

## How this compares

- **Garbage collectors.** Part 1 admitted the allocator is borrowed: a bitmap and `ctz`, like everyone else. The
  freeing side is not a collector, though. There are only two kinds of owner, so ownership is counted, not traced.
  The closest relative of the pending queue isn't GC at all: it's RCU, where the GPU is the reader that can't be
  interrupted, and the event passing a step is the grace period.
- **SGLang's [unified radix cache](https://www.lmsys.org/blog/2026-08-11-unified-radix-cache/).** The same core idea:
  one token-keyed tree, recurrent state valid only at exact checkpoints and copied into a private slot before use.
  The big difference is memory pools: SGLang keeps a pool per kind of memory and sizes them with ratio flags, here
  everything is the same 2 MiB unit from one bitmap. Two things worth borrowing: protecting cache entries that running
  requests use from eviction (mmmllm can currently evict a leaf a request holds; the units survive, the entry
  doesn't), and session-aware eviction order for multi-turn agents.

## What it adds up to

1. **One RAM, three processors**: no copies between them, but one bandwidth budget and one rule about writes.
2. **One unit size** for everything: a bit per unit is the whole free list, and nothing fragments.
3. **Slot numbers and a per-step table** instead of pointers: memory never moves, and the GPU keeps no state.
4. **Two reference counts**: a page can belong to a request and to the cache at once, with no copy.
5. **Reserve, then allocate**: an admitted request can't run out of memory.
6. **Accounting is instant, reuse waits for the GPU**: the pending queue makes running ahead safe.
7. **Hybrid models need snapshots**: K/V is a log you can cut anywhere, a state is a value you must copy, unless its
   owner is done with it.

The code: [github.com/nvcnvn/mmmllm](https://github.com/nvcnvn/mmmllm). Arena and step tables are in
`src/memory.mm`, the prefix cache in `src/prefix_cache.mm`, admit / snapshot / finish in `src/engine.mm`, and the
design with its measurements in `docs/memory-design.md`.

On an M4 Mac (macOS 15+), all of this is one line away: `uvx mmmllm chat mlx-community/Qwen3.5-0.8B-4bit`.

## Next: when the cache outgrows RAM

Today, when the arena is full, eviction throws a cached prompt away, and the next request with that prompt reads it
again from scratch: on the 27B, a long agent history is minutes of prefill. GPU servers answer this with a host-RAM
tier, then disk. On a Mac there is no host-RAM tier to add: the arena already is host RAM. The next tier is straight
to the SSD.

Part 4 is that tier: spilling prefix-cache nodes to disk and loading them back into the arena, without a staging
copy, without a new state in a block's life, and without the bugs other engines' disk caches shipped with.
