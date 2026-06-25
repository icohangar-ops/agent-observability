# Transformers without Normalization (DyT) — marimo notebook

A self-contained, interactive [marimo](https://marimo.io) notebook for the
**alphaXiv × marimo Notebook Competition #2**, bringing to life the core idea of
**"Transformers without Normalization"** (Zhu, Chen, He, LeCun, Liu —
[arXiv:2503.10622](https://arxiv.org/abs/2503.10622)).

The paper replaces every `LayerNorm`/`RMSNorm` in a Transformer with a single
element-wise op, **Dynamic Tanh**:

```
DyT(x) = γ · tanh(α · x) + β
```

`α` is one learnable scalar; `γ, β` are the usual per-channel affine parameters.
No mean, no variance, no reduction — and it matches normalized Transformers,
mostly without tuning.

## What the notebook does

1. **The observation** — trains a small normalized Transformer and *measures* the
   tanh-like S-curve coming out of its `LayerNorm` layers (with a layer selector).
2. **The idea** — an interactive `α` slider and a squashing-function picker so you
   can feel how `tanh(αx)` reshapes activations and mirrors the measured curve.
3. **The module** — a clean, drop-in `DyT` implementation.
4. **The proof** — trains baseline-norm vs DyT side-by-side on the same data,
   same seed, same hyperparameters, and overlays the loss curves.
5. **What `α` learns** — visualizes learned per-layer `α` vs `1/std` of
   activations.
6. **Original extension** — a squashing-function ablation (`tanh` vs `hardtanh`
   vs `sigmoid` vs `identity`) that isolates *which* property of `tanh` matters,
   with a written takeaway.
7. **Beyond Transformers** — drops DyT into a small **MLP** (no attention) on a
   self-contained synthetic spirals task, trains BatchNorm vs DyT vs no-norm
   head-to-head, and shows DyT matches its BatchNorm counterpart (overlaid
   loss/accuracy curves + decision-boundary comparison), with a written takeaway
   on whether the idea transfers outside attention.

It is fully self-contained: a tiny character-level GPT trained on an embedded
public-domain corpus (Shakespeare), plus a NumPy-generated spirals dataset for
the MLP section. No downloads, no API keys, no paid services.

## Hardware

The notebook **auto-detects CUDA**. On a GPU (e.g. a molab session) it runs the
larger profile; with no GPU it falls back to a smaller, faster CPU profile so the
notebook still opens and runs. The heavy training cells are gated behind
**run buttons** so the notebook opens instantly — click them to train.

## Run it locally

```bash
pip install -r requirements.txt
marimo edit notebook.py     # interactive editor
# or
marimo run notebook.py      # read-only app view
```

### Headless validation

The training cells also honor environment variables for non-interactive runs:

```bash
DYT_AUTORUN=1 DYT_STEPS=24 python notebook.py   # quick smoke test, runs all cells
```

- `DYT_AUTORUN=1` — run the gated training cells without clicking the buttons.
- `DYT_STEPS=N` — override the number of training steps (handy for a fast check).

## Files

- `notebook.py` — the marimo notebook (the deliverable).
- `requirements.txt` — minimal dependencies.
- `SUBMISSION.md` — video-explainer script/storyboard + step-by-step molab
  publishing and competition-submission instructions.
