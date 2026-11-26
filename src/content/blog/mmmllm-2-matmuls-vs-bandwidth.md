---
title: "A bunch of matmuls fighting over 273 GB/s"
description: "mmmllm, part 2. Every token is a pile of matrix multiplications fighting over one memory bus. The loops an LLM server runs, why decode needs bandwidth and prefill needs math, what attention leaves behind in each 2 MiB block, and how the Neural Engine borrows the GPU's weights."
date: 2026-11-26
tags: [mmmllm, llm, apple-silicon, memory]
series: mmmllm
part: 2
draft: true
---

[Part 1](/blog/mmmllm-1-dram-slab/) cut the Mac mini's 64 GB slab into regions, and the arena into 2 MiB
units with a bitmap and a step table. It took two facts about the model on trust: a request's memory partly grows
with every token and partly doesn't. This post opens the model up just far enough to explain those facts and the
choices they forced. Spoiler: almost every choice comes down to a lot of matrix multiplications sharing one
273 GB/s memory bus, and deciding who gets it.

## Three loops, not two

Explanations of LLM inference usually show two loops: the layers, and the token-by-token generation around them.
That leaves out where a server spends its time. mmmllm has three:

```python
# 1. The request queue: HTTP threads queue requests,
#    one engine thread turns the crank.
while serving:
    engine.step()

# 2. One engine step: poll both lanes, admit, feed both lanes.
def step():
    for chunk in prefill_lane.finished():
        ...                    # that chunk's memory is written
    for token in decode_lane.finished():
        stream(token)          # one per running request
        if is_stop(token): finish(request)
    for request in waiting:    # admit what fits (part 3)
        if arena.admit(units_needed(request)):
            start_prefill(request)
    if prefill_lane.has_room():
        prefill_lane.submit(next_chunk())   # one prompt chunk
    if decode_lane.has_room():
        decode_lane.submit(next_step())     # one row per request

# 3. Inside a lane: the layer loop (next section).
```

The key point is that **prefill is not a phase before the loop**. It is a lane that the same loop feeds, one chunk of
a prompt at a time, while the decode lane keeps producing tokens for everyone else:

