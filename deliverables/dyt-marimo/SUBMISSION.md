# Submission prep — video script + molab publishing

This covers the two human steps left: **record the walkthrough video** and
**publish + submit** before the **June 28** deadline.

---

## A. Video-explainer script / storyboard (~3 minutes)

Aim for ~3 minutes, screen-recording the notebook while you talk. Each beat below
maps to a section of `notebook.py`.

### 0:00 — Hook (15s)
> "Every Transformer ships with a normalization layer, and we treat it as
> essential. This paper deletes it — and replaces it with one line: `γ·tanh(αx)+β`.
> Let me show you why that works, interactively."

Show: the title cell.

### 0:15 — The observation (35s)
> "First I train a normal Transformer with LayerNorm. Then I put hooks on the
> norm layers and just plot input versus output."

Click **Train baseline**. When the S-curve appears:
> "Look at the shape — it's an S. A LayerNorm, measured directly, behaves like a
> squashed tanh. Watch what happens as I pick deeper layers..."

Switch the **layer selector** to a deeper layer:
> "...it sharpens. That's the whole motivation."

### 0:50 — The idea, interactive (30s)
> "So here's `tanh(αx)`. Alpha controls steepness."

Drag the **α slider** low then high:
> "Small alpha is nearly linear; large alpha saturates hard — exactly like the
> curve we just measured. And the squashing has to be smooth, bounded, and
> centered — I'll come back to that."

### 1:20 — The module (15s)
Show the DyT code cell:
> "The replacement is genuinely one line in the forward pass. One scalar alpha,
> the usual gamma and beta. No mean, no variance, no reduction."

### 1:35 — The proof (40s)
Click **Train DyT**:
> "Same architecture, same seed, same learning rate — zero DyT-specific tuning."

When the overlaid curves render:
> "And the curves track each other. DyT matches the normalized baseline."

Point at the final-loss line.

### 2:15 — The speed-up (15s)
Click **Run speed benchmark**:
> "Matching quality is only half of it. DyT has no mean or variance to compute — no
> reduction. So I time it head-to-head against LayerNorm and RMSNorm."

When the latency curves render:
> "DyT pulls ahead, and the gap widens with hidden size — that's the cost of the
> reduction the normalized ops can't avoid."

### 2:30 — What α learns (20s)
Show the α-vs-1/std bar chart:
> "The learned alpha lines up with one-over-std of the activations. With a single
> parameter, DyT rediscovers the scale that normalization computes by hand."

### 2:50 — Original extension (30s)
Click **Run ablation**:
> "My extension: which property of tanh actually matters? I swap in hardtanh,
> sigmoid, and plain identity."

When results render:
> "Identity — no squashing — trains worst: boundedness is load-bearing. Hardtanh
> trails tanh: smoothness helps. So DyT works because the squash is smooth,
> bounded, and centered — exactly the LayerNorm shape from the start."

### 3:20 — Beyond Transformers (25s)
Scroll to Section 8 and click **Train MLP: BatchNorm vs DyT vs no-norm**:
> "One more question — is this an attention thing? So I drop DyT into a plain MLP,
> no attention anywhere, on a little spiral dataset, against BatchNorm."

When the curves and decision boundaries render:
> "DyT matches BatchNorm, no-norm trails, and the two normalized nets carve out
> the same boundary. The idea generalizes — because it was never about attention,
> just a smooth bounded squash."

### 3:45 — Close (10s)
> "Normalization wasn't magic — it was a tanh. And making that explicit gives you
> a simpler, reduction-free block — in Transformers and beyond. Thanks for watching."

**Recording tips:** pre-click the training buttons once before recording so
results are cached and snappy (or keep the GPU profile and let them run live if
fast enough). Use a clean browser zoom so plots and sliders are legible.

---

## B. Publishing to molab

[molab](https://molab.marimo.io) is marimo's hosted notebook environment with GPU
access.

1. Go to **https://molab.marimo.io** and sign in.
2. **Create a new notebook**, then either:
   - upload `notebook.py` directly, or
   - paste its contents into a fresh notebook and save as `notebook.py`.
3. Add the dependencies. molab uses inline script metadata / a package panel —
   add `marimo`, `torch`, `numpy`, `matplotlib` (mirrors `requirements.txt`).
4. **Select a GPU runtime** so the notebook picks the GPU profile automatically
   (the code detects CUDA and scales up).
5. Run top-to-bottom: click **Train baseline**, **Train DyT**, **Run speed
   benchmark**, **Run ablation**, then **Train MLP** (Section 8). Confirm every
   plot renders, the DyT/baseline curves track, the benchmark shows DyT ahead,
   and the MLP's DyT/BatchNorm curves and boundaries match.
6. **Publish / share** the notebook and copy the public link.

---

## C. Submitting to the competition

1. Open the **alphaXiv × marimo Notebook Competition #2** submission form.
2. Provide:
   - the **public molab link** from step B6,
   - the **video link** (upload the recording to YouTube/Loom or as the form
     allows),
   - the paper reference: *Transformers without Normalization*,
     [arXiv:2503.10622](https://arxiv.org/abs/2503.10622),
   - a short blurb (reuse the README's "What the notebook does" list).
3. Submit **before June 28**. Double-check the molab link opens in an incognito
   window (public access) before finalizing.

### Rubric reminders this notebook targets
- **Interactivity:** α slider, squashing picker, layer selector, run-button-gated
  GPU training.
- **Real GPU experiment:** baseline-norm vs DyT trained head-to-head with live
  progress and overlaid curves.
- **Efficiency claim made tangible:** a latency/throughput micro-benchmark showing
  the reduction-free DyT is faster than LayerNorm/RMSNorm, with the gap growing in
  hidden size.
- **Faithful reproduction:** the measured LayerNorm S-curve and learned-α analysis.
- **Original extension:** the squashing-function ablation isolating *why* tanh.
- **Generalization beyond the paper:** DyT dropped into a non-Transformer MLP,
  matched head-to-head against BatchNorm on a synthetic task.
