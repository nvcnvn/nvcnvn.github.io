---
title: "I have a big slab of DRAM at home"
description: "mmmllm, part 1. SGLang shipped a unified radix cache for managing a big slab of GPU memory. I have a big slab of DRAM at home: a Mac mini whose CPU, GPU and Neural Engine all share it. So I built an LLM server around it, for fun."
date: 2026-11-26
tags: [mmmllm, llm, apple-silicon, memory]
series: mmmllm
part: 1
draft: false
---

My day job is AI inference engineering, which mostly means glue code. I run engines like
[SGLang](https://github.com/sgl-project/sglang) in production, chase their releases, and every so often find and fix
a bug in them. "Every so often" is generous. There are a lot of random bugs.

So when SGLang announced its
[unified radix cache](https://www.lmsys.org/blog/2026-08-11-unified-radix-cache/), my first reaction was not
excitement. It was: *not another big breaking-change release.*

Then I read it, and it felt familiar. Strip away the model-specific parts and it is a way to manage one big slab of
memory: cut it into blocks, hand them out to requests, share the ones that can be shared, evict the rest, and never
hand out a block someone is still reading.

And I have a big slab of DRAM at home. It's a Mac mini with an M4 Pro and 64 GB of RAM, and the CPU, the GPU and the
Neural Engine all share it. Simpler than a rack of H200s, and different in ways that turned out to be interesting.

So I took my free time and my AI subscription's tokens and built
[mmmllm](https://github.com/nvcnvn/mmmllm) ("my mac mini llm"): an LLM server in C++ and Metal that runs Qwen3.6-27B,
4-bit, on that Mac mini. Is writing your own inference engine to run one model on one desktop a stubborn thing to do?
Yes. But I paid for a GPU *and* a Neural Engine, and I want to use all of it.

> **Have an M4 Mac?** It's on PyPI, so trying it is one line:
>
> ```sh
> uvx mmmllm chat mlx-community/Qwen3.5-0.8B-4bit
> ```
>
> macOS 15+, M4 or M4 Pro. `serve` instead of `chat` gives you an OpenAI-style API. The 27B
> (`mlx-community/Qwen3.6-27B-4bit`) needs a 32 GB+ Mac.

Most of the code turned out not to be math. It is bookkeeping: which bytes belong to which request, who may write
them, and when they can be reused. This series is about that bookkeeping:

1. **The core idea** (this post): one slab, how it is cut up, and the one rule.
2. A bunch of matmuls fighting over 273 GB/s: what the model actually does with memory.
3. Sharing and running ahead: the prefix cache, and keeping the GPU busy without corrupting anything.
4. Later, once it's built: spilling the cache to disk.

You don't need to know how a transformer works for this post. Two facts are enough, and they come up when needed.

## One block of DRAM, three processors

[![Three processors, CPU 14 cores, GPU 20 cores, Neural Engine 16 cores, over one 64 GB pool at 273 GB/s](/images/mmmllm/ram.svg)](/images/mmmllm/ram.svg)

There is no "GPU memory" on this machine. There is one pool of 64 GB, and three processors read and write it:

- the **CPU**: 14 cores. It does the bookkeeping, the tokenizer, the HTTP server.
- the **GPU**: 20 cores. It reads big buffers at 210–238 GB/s (measured) and does most of the math.
- the **Neural Engine** (ANE): 16 cores. Fast at big matrix multiplications (~13 TFLOPS when they are cut into small
  pieces), slow at streaming data (~39 GB/s). It helps with one phase of the work; part 2 explains which.

A Metal buffer is the same physical pages in the CPU's and the GPU's page tables. The Neural Engine reads and writes
IOSurfaces, which the GPU can map as buffers too. So nothing is ever copied between processors. That is the good news.

The bad news is that sharing the bytes is not sharing the rules. When the CPU hands the GPU a batch of work (a
*command buffer*), the GPU may read any of its bytes until the batch completes. If the CPU overwrites them in the
meantime, the GPU computes garbage, silently. Metal can track this for you, per buffer. I turn that off, because
almost all of the data lives in one huge buffer, and tracking it as one object would serialize everything.

So the whole design comes down to one rule:

> **Never overwrite bytes another processor may still be reading.**

The rest of this post is how the memory is cut up so that rule is cheap to follow.

## How I cut it up

[![The 64 GB cut into macOS, weights, workspace, arena, step tables, counters and free memory; each region says which processor reads or writes it](/images/mmmllm/split.svg)](/images/mmmllm/split.svg)

Everything is allocated once, at startup, and never again. Creating a GPU buffer costs syscalls, zero-filling and
GPU page-table updates; doing that in the middle of generating tokens would show up as stutter. So:

| Region | What | Size (27B) |
|---|---|---|
| Weights | the model file, `mmap`ed and wrapped as a GPU buffer without a copy | 15.1 GB |
| Workspace | scratch space for the current step's activations | 1–4 GB |
| **Arena** | every request's memory | 12 GiB (`--arena-gib`) |
| Step tables | small arrays telling the GPU where each request's memory is | a few KB |
| Counters | who owns what (CPU only) | KBs to MBs |

Read the picture by columns. Two regions are wanted by more than one processor, and they are the hard part:

- the **weights**: the GPU reads all of them for every token, and the Neural Engine needs them too. That's part 2.
- the **arena**: the CPU decides what goes where, the GPU reads and writes the bytes. That's this post.

## The arena: a request's memory, in blocks

Fact one about LLMs: while a request runs, the model keeps memory for it. On this model there are two kinds:

- a part that **grows**: 64 KiB for every token of the conversation so far (the *KV cache*);
- a part that **doesn't**: a fixed 147 MiB summary per request (the *state*), rewritten with every token.

A server runs many requests at once, they come and go, and their conversations grow at different speeds. The classic
answer, from operating systems, is paging: cut memory into equal blocks and give each request a list of them.

[![A's 100 tokens cut into 4 pages of 32; each page is one 2 MiB unit somewhere in the arena; A's step-table row lists their numbers](/images/mmmllm/pages.svg)](/images/mmmllm/pages.svg)

In mmmllm the arena is one buffer of **units** of 2 MiB each, so 12 GiB is 6,144 units:

- every 32 tokens of a request are one *page*, and one page is exactly one unit;
- the fixed state is 74 units;
- any free unit serves any need. A request's units don't have to be next to each other, and nothing ever moves.

That last point matters more than it looks. Many engines keep separate pools for different kinds of memory, and
then have to tune the ratio between them. Here there is one unit size, so there is nothing to tune and nothing to
compact.

[![Arena units 0–23: A's pages and A's state units mixed with other requests' units](/images/mmmllm/zoom-arena.svg)](/images/mmmllm/zoom-arena.svg)

To the allocator, a page and a piece of state are the same thing: a 2 MiB unit. Only the request knows which of its
units are which.

## A very thin bitmap

Units never move, so a unit's number is its address: unit *s* starts at byte *s* × 2 MiB of the arena buffer. And
the free list can be one bit per unit.

[![Word 0 of the free bitmap over arena units 0–63: bit s is unit s, a 1 only where the unit is free](/images/mmmllm/bitmap.svg)](/images/mmmllm/bitmap.svg)

6,144 units need 6,144 bits: 768 bytes, six cache lines. Allocation is "find the lowest free unit":

```cpp
uint32_t Arena::alloc() {
    size_t word = 0;
    while (word < free_bitmap.size() && !free_bitmap[word]) word++;
    uint32_t unit = word * 64 + __builtin_ctzll(free_bitmap[word]);  // lowest set bit
    free_bitmap[word] &= free_bitmap[word] - 1;                        // clear it
    request_refs[unit] = 1;
    return unit;
}
```

If this looks familiar, it should. A bitmap plus "count trailing zeros" is how ext4 finds a free disk block, how
jemalloc finds a free slot in a slab, how SQL Server finds a free extent in its allocation-map pages, and how Go's
runtime finds a free object in a span (`nextFreeFast`, one `TrailingZeros64`). Decades of operating systems,
databases and language runtimes, and the state of the art in "give me a free block" is still: find the first 1.
The LLM is the new part of this server. The allocator is the most borrowed code in it, and that's the point.

## How the GPU finds a unit: the step table

The GPU never sees the bitmap or the counters. Before each step of work, the CPU writes a small table: for each
request in the step, the list of its unit numbers, in order. The GPU kernel that needs a request's memory reads its
row, then computes addresses itself:

```
address = unit number × 2 MiB + offset inside the unit
```

It is a page table, except that the "MMU" is my own GPU kernel. Copying the lists every step costs a few KB, and in
exchange the GPU keeps no state about the arena at all.

The table is tiny, but it is the most dangerous buffer in the program: if the CPU rewrote it while the GPU was
reading it, the GPU would read another request's memory. So there are two copies. The CPU fills one while the GPU
reads the other, and they swap every step.

## Who holds a unit

A unit can have two kinds of owners:

- **requests** that are using it (`request_refs`);
- the **prefix cache** (`cache_refs`): when a request ends, its prompt's pages can be kept, so the next request with
  the same beginning (the same system prompt, the same chat history) can skip recomputing them. Part 3 is about this.

Two counters, because the two owners let go at different times: a request when it ends, the cache when it needs room.

Where do they live? Not in the block. There is no header in a unit: all 2 MiB are the GPU's data. The counters are
plain arrays on the CPU's heap, indexed by unit number, next to the bitmap:

```cpp
std::vector<uint64_t> free_bitmap;               // 1 bit per unit
std::vector<uint16_t> request_refs, cache_refs;  // 1 counter each per unit
```

6,144 units × 2 counters × 2 bytes is 24 KiB, plus the bitmap's 768 bytes. Keeping them out of the blocks matters
for two reasons. A header would break the layout: one page is exactly one unit only because every byte of it is K/V.
And the CPU updates counters all the time, often for units the GPU is reading at that moment. Writing a counter into
the block itself would break the one rule. In a side array, the GPU never sees the counters at all.

## The life of one block

Here is one unit, number 10, while one request comes and goes. Every value is replayed from the real allocator code.

[![Unit 10 through eight moments: free, written by A's prefill, shared with the cache, cache-only, pending, free, C's first page](/images/mmmllm/block-life.svg)](/images/mmmllm/block-life.svg)

- It starts **free** (bit = 1).
- Request A takes it for its page 2 and fills it: **live**, one request ref.
- The cache takes a ref on the same unit, no copy. The page is full, so nobody will write it again, which makes
  sharing safe.
- A finishes, and its whole conversation goes into the cache. Unit 10 is now **cache-only**: still valid, ready for
  A's next turn or any request with the same beginning.
- Request C needs room, so the cache lets it go. Nobody holds it now, but its bit stays 0: it is **pending**.
- A moment later its bit goes back to 1, and C's first page lands right there.

Why the "pending" stage? Because the CPU runs ahead of the GPU. While the GPU works on step N, the CPU is already
preparing step N+1, so when the CPU decides a unit is no longer needed, a step that was already sent may still read
it. So mmmllm separates two facts:

- **"this memory is accounted for"** is a CPU fact. It updates at once, so a new request can be admitted right away.
- **"this memory may be overwritten"** is a GPU fact. It arrives when the GPU signals that it finished every step
  that could read the unit. Only then does the bit go back to 1.

```cpp
void Arena::retire(uint64_t signaled) {  // signaled = last step the GPU finished
    for (; !pending.empty() && pending.front().second <= signaled; pending.pop_front())
        free_bitmap[pending.front().first / 64] |= 1ull << (pending.front().first % 64);
}
```

That is the rule from the beginning, turned into a queue: never overwrite what someone may still be reading, but
never make anyone wait for it either.

So far, nothing here would surprise an operating system, a database, or SGLang: blocks, a free list, refcounts,
and a rule about readers. The interesting part is what is *inside* the blocks, and that three different processors
take turns with them. That's the rest of the series.

## Next

- **[Part 2](/blog/mmmllm-2-matmuls-vs-bandwidth/):** a bunch of matmuls fighting over 273 GB/s. What the model does in a step, why decode is about bandwidth and prefill is
  about math, what is inside one of these 2 MiB units, and how the Neural Engine uses the GPU's copy of the weights.
- **[Part 3](/blog/mmmllm-3-sharing-and-running-ahead/):** sharing and running ahead. The prefix cache, the state that can't be shared, and the frame-by-frame
  story of a request through the counters.

The code is at [github.com/nvcnvn/mmmllm](https://github.com/nvcnvn/mmmllm): the arena is `src/memory.mm`, and the
design notes with the measurements behind each choice are in `docs/memory-design.md`.