[![Time left to right: the request queue, the prefill lane running A's prompt in chunks, the decode lane producing a token for B and C every step; A joins decode when its prompt is done](/images/mmmllm/engine-loop.svg)](/images/mmmllm/engine-loop.svg)

- **Prefill** reads a new prompt, 1,024 tokens per chunk, and fills that request's memory. No token comes out.
- **Decode** produces one token for every running request, per step. A request joins when its prompt is done: its last
  prompt token is held back from prefill and becomes its first decode input.
- **The queue**: a request waits until the arena can promise it all the memory it will need. D waits until B finishes.

On the 27B, a prefill chunk takes about 5 seconds and a decode step about 80 ms, so in reality ~60 decode steps run
under each chunk. Keeping decode fast while a long prompt is being read is the whole reason for two lanes.

## Inside a lane: the layer loop

Each bar in that picture, a chunk or a step, runs the model once: 64 layers, in order. Every layer has two halves.

[![The model as a grid: layers as columns, prefill and decode as rows, per-request memory between them](/images/mmmllm/model.svg)](/images/mmmllm/model.svg)

*(The picture uses a small model's numbers; the 27B has 64 layers and 5,120 numbers per row.)*

- **`dense`**: matrix multiplications with the layer's fixed weights. It has no memory: same input, same output.
- **`attn`** (attention): the only part that touches per-request memory. It reads what earlier tokens left behind,
  and leaves something for later tokens.

Read the picture by columns: every column is one set of weights, read once per call, however many rows go through.
Then by rows:

- **Prefill** pushes many rows (the prompt's tokens) of one request through each layer. Each weight read serves 1,024
  rows, so the limit is arithmetic.
- **Decode** pushes one row per request. The weights are still read once for all rows, but every row also reads its own
  request's whole memory. Nothing is shared there, so the limit is how fast bytes come out of RAM.

That difference decides who does what:

| Work | Limited by | Runs on |
|---|---|---|
| Decode | bandwidth: 14.4 GB of weights per step, plus every request's memory | GPU (~64 ms per step at batch 1) |
| Prefill `dense` | math: 1,024 rows per weight read | Neural Engine, or the GPU |
| Attention, both phases | per-request memory | GPU: the only one that reads the arena |
| Bookkeeping | branches | CPU |

The Neural Engine streams weights at ~39 GB/s, so a decode step on it would take ~370 ms instead of 64. It never
decodes. But it is good at prefill's big multiplications, and every millisecond of prefill it takes is a millisecond
the GPU spends on decode instead.

## What attention leaves behind

Qwen3.6-27B is a *hybrid* model: of its 64 layers, 16 use full attention and 48 use linear attention. They leave very
different memory behind:

| | Full attention (16 layers) | Linear attention (48 layers) |
|---|---|---|
| What it keeps | a key and a value per token, per layer: the *KV cache* | one fixed-size summary per layer: the *state* |
| Size | 64 KiB per token, **grows** | 147 MiB per request, **fixed** |
| Updated how | **appended**: old tokens never change | **overwritten** by every token |

Those are the two facts part 1 relied on. The rest of this section zooms into one 2 MiB unit to see them, one level
at a time.

### Zoom 1: a K/V unit has a row per full-attention layer

[![Unit 22 as 16 rows, one per full-attention layer, each split into K and V for 4 heads](/images/mmmllm/zoom-unit.svg)](/images/mmmllm/zoom-unit.svg)

One unit is one page: 32 tokens, for **all 16** full-attention layers. The 48 linear layers have no row here. That is
also how the unit size was chosen: 16 rows of 128 KiB is exactly 2 MiB, so one page is exactly one unit, with no waste.

### Zoom 2: a row has K and V for 4 heads

[![Layer 3's row: 8 cells of 16 KiB, K and V for KV heads 0–3, each read by 6 of the 24 query heads](/images/mmmllm/zoom-row.svg)](/images/mmmllm/zoom-row.svg)

Attention has 24 *query heads* that ask questions and 4 *KV heads* whose keys and values answer them; each group of 6
query heads shares one KV head. So a token stores 4 keys and 4 values per layer, not 24 of each: 64 KiB per token
instead of 384.

### Zoom 3: a cell has a line per token

[![Layer 3, K, head 0: 32 lines for tokens 96–127, 96–99 written, 100 next](/images/mmmllm/zoom-cell.svg)](/images/mmmllm/zoom-cell.svg)

This is where "append only" becomes literal. Each new token writes one 512-byte line in each of the unit's 128 cells,
and old lines never change. The address at the bottom is the zooms added up; nothing stores a pointer.

Because old lines never change, a full page can be shared by several requests with the same prompt, as it is. That
is part 3's main trick.

### Zoom 4: the state is one span over 74 units

[![74 units in step-table order, with the 48 linear layers' state laid end to end across them](/images/mmmllm/zoom-state.svg)](/images/mmmllm/zoom-state.svg)

The same kind of units hold the other kind of memory. A request's state for the 48 linear layers is one 146.8 MiB
byte span, laid over its 74 units in step-table order. A layer's state (3.06 MiB) doesn't line up with unit
boundaries, and it doesn't need to: byte *x* of the span is in unit number `state[x / 2 MiB]`.

### Zoom 5: a linear layer's state is rewritten whole

[![Layer 0's state: 60 KiB of conv state and 48 heads of 128 × 128 fp32 matrices](/images/mmmllm/zoom-state-layer.svg)](/images/mmmllm/zoom-state-layer.svg)

No lines here. Every token reads all 48 matrices and writes all of them back. So there is no "state as of token *t*"
left behind: if you want one, you have to copy it at exactly that moment (or wait until the request is done
with it). Part 3 shows what that costs when you try
to reuse a prompt.

## One copy of the weights, two readers

Back to the other shared region: the weights. The GPU reads all 15 GB of them for every decode step. The Neural
Engine needs them for prefill too, but Core ML normally bakes weights into the compiled model, and the Neural Engine
keeps its own copy. On the 27B that would be a second ~15 GB, straight out of the arena.

[![Before: two copies, ~30 GB; now: one copy, and the GPU dequantizes one layer at a time into fp16 surfaces the Neural Engine takes as inputs](/images/mmmllm/weights.svg)](/images/mmmllm/weights.svg)

Instead, every weight is an *input* of the Core ML model. Before the Neural Engine runs layer *i* of a chunk, the GPU
expands layer *i*'s 4-bit weights from its own copy into fp16, in an IOSurface (the shared memory object from part
1), and the Neural Engine reads them from there. Nothing goes through the CPU, and only one layer's worth exists at a
time.

It is not free. The GPU writes ~0.75 GB of fp16 per layer, per chunk (~5 ms), and weights as inputs run slower on the
Neural Engine than baked ones. Two chunks are in flight, so there are two sets of these weight surfaces (~0.9 GB
each): the Neural Engine works from one while the GPU fills the other. A set is rewritten only after the Neural
Engine call that read it has returned: the rule from part 1 again.

What it buys, measured on the 27B:

| | GPU prefill | Neural Engine, one copy |
|---|---|---|
| prompt of 4,096 tokens | 131 tok/s | **191 tok/s** |
| decode while a 2,048-token prompt is read | 3.3 tok/s | **12.1 tok/s** |
| peak memory | 16.7 GB | 19.8 GB |

The second row is the point: with the GPU doing prefill, everyone else's generation nearly stops while a long prompt
comes in. With the Neural Engine doing the heavy half, it barely slows down.

To try it on a 32 GB+ M4 Mac (the first run builds the Core ML blocks, about 30 s, once per model):

```sh
uvx --python 3.13 --from 'mmmllm[ane]' mmmllm chat mlx-community/Qwen3.6-27B-4bit --prefill ane
```

## Next

[Part 3](/blog/mmmllm-3-sharing-and-running-ahead/): sharing and running ahead. Full K/V pages can be shared as they
are, the state has to be copied, and the CPU runs a step ahead of the GPU. How the prefix cache, the counters and the
pending queue fit together, frame by frame.
