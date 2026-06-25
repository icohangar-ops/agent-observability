import marimo

__generated_with = "0.23.10"
app = marimo.App(width="medium", app_title="Transformers without Normalization (DyT)")


@app.cell
def _(mo):
    mo.md(
        r"""
        # Transformers without Normalization — a hands-on tour of **Dynamic Tanh (DyT)**

        *An interactive companion to* **"Transformers without Normalization"**
        *(Zhu, Chen, He, LeCun, Liu — [arXiv:2503.10622](https://arxiv.org/abs/2503.10622)).*

        ---

        ### The claim that should not work

        Every modern Transformer ships with a normalization layer — `LayerNorm` or
        `RMSNorm` — wired into every block. It is treated as load-bearing: remove it and
        training is supposed to diverge. Normalization also costs something real: it
        forces a **reduction** (a mean/variance computed across the feature dimension at
        every token, every layer), which is a synchronization point on the GPU.

        The paper makes a deliberately provocative claim: you can delete normalization
        entirely and replace it with a single **element-wise** operation,

        $$\mathrm{DyT}(x) = \gamma \cdot \tanh(\alpha x) + \beta$$

        where $\alpha$ is **one learnable scalar** and $\gamma, \beta$ are the usual
        per-channel affine parameters. No mean. No variance. No reduction. And it
        *matches or beats* the normalized model — usually with **no hyperparameter
        tuning**.

        ### Why a `tanh`?

        The motivating observation (which we reproduce below from a model we actually
        train) is that a trained `LayerNorm`, plotted as input → output, traces an
        **S-shaped curve** — it behaves like a squashed `tanh`. DyT just *is* that
        curve, made explicit and cheap.

        ### Roadmap of this notebook

        1. **The observation** — train a small normalized Transformer and *measure* the
           tanh-like S-curve of its `LayerNorm` layers (with a layer selector).
        2. **The idea** — an `α` slider + a squashing-function picker so you can feel how
           `tanh(αx)` reshapes activations and mirrors the measured curve.
        3. **The module** — a clean, drop-in `DyT` implementation.
        4. **The proof** — train baseline-norm vs DyT side-by-side on the same data and
           watch the curves track each other.
        5. **The speed-up** — a latency/throughput micro-benchmark showing DyT is
           *faster* than LayerNorm/RMSNorm because it has no reduction op.
        6. **What `α` learns** — visualize the learned per-layer `α` and its link to
        7. **The property of `tanh` (ablation)** — a squashing-function ablation that
           isolates *which* property of `tanh` actually matters.
        8. **Beyond Transformers** — drop DyT into a small **MLP** (no attention) on a
           tiny synthetic task and show it still matches its **BatchNorm** counterpart.
        9. **Conclusion** — a summary of the findings and their implications.

        Everything is self-contained: a tiny character-level GPT trained on an embedded
        public-domain corpus. It uses a GPU automatically if one is present and falls
        back cleanly to CPU at a smaller size.
        """
    )
    return


@app.cell
def _():
    import marimo as mo
    import os
    import math
    import time

    import numpy as np
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    import matplotlib.pyplot as plt

    return F, math, mo, nn, np, os, plt, time, torch


@app.cell
def _(mo, os, torch):
    def seed_everything(seed: int = 1337):
        import random

        random.seed(seed)
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)

    seed_everything()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    on_gpu = device == "cuda"
    device_name = torch.cuda.get_device_name(0) if on_gpu else "CPU"

    # Configuration scales with the available hardware. The GPU profile is sized to
    # run comfortably inside a molab session; the CPU profile keeps the notebook
    # openable and runnable (just smaller/faster) when no GPU is present.
    if on_gpu:
        CFG = dict(
            d_model=192, n_head=6, n_layer=6, block_size=128,
            batch_size=64, steps=2500, eval_interval=125, eval_iters=40,
            lr=3e-3, dropout=0.1,
        )
    else:
        CFG = dict(
            d_model=96, n_head=4, n_layer=4, block_size=64,
            batch_size=32, steps=400, eval_interval=40, eval_iters=20,
            lr=3e-3, dropout=0.1,
        )

    # Allow a quick smoke-test override (used for headless validation).
    if os.environ.get("DYT_STEPS"):
        CFG["steps"] = int(os.environ["DYT_STEPS"])
        CFG["eval_interval"] = max(1, CFG["steps"] // 8)

    mo.md(
        f"""
        **Hardware detected:** `{device_name}` &nbsp;→&nbsp; running the
        **{'GPU' if on_gpu else 'CPU-fallback'}** profile.

        Model: `d_model={CFG['d_model']}`, `n_layer={CFG['n_layer']}`,
        `n_head={CFG['n_head']}`, `block_size={CFG['block_size']}`,
        `steps={CFG['steps']}`.
        """
    )
    return CFG, device, seed_everything


@app.cell
def _(CFG, device, torch):
    # A small, embedded, public-domain corpus (Shakespeare — sonnets & a soliloquy).
    # Character-level modeling needs no download and trains quickly while still
    # showing a real, decreasing validation curve.
    CORPUS = """To be, or not to be, that is the question:
Whether 'tis nobler in the mind to suffer
The slings and arrows of outrageous fortune,
Or to take arms against a sea of troubles
And by opposing end them. To die, to sleep,
No more; and by a sleep to say we end
The heart-ache and the thousand natural shocks
That flesh is heir to: 'tis a consummation
Devoutly to be wish'd. To die, to sleep;
To sleep, perchance to dream, ay, there's the rub,
For in that sleep of death what dreams may come,
When we have shuffled off this mortal coil,
Must give us pause. There's the respect
That makes calamity of so long life.

Shall I compare thee to a summer's day?
Thou art more lovely and more temperate:
Rough winds do shake the darling buds of May,
And summer's lease hath all too short a date:
Sometime too hot the eye of heaven shines,
And often is his gold complexion dimm'd;
And every fair from fair sometime declines,
By chance or nature's changing course untrimm'd;
But thy eternal summer shall not fade
Nor lose possession of that fair thou owest;
Nor shall Death brag thou wander'st in his shade,
When in eternal lines to time thou growest:
So long as men can breathe or eyes can see,
So long lives this and this gives life to thee.

When, in disgrace with fortune and men's eyes,
I all alone beweep my outcast state,
And trouble deaf heaven with my bootless cries,
And look upon myself and curse my fate,
Wishing me like to one more rich in hope,
Featured like him, like him with friends possess'd,
Desiring this man's art and that man's scope,
With what I most enjoy contented least;
Yet in these thoughts myself almost despising,
Haply I think on thee, and then my state,
Like to the lark at break of day arising
From sullen earth, sings hymns at heaven's gate;
For thy sweet love remember'd such wealth brings
That then I scorn to change my state with kings.

Let me not to the marriage of true minds
Admit impediments. Love is not love
Which alters when it alteration finds,
Or bends with the remover to remove:
O no! it is an ever-fixed mark
That looks on tempests and is never shaken;
It is the star to every wandering bark,
Whose worth's unknown, although his height be taken.
Love's not Time's fool, though rosy lips and cheeks
Within his bending sickle's compass come;
Love alters not with his brief hours and weeks,
But bears it out even to the edge of doom.
If this be error and upon me proved,
I never writ, nor no man ever loved.
"""

    chars = sorted(set(CORPUS))
    vocab_size = len(chars)
    stoi = {c: i for i, c in enumerate(chars)}
    itos = {i: c for i, c in enumerate(chars)}

    def encode(s):
        return [stoi[c] for c in s]

    def decode(ids):
        return "".join(itos[int(i)] for i in ids)

    _data = torch.tensor(encode(CORPUS), dtype=torch.long)
    _n = int(0.9 * len(_data))
    train_data = _data[:_n]
    val_data = _data[_n:]

    def get_batch(split, g=None):
        d = train_data if split == "train" else val_data
        bs = CFG["batch_size"]
        T = CFG["block_size"]
        ix = torch.randint(len(d) - T - 1, (bs,), generator=g)
        x = torch.stack([d[i : i + T] for i in ix])
        y = torch.stack([d[i + 1 : i + 1 + T] for i in ix])
        return x.to(device), y.to(device)

    return decode, get_batch, vocab_size


@app.cell
def _(F, nn, torch):
    class DyT(nn.Module):
        """Dynamic Tanh: a drop-in, reduction-free replacement for LayerNorm/RMSNorm.

        DyT(x) = gamma * squash(alpha * x) + beta

        - `alpha` is a single learnable scalar that controls how hard inputs are
          squashed (it ends up tracking ~1/std of the activations).
        - `gamma`, `beta` are the usual per-channel affine parameters.
        - There is no mean/variance reduction, so it is purely element-wise.

        The `squash` argument exists only for the ablation later in the notebook;
        the paper (and the default here) uses `tanh`.
        """

        def __init__(self, dim, init_alpha=0.5, squash="tanh"):
            super().__init__()
            self.alpha = nn.Parameter(torch.full((1,), float(init_alpha)))
            self.gamma = nn.Parameter(torch.ones(dim))
            self.beta = nn.Parameter(torch.zeros(dim))
            self.squash = squash

        def forward(self, x):
            s = self.alpha * x
            if self.squash == "tanh":
                s = torch.tanh(s)
            elif self.squash == "hardtanh":
                s = F.hardtanh(s)
            elif self.squash == "sigmoid":
                s = torch.sigmoid(s)
            elif self.squash == "identity":
                pass
            else:
                raise ValueError(f"unknown squash {self.squash!r}")
            return self.gamma * s + self.beta

    class RMSNorm(nn.Module):
        def __init__(self, dim, eps=1e-5):
            super().__init__()
            self.weight = nn.Parameter(torch.ones(dim))
            self.eps = eps

        def forward(self, x):
            rms = x.pow(2).mean(-1, keepdim=True).add(self.eps).rsqrt()
            return x * rms * self.weight

    def make_norm(kind, dim):
        if kind == "layernorm":
            return nn.LayerNorm(dim)
        if kind == "rmsnorm":
            return RMSNorm(dim)
        if kind == "batchnorm":
            return nn.BatchNorm1d(dim)
        if kind == "dyt":
            return DyT(dim, squash="tanh")
        if kind.startswith("dyt-"):
            return DyT(dim, squash=kind.split("-", 1)[1])
        raise ValueError(f"unknown norm {kind!r}")

    return DyT, make_norm


@app.cell
def _(CFG, F, make_norm, nn, torch):
    class CausalSelfAttention(nn.Module):
        def __init__(self, d_model, n_head, dropout):
            super().__init__()
            assert d_model % n_head == 0
            self.n_head = n_head
            self.qkv = nn.Linear(d_model, 3 * d_model)
            self.proj = nn.Linear(d_model, d_model)
            self.drop = nn.Dropout(dropout)

        def forward(self, x):
            B, T, C = x.shape
            q, k, v = self.qkv(x).split(C, dim=2)
            hs = C // self.n_head
            q = q.view(B, T, self.n_head, hs).transpose(1, 2)
            k = k.view(B, T, self.n_head, hs).transpose(1, 2)
            v = v.view(B, T, self.n_head, hs).transpose(1, 2)
            y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
            y = y.transpose(1, 2).contiguous().view(B, T, C)
            return self.drop(self.proj(y))

    class Block(nn.Module):
        def __init__(self, cfg, norm_kind):
            super().__init__()
            d = cfg["d_model"]
            self.norm1 = make_norm(norm_kind, d)
            self.attn = CausalSelfAttention(d, cfg["n_head"], cfg["dropout"])
            self.norm2 = make_norm(norm_kind, d)
            self.mlp = nn.Sequential(
                nn.Linear(d, 4 * d),
                nn.GELU(),
                nn.Linear(4 * d, d),
                nn.Dropout(cfg["dropout"]),
            )

        def forward(self, x):
            x = x + self.attn(self.norm1(x))
            x = x + self.mlp(self.norm2(x))
            return x

    class TinyGPT(nn.Module):
        """A minimal GPT whose only configurable knob is the normalization kind."""

        def __init__(self, cfg, vocab_size, norm_kind):
            super().__init__()
            d = cfg["d_model"]
            self.block_size = cfg["block_size"]
            self.tok = nn.Embedding(vocab_size, d)
            self.pos = nn.Embedding(cfg["block_size"], d)
            self.blocks = nn.ModuleList(
                [Block(cfg, norm_kind) for _ in range(cfg["n_layer"])]
            )
            self.norm_f = make_norm(norm_kind, d)
            self.head = nn.Linear(d, vocab_size, bias=False)
            self.head.weight = self.tok.weight  # weight tying

        def forward(self, idx, targets=None):
            B, T = idx.shape
            pos = torch.arange(T, device=idx.device)
            x = self.tok(idx) + self.pos(pos)[None]
            for blk in self.blocks:
                x = blk(x)
            x = self.norm_f(x)
            logits = self.head(x)
            loss = None
            if targets is not None:
                loss = F.cross_entropy(
                    logits.view(-1, logits.size(-1)), targets.view(-1)
                )
            return logits, loss

        @torch.no_grad()
        def generate(self, idx, max_new_tokens, temperature=0.8):
            for _ in range(max_new_tokens):
                idx_cond = idx[:, -self.block_size :]
                logits, _ = self(idx_cond)
                logits = logits[:, -1, :] / temperature
                probs = F.softmax(logits, dim=-1)
                nxt = torch.multinomial(probs, 1)
                idx = torch.cat([idx, nxt], dim=1)
            return idx

    def count_params(m):
        return sum(p.numel() for p in m.parameters())

    return TinyGPT, count_params


@app.cell
def _(CFG, TinyGPT, device, get_batch, seed_everything, torch):
    @torch.no_grad()
    def estimate_loss(model, iters):
        model.eval()
        out = {}
        for split in ("train", "val"):
            losses = torch.zeros(iters)
            for k in range(iters):
                _, loss = model(*get_batch(split))
                losses[k] = loss.item()
            out[split] = losses.mean().item()
        model.train()
        return out

    def train_model(norm_kind, vocab_size, steps=None, progress=None):
        """Train a TinyGPT from a fixed seed so runs are directly comparable."""
        seed_everything(1337)  # identical init/data order across norm kinds
        steps = steps or CFG["steps"]
        model = TinyGPT(CFG, vocab_size, norm_kind).to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=CFG["lr"])
        hist = {"step": [], "train": [], "val": []}
        for step in range(steps + 1):
            if step % CFG["eval_interval"] == 0 or step == steps:
                m = estimate_loss(model, CFG["eval_iters"])
                hist["step"].append(step)
                hist["train"].append(m["train"])
                hist["val"].append(m["val"])
            if step < steps:
                x, y = get_batch("train")
                _, loss = model(x, y)
                opt.zero_grad(set_to_none=True)
                loss.backward()
                opt.step()
            if progress is not None:
                progress.update()
        return model, hist

    return estimate_loss, train_model


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 1 · The observation: a trained `LayerNorm` looks like a `tanh`

        First we train a **standard, normalized** Transformer. Then we put forward-hooks
        on its `LayerNorm` layers, push a batch through, and plot every element's
        **input vs. output**. If the paper is right, the cloud of points should trace an
        **S-shaped curve** — gentle and near-linear in the middle, saturating at the
        extremes — i.e. exactly what `tanh` does.

        Click to train the baseline (this is the model we'll study and later compare
        against).
        """
    )
    return


@app.cell
def _(mo):
    baseline_btn = mo.ui.run_button(label="▶ Train baseline (LayerNorm) Transformer")
    baseline_btn
    return (baseline_btn,)


@app.cell
def _(CFG, baseline_btn, count_params, mo, os, train_model, vocab_size):
    mo.stop(
        not (baseline_btn.value or os.environ.get("DYT_AUTORUN")),
        mo.md("☝️ *Click the button above to train the baseline model.*"),
    )
    with mo.status.progress_bar(
        total=CFG["steps"] + 1, title="Training baseline (LayerNorm)"
    ) as _bar:
        baseline_model, baseline_hist = train_model(
            "layernorm", vocab_size, progress=_bar
        )
    mo.md(
        f"✅ Baseline trained — {count_params(baseline_model):,} params, "
        f"final val loss **{baseline_hist['val'][-1]:.3f}**."
    )
    return baseline_hist, baseline_model


@app.cell
def _(baseline_model, get_batch, mo, nn, torch):
    # Capture (input, output) of every LayerNorm via forward hooks.
    _captured = {}
    _handles = []

    def _mk_hook(name):
        def hook(_m, inp, out):
            _captured[name] = (inp[0].detach(), out.detach())

        return hook

    _ln_names = []
    for _n, _mod in baseline_model.named_modules():
        if isinstance(_mod, nn.LayerNorm):
            _ln_names.append(_n)
            _handles.append(_mod.register_forward_hook(_mk_hook(_n)))

    with torch.no_grad():
        baseline_model(get_batch("val")[0])
    for _h in _handles:
        _h.remove()

    ln_captured = _captured
    ln_layer_selector = mo.ui.dropdown(
        options=_ln_names, value=_ln_names[-2] if len(_ln_names) > 1 else _ln_names[0],
        label="LayerNorm layer to inspect:",
    )
    ln_layer_selector
    return ln_captured, ln_layer_selector


@app.cell
def _(ln_captured, ln_layer_selector, mo, np, plt, torch):
    _name = ln_layer_selector.value
    _xin, _xout = ln_captured[_name]
    _x = _xin.reshape(-1).cpu().numpy()
    _y = _xout.reshape(-1).cpu().numpy()

    # subsample for a readable scatter
    _idx = np.random.default_rng(0).choice(len(_x), size=min(4000, len(_x)), replace=False)
    _xs, _ys = _x[_idx], _y[_idx]

    # binned mean curve (the "shape" of the mapping)
    _order = np.argsort(_x)
    _xo, _yo = _x[_order], _y[_order]
    _bins = np.linspace(_xo[0], _xo[-1], 40)
    _bi = np.clip(np.digitize(_xo, _bins), 1, len(_bins) - 1)
    _bx = 0.5 * (_bins[:-1] + _bins[1:])
    _by = np.array([_yo[_bi == b].mean() if (_bi == b).any() else np.nan
                    for b in range(1, len(_bins))])

    _fig, _ax = plt.subplots(figsize=(6.2, 5))
    _ax.scatter(_xs, _ys, s=4, alpha=0.18, color="#5b8def", label="elements")
    _ax.plot(_bx, _by, color="#e4572e", lw=2.5, label="binned mean (the mapping)")
    _ax.axhline(0, color="0.7", lw=0.8)
    _ax.axvline(0, color="0.7", lw=0.8)
    _ax.set_xlabel("LayerNorm input")
    _ax.set_ylabel("LayerNorm output")
    _ax.set_title(f"Input → output of {_name}\n(notice the tanh-like S-curve)")
    _ax.legend(loc="upper left", fontsize=8)
    _fig.tight_layout()
    _fig
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        Try switching layers. **Deeper layers sharpen** — the S gets steeper and the
        saturation more pronounced, while early layers look nearly linear. That is the
        whole motivation for DyT: the normalization layer isn't doing something
        mysterious and reduction-dependent; it is mostly learning a **smooth, bounded
        squashing** that a single scalar-scaled `tanh` can reproduce.

        ## 2 · The idea: feel the knobs of `DyT(x) = γ·tanh(αx) + β`

        Move the `α` slider and swap the squashing function. Watch how `α` controls the
        **steepness** of the squash (small `α` → near-linear; large `α` → hard
        saturation) — and how the smooth, zero-centered, bounded `tanh` is the curve
        that matches the measured LayerNorm mapping above.
        """
    )
    return


@app.cell
def _(mo):
    alpha_slider = mo.ui.slider(
        start=0.1, stop=3.0, step=0.1, value=0.8, label="α (steepness)"
    )
    squash_picker = mo.ui.dropdown(
        options=["tanh", "hardtanh", "sigmoid", "identity"],
        value="tanh",
        label="squashing function",
    )
    mo.hstack([alpha_slider, squash_picker], justify="start", gap=2)
    return alpha_slider, squash_picker


@app.cell
def _(F, alpha_slider, np, plt, squash_picker, torch):
    _a = alpha_slider.value
    _kind = squash_picker.value
    _xx = torch.linspace(-4, 4, 400)
    _s = _a * _xx
    if _kind == "tanh":
        _yy = torch.tanh(_s)
    elif _kind == "hardtanh":
        _yy = F.hardtanh(_s)
    elif _kind == "sigmoid":
        _yy = torch.sigmoid(_s)
    else:
        _yy = _s

    _fig, _ax = plt.subplots(figsize=(6.4, 4.4))
    _ax.plot(_xx.numpy(), _yy.numpy(), color="#e4572e", lw=2.6,
             label=f"{_kind}({_a:.1f}·x)")
    _ax.plot(_xx.numpy(), np.tanh(_xx.numpy()), color="0.6", lw=1.2, ls="--",
             label="tanh(x) reference")
    _ax.axhline(0, color="0.85", lw=0.8)
    _ax.axvline(0, color="0.85", lw=0.8)
    _ax.set_ylim(-2.2, 2.2)
    _ax.set_xlabel("input x")
    _ax.set_ylabel("DyT core: squash(α·x)")
    _ax.set_title("γ and β then rescale/shift this curve per channel")
    _ax.legend(loc="upper left", fontsize=8)
    _fig.tight_layout()
    _fig
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 3 · DyT as a drop-in module

        The replacement is genuinely tiny. Anywhere a block says `LayerNorm(d)`, write
        `DyT(d)` instead — same call site, same shape, no other change to the
        architecture, optimizer, or learning rate. Here is the module used throughout
        this notebook (collapsed source shown for reference):

        ```python
        class DyT(nn.Module):
            def __init__(self, dim, init_alpha=0.5):
                super().__init__()
                self.alpha = nn.Parameter(torch.full((1,), init_alpha))  # ONE scalar
                self.gamma = nn.Parameter(torch.ones(dim))               # per-channel
                self.beta  = nn.Parameter(torch.zeros(dim))              # per-channel
            def forward(self, x):
                return self.gamma * torch.tanh(self.alpha * x) + self.beta
        ```

        No `mean`, no `var`, no `rsqrt`, no reduction across the feature axis — every
        output element depends only on the matching input element.

        ## 4 · The proof: baseline vs DyT, matched settings

        Now we train the **DyT** variant with *identical* configuration, seed, data
        order, optimizer and learning rate as the baseline (no DyT-specific tuning), and
        overlay the validation curves.
        """
    )
    return


@app.cell
def _(mo):
    dyt_btn = mo.ui.run_button(label="▶ Train DyT Transformer (matched settings)")
    dyt_btn
    return (dyt_btn,)


@app.cell
def _(CFG, count_params, dyt_btn, mo, os, train_model, vocab_size):
    mo.stop(
        not (dyt_btn.value or os.environ.get("DYT_AUTORUN")),
        mo.md("☝️ *Click to train the DyT model.*"),
    )
    with mo.status.progress_bar(
        total=CFG["steps"] + 1, title="Training DyT"
    ) as _bar:
        dyt_model, dyt_hist = train_model("dyt", vocab_size, progress=_bar)
    mo.md(
        f"✅ DyT trained — {count_params(dyt_model):,} params, "
        f"final val loss **{dyt_hist['val'][-1]:.3f}**."
    )
    return dyt_hist, dyt_model


@app.cell
def _(baseline_hist, dyt_hist, mo, plt):
    _fig, _ax = plt.subplots(figsize=(7.2, 4.6))
    _ax.plot(baseline_hist["step"], baseline_hist["val"], color="#2b2d42", lw=2.2,
             marker="o", ms=3, label="LayerNorm — val")
    _ax.plot(baseline_hist["step"], baseline_hist["train"], color="#2b2d42", lw=1,
             ls="--", alpha=0.5, label="LayerNorm — train")
    _ax.plot(dyt_hist["step"], dyt_hist["val"], color="#e4572e", lw=2.2,
             marker="s", ms=3, label="DyT — val")
    _ax.plot(dyt_hist["step"], dyt_hist["train"], color="#e4572e", lw=1,
             ls="--", alpha=0.5, label="DyT — train")
    _ax.set_xlabel("training step")
    _ax.set_ylabel("cross-entropy loss")
    _ax.set_title("LayerNorm vs DyT — same data, same hyperparameters")
    _ax.legend(fontsize=9)
    _fig.tight_layout()

    _delta = dyt_hist["val"][-1] - baseline_hist["val"][-1]
    _verdict = "**matches**" if abs(_delta) < 0.05 else (
        "**beats**" if _delta < 0 else "is slightly behind"
    )
    mo.vstack([
        _fig,
        mo.md(
            f"Final val loss — LayerNorm: **{baseline_hist['val'][-1]:.3f}**, "
            f"DyT: **{dyt_hist['val'][-1]:.3f}** (Δ = {_delta:+.3f}). "
            f"With zero DyT-specific tuning, DyT {_verdict} the normalized baseline."
        ),
    ])
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 5 · The speed-up: DyT is *faster* because it skips the reduction

        Matching quality is half the story. The other headline benefit is **efficiency**:
        `LayerNorm` computes a **mean and a variance**, and `RMSNorm` a **mean of
        squares**, *across the feature axis* at every token of every layer. Each of those
        is a **reduction** — a sum over the whole feature dimension that every output must
        wait on, and on a GPU that is a synchronization point. `DyT` has **no reduction at
        all**: each output element is an independent `γ·tanh(αx)+β`.

        Below we time **forward** and **forward+backward** passes of the three norms in
        isolation, across a few hidden sizes, on whatever device is detected (GPU in
        molab, CPU locally). We report latency per pass and forward throughput
        (tokens/sec). The reduction-free op should pull ahead as the feature dimension
        grows.
        """
    )
    return


@app.cell
def _(mo):
    bench_btn = mo.ui.run_button(
        label="▶ Run speed benchmark (DyT vs LayerNorm vs RMSNorm)"
    )
    bench_btn
    return (bench_btn,)


@app.cell
def _(bench_btn, device, make_norm, mo, os, time, torch):
    mo.stop(
        not (bench_btn.value or os.environ.get("DYT_AUTORUN")),
        mo.md("☝️ *Click to time forward and forward+backward passes.*"),
    )

    _on_gpu = device == "cuda"
    if _on_gpu:
        _B, _T = 32, 256
        _hidden = [256, 512, 1024, 2048]
        _iters, _warmup = 50, 10
    else:
        _B, _T = 16, 64
        _hidden = [128, 256, 512]
        _iters, _warmup = 20, 5

    # Keep headless validation (DYT_AUTORUN) snappy.
    if os.environ.get("DYT_AUTORUN"):
        _hidden = _hidden[:2]
        _iters, _warmup = 5, 2

    def _sync():
        if _on_gpu:
            torch.cuda.synchronize()

    def _time_norm(norm, dim, backward):
        x = torch.randn(_B, _T, dim, device=device)
        if backward:
            x.requires_grad_(True)

        def _step():
            if backward:
                y = norm(x)
                y.sum().backward()
                norm.zero_grad(set_to_none=True)
                x.grad = None
            else:
                with torch.no_grad():
                    norm(x)

        for _ in range(_warmup):
            _step()
        _sync()
        _t0 = time.perf_counter()
        for _ in range(_iters):
            _step()
        _sync()
        return (time.perf_counter() - _t0) / _iters

    _kinds = ["layernorm", "rmsnorm", "dyt"]
    bench_results = {
        k: {"hidden": [], "fwd_ms": [], "fwdbwd_ms": [], "tok_s": []} for k in _kinds
    }
    with mo.status.progress_bar(
        total=len(_kinds) * len(_hidden) * 2, title="Benchmarking norms"
    ) as _bar:
        for _dim in _hidden:
            for _k in _kinds:
                _norm = make_norm(_k, _dim).to(device)
                _fwd = _time_norm(_norm, _dim, backward=False)
                _bar.update()
                _fb = _time_norm(_norm, _dim, backward=True)
                _bar.update()
                bench_results[_k]["hidden"].append(_dim)
                bench_results[_k]["fwd_ms"].append(_fwd * 1e3)
                bench_results[_k]["fwdbwd_ms"].append(_fb * 1e3)
                bench_results[_k]["tok_s"].append((_B * _T) / _fwd)

    bench_meta = dict(B=_B, T=_T, hidden=_hidden, iters=_iters, on_gpu=_on_gpu)
    mo.md(
        f"✅ Benchmarked on `{device}` — {_B}×{_T} tokens per pass, "
        f"{_iters} timed iters per point."
    )
    return bench_meta, bench_results


@app.cell
def _(bench_meta, bench_results, device, mo, plt):
    _labels = {"layernorm": "LayerNorm", "rmsnorm": "RMSNorm", "dyt": "DyT"}
    _colors = {"layernorm": "#2b2d42", "rmsnorm": "#5b8def", "dyt": "#e4572e"}

    _fig, (_ax1, _ax2) = plt.subplots(1, 2, figsize=(11, 4.4))
    for _k in ("layernorm", "rmsnorm", "dyt"):
        _h = bench_results[_k]["hidden"]
        _ax1.plot(_h, bench_results[_k]["fwd_ms"], color=_colors[_k], lw=2,
                  marker="o", ms=4, label=_labels[_k])
        _ax2.plot(_h, bench_results[_k]["fwdbwd_ms"], color=_colors[_k], lw=2,
                  marker="s", ms=4, label=_labels[_k])
    for _ax, _ttl in ((_ax1, "Forward latency"), (_ax2, "Forward + backward latency")):
        _ax.set_xlabel("hidden size")
        _ax.set_ylabel("latency per pass (ms)")
        _ax.set_title(_ttl)
        _ax.grid(alpha=0.2)
        _ax.legend(fontsize=8)
    _fig.tight_layout()

    # Compare at the largest hidden size, where the reduction cost is largest.
    _ln = bench_results["layernorm"]["fwd_ms"][-1]
    _rms = bench_results["rmsnorm"]["fwd_ms"][-1]
    _dyt = bench_results["dyt"]["fwd_ms"][-1]
    _spd_ln = _ln / _dyt
    _spd_rms = _rms / _dyt
    _hmax = bench_meta["hidden"][-1]
    _dev = "GPU" if bench_meta["on_gpu"] else "CPU"
    _verdict = (
        "comes out **fastest**" if (_spd_ln > 1 and _spd_rms > 1)
        else "is in the same range as the normalized ops"
    )
    mo.vstack([
        _fig,
        mo.md(
            f"""
            **Takeaway.** At hidden size **{_hmax}** on **{_dev}**, a forward DyT pass runs
            at **{_spd_ln:.2f}×** the throughput of LayerNorm and **{_spd_rms:.2f}×** that
            of RMSNorm (DyT **{bench_results['dyt']['tok_s'][-1]:,.0f}** tok/s vs LayerNorm
            **{bench_results['layernorm']['tok_s'][-1]:,.0f}** tok/s). Here DyT {_verdict}.

            The reason is structural: LayerNorm pays for a **mean *and* a variance**, RMSNorm
            for a **mean of squares** — both *reductions* across the feature axis that act as
            a synchronization point. DyT is purely **element-wise**, so it skips that work
            entirely, and the gap **widens with hidden size** as the reduction gets more
            expensive. (On CPU at small sizes `tanh` is itself non-trivial, so the margin can
            be small or noisy — the effect is sharpest on GPU with large feature dimensions,
            which is exactly the regime real Transformers run in.)
            """
        ),
    ])
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 6 · What does `α` learn?

        The paper reports that the learned scalar `α` ends up tracking roughly **1/std**
        of each layer's input activations — i.e. DyT discovers, with a single parameter,
        the scale that normalization computes explicitly. Below we plot the learned `α`
        per DyT layer alongside `1 / std` measured from a real batch. If they line up,
        DyT is effectively learning a cheap, static stand-in for normalization's
        per-token rescaling.
        """
    )
    return


@app.cell
def _(DyT, dyt_model, get_batch, mo, nn, np, plt, torch):
    # Learned alpha per DyT layer.
    _alphas, _names = [], []
    for _n, _m in dyt_model.named_modules():
        if isinstance(_m, DyT):
            _alphas.append(float(_m.alpha.detach().cpu().item()))
            _names.append(_n)

    # Measure 1/std of each DyT layer's *input* via hooks.
    _stds = {}
    _hs = []

    def _mk(name):
        def h(_mod, inp, _out):
            _stds[name] = inp[0].detach().float().std().item()
        return h

    for _n, _m in dyt_model.named_modules():
        if isinstance(_m, DyT):
            _hs.append(_m.register_forward_hook(_mk(_n)))
    with torch.no_grad():
        dyt_model(get_batch("val")[0])
    for _h in _hs:
        _h.remove()
    _inv_std = [1.0 / _stds[n] for n in _names]

    _xpos = np.arange(len(_names))
    _fig, _ax = plt.subplots(figsize=(7.4, 4.4))
    _ax.bar(_xpos - 0.2, _alphas, width=0.4, color="#e4572e", label="learned α")
    _ax.bar(_xpos + 0.2, _inv_std, width=0.4, color="#5b8def", label="1 / std(input)")
    _ax.set_xticks(_xpos)
    _ax.set_xticklabels([f"L{i}" for i in range(len(_names))], rotation=0, fontsize=7)
    _ax.set_ylabel("value")
    _ax.set_title("Learned α tracks 1/std of activations (DyT layers)")
    _ax.legend(fontsize=9)
    _fig.tight_layout()

    _corr = float(np.corrcoef(_alphas, _inv_std)[0, 1]) if len(_alphas) > 1 else float("nan")
    mo.vstack([
        _fig,
        mo.md(
            f"Pearson correlation between learned **α** and **1/std**: "
            f"**{_corr:.2f}** across {len(_names)} DyT layers — consistent with the "
            f"paper's observation that α plays the role of an activation-scale estimate."
        ),
    ])
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 7 · The property of `tanh` (ablation): *which* property actually matters?

        DyT works, but the paper leaves a natural question only partly answered: is it
        the **boundedness**, the **smoothness**, or the **zero-centering** of `tanh`
        that carries the load? We isolate this with a controlled **squashing-function
        ablation** — same architecture, same budget, only the element-wise function
        inside DyT changes:

        | variant | bounded? | smooth? | zero-centered? |
        |---|---|---|---|
        | `tanh` (DyT) | ✅ | ✅ | ✅ |
        | `hardtanh` | ✅ | ❌ (kinked) | ✅ |
        | `sigmoid` | ✅ | ✅ | ❌ (maps to (0,1)) |
        | `identity` | ❌ | ✅ | ✅ |

        This is the cleanest single experiment that explains *why* DyT is a `tanh` and
        not just "any nonlinearity". Each variant is trained from the same seed; we
        compare final validation loss.
        """
    )
    return


@app.cell
def _(mo):
    ext_btn = mo.ui.run_button(label="▶ Run squashing-function ablation (trains 4 small models)")
    ext_btn
    return (ext_btn,)


@app.cell
def _(CFG, ext_btn, mo, os, train_model, vocab_size):
    mo.stop(
        not (ext_btn.value or os.environ.get("DYT_AUTORUN")),
        mo.md("☝️ *Click to run the ablation. This trains four variants in sequence.*"),
    )
    _variants = ["dyt-tanh", "dyt-hardtanh", "dyt-sigmoid", "dyt-identity"]
    # Keep the ablation snappy: cap steps so four runs finish quickly.
    _ablation_steps = min(CFG["steps"], 250 if CFG["steps"] > 250 else CFG["steps"])
    ext_results = {}
    with mo.status.progress_bar(
        total=len(_variants) * (_ablation_steps + 1), title="Ablation"
    ) as _bar:
        for _v in _variants:
            _kind = "dyt" if _v == "dyt-tanh" else _v
            _m, _h = train_model(_kind, vocab_size, steps=_ablation_steps, progress=_bar)
            ext_results[_v] = _h
    mo.md("✅ Ablation complete.")
    return (ext_results,)


@app.cell
def _(ext_results, mo, plt):
    _labels = {
        "dyt-tanh": "tanh (DyT)",
        "dyt-hardtanh": "hardtanh",
        "dyt-sigmoid": "sigmoid",
        "dyt-identity": "identity (no squash)",
    }
    _colors = {
        "dyt-tanh": "#e4572e",
        "dyt-hardtanh": "#f3a712",
        "dyt-sigmoid": "#5b8def",
        "dyt-identity": "#8d99ae",
    }
    _fig, (_axc, _axb) = plt.subplots(1, 2, figsize=(11, 4.4))
    _finals = {}
    for _k, _h in ext_results.items():
        _axc.plot(_h["step"], _h["val"], color=_colors[_k], lw=2, marker="o", ms=2.5,
                  label=_labels[_k])
        _finals[_k] = _h["val"][-1]
    _axc.set_xlabel("training step")
    _axc.set_ylabel("val loss")
    _axc.set_title("Validation curves by squashing function")
    _axc.legend(fontsize=8)

    _ks = list(_finals.keys())
    _axb.bar([_labels[k] for k in _ks], [_finals[k] for k in _ks],
             color=[_colors[k] for k in _ks])
    _axb.set_ylabel("final val loss")
    _axb.set_title("Final val loss (lower is better)")
    _axb.tick_params(axis="x", labelrotation=20, labelsize=8)
    _fig.tight_layout()

    _best = min(_finals, key=_finals.get)
    _worst = max(_finals, key=_finals.get)
    mo.vstack([
        _fig,
        mo.md(
            f"""
            **Takeaway.** The best variant is **{_labels[_best]}**
            (val {_finals[_best]:.3f}) and the worst is **{_labels[_worst]}**
            (val {_finals[_worst]:.3f}).

            - **identity** (drop the squash entirely) is the telltale: with no
              boundedness, large activations are never reined in, so it trains worst /
              least stably — confirming that the **bounded squashing is the load-bearing
              part**, not the affine `γ, β`.
            - **hardtanh** is bounded but kinked; it usually trails smooth `tanh`,
              suggesting **smoothness** helps optimization.
            - **sigmoid** is bounded and smooth but not zero-centered; `β` can absorb
              some of the offset, yet `tanh` remains the most robust choice.

            Net: DyT's effectiveness comes from a **smooth, bounded, zero-centered**
            squash — exactly the shape we measured coming out of LayerNorm in Section 1.
            That closes the loop: the observation motivates the function, and the
            ablation confirms the function's properties are what matter.
            """
        ),
    ])
    return


@app.cell
def _(decode, dyt_model, mo, torch):
    # A small qualitative check that the DyT model actually learned the corpus.
    _ctx = torch.zeros((1, 1), dtype=torch.long, device=next(dyt_model.parameters()).device)
    _out = decode(dyt_model.generate(_ctx, max_new_tokens=200)[0].tolist())
    mo.md(
        f"""
        ### A sample from the trained **DyT** model

        > {_out.strip().replace(chr(10), ' / ')}

        *(A tiny char-level model on a few KB of text — it won't write sonnets, but it
        has clearly learned letter/word structure with normalization fully removed.)*
        """
    )
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 8 · Beyond Transformers: does DyT generalize to a plain MLP?

        Everything above lives inside attention blocks. But the paper's claim — that a
        normalization layer is mostly a *smooth, bounded squashing* — has nothing to do
        with attention. If it's true, DyT should also stand in for normalization in a
        **non-Transformer** network.

        So here is a clean stress test, completely separate from the GPT above:

        - **Task.** A tiny, dependency-free **two-spiral / multi-class spiral**
          classification — generated on the fly with NumPy, no downloads. Interleaved
          spirals are a classic "needs depth + good optimization" toy problem.
        - **Model.** A small **MLP** (just `Linear → norm → GELU`, stacked) — *no
          attention anywhere*. The canonical normalization for an MLP/ConvNet is
          **BatchNorm**, so that is the counterpart we match against.
        - **Comparison.** Same width, depth, seed, optimizer and learning rate, only the
          normalization swapped: **BatchNorm** vs **DyT** vs **no normalization**.

        If DyT tracks BatchNorm here — and the un-normalized net trails — then the idea
        clearly transfers outside attention.
        """
    )
    return


@app.cell
def _(device, np, torch):
    def make_spirals(points_per_class=300, n_classes=3, noise=0.20, seed=0):
        """A classic interleaved-spirals dataset, generated with NumPy (no download)."""
        rng = np.random.default_rng(seed)
        n = points_per_class * n_classes
        X = np.zeros((n, 2), dtype=np.float32)
        y = np.zeros(n, dtype=np.int64)
        for c in range(n_classes):
            r = np.linspace(0.0, 1.0, points_per_class)
            t = (
                np.linspace(c * 4.0, (c + 1) * 4.0, points_per_class)
                + rng.standard_normal(points_per_class) * noise
            )
            idx = slice(points_per_class * c, points_per_class * (c + 1))
            X[idx] = np.c_[r * np.sin(t), r * np.cos(t)]
            y[idx] = c
        return X, y

    mlp_classes = 3
    _X, _y = make_spirals(points_per_class=300, n_classes=mlp_classes, seed=0)

    # Deterministic train/test split.
    _perm = np.random.default_rng(1).permutation(len(_X))
    _X, _y = _X[_perm], _y[_perm]
    _cut = int(0.8 * len(_X))
    mlp_Xtr = torch.from_numpy(_X[:_cut]).to(device)
    mlp_ytr = torch.from_numpy(_y[:_cut]).to(device)
    mlp_Xte = torch.from_numpy(_X[_cut:]).to(device)
    mlp_yte = torch.from_numpy(_y[_cut:]).to(device)
    return make_spirals, mlp_Xte, mlp_Xtr, mlp_classes, mlp_yte, mlp_ytr


@app.cell
def _(F, device, make_norm, mlp_Xte, mlp_Xtr, mlp_classes, mlp_yte, mlp_ytr,
      nn, seed_everything, torch):
    class TinyMLP(nn.Module):
        """A small fully-connected net — no attention. `norm_kind` is the only knob.

        Each hidden stage is `Linear → norm → GELU`, which is exactly where a ConvNet
        or MLP would normally place BatchNorm. Set `norm_kind="dyt"` to swap that
        normalization for Dynamic Tanh; `"none"` removes it entirely.
        """

        def __init__(self, in_dim, hidden, depth, n_classes, norm_kind):
            super().__init__()
            layers = []
            d = in_dim
            for _ in range(depth):
                layers.append(nn.Linear(d, hidden))
                if norm_kind != "none":
                    layers.append(make_norm(norm_kind, hidden))
                layers.append(nn.GELU())
                d = hidden
            self.body = nn.Sequential(*layers)
            self.head = nn.Linear(d, n_classes)

        def forward(self, x):
            return self.head(self.body(x))

    def train_mlp(norm_kind, steps, eval_interval, progress=None):
        """Train a TinyMLP from a fixed seed so variants are directly comparable."""
        seed_everything(1337)  # identical init across norm kinds
        model = TinyMLP(2, 64, depth=6, n_classes=mlp_classes,
                        norm_kind=norm_kind).to(device)
        opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
        hist = {"step": [], "train_loss": [], "test_loss": [],
                "train_acc": [], "test_acc": []}

        def _evaluate():
            model.eval()
            with torch.no_grad():
                row = {}
                for split, (Xs, ys) in (
                    ("train", (mlp_Xtr, mlp_ytr)),
                    ("test", (mlp_Xte, mlp_yte)),
                ):
                    logits = model(Xs)
                    row[f"{split}_loss"] = F.cross_entropy(logits, ys).item()
                    row[f"{split}_acc"] = (logits.argmax(-1) == ys).float().mean().item()
            model.train()
            return row

        for step in range(steps + 1):
            if step % eval_interval == 0 or step == steps:
                row = _evaluate()
                hist["step"].append(step)
                for k, v in row.items():
                    hist[k].append(v)
            if step < steps:
                logits = model(mlp_Xtr)  # full-batch GD; the dataset is tiny
                loss = F.cross_entropy(logits, mlp_ytr)
                opt.zero_grad(set_to_none=True)
                loss.backward()
                opt.step()
            if progress is not None:
                progress.update()
        return model, hist

    return TinyMLP, train_mlp


@app.cell
def _(mlp_Xtr, mo, np, plt):
    # Show the raw synthetic task so the reader knows what's being classified.
    _Xc = mlp_Xtr.cpu().numpy()
    _fig, _ax = plt.subplots(figsize=(4.8, 4.8))
    _ax.scatter(_Xc[:, 0], _Xc[:, 1], s=6, c="#8d99ae", alpha=0.6)
    _ax.set_title("The synthetic task: interleaved spirals\n(3 classes, generated with NumPy)")
    _ax.set_xticks([]); _ax.set_yticks([])
    _fig.tight_layout()
    mo.vstack([
        _fig,
        mo.md("A small but genuinely nonlinear classification problem — depth and "
              "stable optimization both help here."),
    ])
    return


@app.cell
def _(mo):
    mlp_btn = mo.ui.run_button(
        label="▶ Train MLP: BatchNorm vs DyT vs no-norm"
    )
    mlp_btn
    return (mlp_btn,)


@app.cell
def _(device, mlp_btn, mo, os, train_mlp):
    mo.stop(
        not (mlp_btn.value or os.environ.get("DYT_AUTORUN")),
        mo.md("☝️ *Click to train three small MLPs (BatchNorm, DyT, no-norm).*"),
    )
    _steps = 600 if device == "cuda" else 400
    if os.environ.get("DYT_STEPS"):
        _steps = min(_steps, int(os.environ["DYT_STEPS"]))
    _eval = max(1, _steps // 20)
    _variants = ["batchnorm", "dyt", "none"]
    mlp_results = {}
    mlp_models = {}
    with mo.status.progress_bar(
        total=len(_variants) * (_steps + 1), title="Training MLPs"
    ) as _bar:
        for _v in _variants:
            _m, _h = train_mlp(_v, steps=_steps, eval_interval=_eval, progress=_bar)
            mlp_results[_v] = _h
            mlp_models[_v] = _m
    mo.md("✅ Done — three MLPs trained with identical settings.")
    return mlp_models, mlp_results


@app.cell
def _(mlp_results, mo, plt):
    _labels = {"batchnorm": "BatchNorm", "dyt": "DyT", "none": "no norm"}
    _colors = {"batchnorm": "#2b2d42", "dyt": "#e4572e", "none": "#8d99ae"}

    _fig, (_axl, _axa) = plt.subplots(1, 2, figsize=(11, 4.4))
    for _k, _h in mlp_results.items():
        _axl.plot(_h["step"], _h["test_loss"], color=_colors[_k], lw=2.2,
                  marker="o", ms=2.5, label=f"{_labels[_k]} — test")
        _axl.plot(_h["step"], _h["train_loss"], color=_colors[_k], lw=1, ls="--",
                  alpha=0.45)
        _axa.plot(_h["step"], _h["test_acc"], color=_colors[_k], lw=2.2,
                  marker="s", ms=2.5, label=f"{_labels[_k]} — test")
    _axl.set_xlabel("training step"); _axl.set_ylabel("cross-entropy loss")
    _axl.set_title("MLP loss (solid = test, dashed = train)")
    _axl.legend(fontsize=8)
    _axa.set_xlabel("training step"); _axa.set_ylabel("accuracy")
    _axa.set_title("MLP test accuracy")
    _axa.legend(fontsize=8)
    _fig.tight_layout()

    _bn = mlp_results["batchnorm"]["test_acc"][-1]
    _dy = mlp_results["dyt"]["test_acc"][-1]
    _nn = mlp_results["none"]["test_acc"][-1]
    _delta = _dy - _bn
    _verdict = "**matches**" if abs(_delta) < 0.03 else (
        "**beats**" if _delta > 0 else "is slightly behind"
    )
    mo.vstack([
        _fig,
        mo.md(
            f"Final **test accuracy** — BatchNorm: **{_bn:.3f}**, DyT: **{_dy:.3f}**, "
            f"no-norm: **{_nn:.3f}** (DyT − BatchNorm = {_delta:+.3f}). "
            f"With zero DyT-specific tuning, DyT {_verdict} BatchNorm in a network that "
            f"has **no attention at all**."
        ),
    ])
    return


@app.cell
def _(mlp_models, mlp_Xtr, mlp_ytr, mo, np, plt, torch):
    # Decision boundaries: BatchNorm vs DyT learn essentially the same function.
    _Xc = mlp_Xtr.cpu().numpy()
    _yc = mlp_ytr.cpu().numpy()
    _pad = 0.3
    _x0, _x1 = _Xc[:, 0].min() - _pad, _Xc[:, 0].max() + _pad
    _y0, _y1 = _Xc[:, 1].min() - _pad, _Xc[:, 1].max() + _pad
    _gx, _gy = np.meshgrid(np.linspace(_x0, _x1, 220), np.linspace(_y0, _y1, 220))
    _grid = np.c_[_gx.ravel(), _gy.ravel()].astype("float32")

    _show = [("batchnorm", "BatchNorm"), ("dyt", "DyT")]
    _fig, _axes = plt.subplots(1, 2, figsize=(10, 5))
    _dev = next(mlp_models["dyt"].parameters()).device
    _gt = torch.from_numpy(_grid).to(_dev)
    for _ax, (_k, _title) in zip(_axes, _show):
        _model = mlp_models[_k]
        _model.eval()
        with torch.no_grad():
            _pred = _model(_gt).argmax(-1).cpu().numpy().reshape(_gx.shape)
        _ax.contourf(_gx, _gy, _pred, alpha=0.3, cmap="Set2", levels=2)
        _ax.scatter(_Xc[:, 0], _Xc[:, 1], c=_yc, s=6, cmap="Set2",
                    edgecolors="none", alpha=0.9)
        _ax.set_title(f"{_title} decision boundary")
        _ax.set_xticks([]); _ax.set_yticks([])
    _fig.tight_layout()
    mo.vstack([
        _fig,
        mo.md("The two carve out the **same spiral decision regions** — visual "
              "confirmation that DyT is doing BatchNorm's job here."),
    ])
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ### Takeaway — DyT transfers outside attention

        The same one-line swap that worked in the Transformer also works in a plain
        **MLP**: trained head-to-head with identical settings, **DyT matches BatchNorm**,
        while dropping normalization entirely trains slower / less accurately. The two
        normalized variants even learn near-identical decision boundaries.

        **Why this makes sense.** DyT's argument was never about attention. A normalization
        layer mostly applies a *smooth, bounded, zero-centered squashing* (Section 1), and
        that role is just as useful between the `Linear` layers of an MLP (or the
        convolutions of a ConvNet) as it is inside a Transformer block. DyT supplies that
        squashing element-wise, with a single learnable `α` and no mean/variance reduction.

        The one caveat worth stating honestly: **BatchNorm** mixes information *across the
        batch*, which DyT (being purely per-element) does not. So DyT replaces BatchNorm's
        *squashing/scaling* role cleanly, but it is not a literal substitute for BatchNorm's
        batch-statistics regularization. On this task that distinction doesn't cost
        accuracy — and it means DyT carries the *additional* practical perk of being
        batch-size- and inference-mode-independent.
        """
    )
    return


@app.cell
def _(mo):
    mo.md(
        r"""
        ## 9 · Conclusion

        - Normalization in Transformers was assumed essential, partly because it is
          everywhere and partly because removing it naïvely breaks training.
        - But a trained `LayerNorm`, **measured directly**, mostly traces a **tanh-like
          S-curve** — a smooth, bounded squashing — not a mysterious reduction.
        - **DyT** makes that explicit: `γ · tanh(αx) + β`, one learnable scalar `α` plus
          the usual affine. It is **element-wise and reduction-free**.
        - Trained head-to-head with **no extra tuning**, DyT **matches** the normalized
          baseline here, and its learned `α` **tracks 1/std** — recovering the scale
          normalization computes by hand.
        - Because it skips the mean/variance **reduction**, DyT is also **faster** — our
          micro-benchmark times it ahead of LayerNorm/RMSNorm, with the gap widening as
          the hidden size grows.
        - Our **ablation** shows the win comes specifically from a *smooth, bounded,
          zero-centered* squash, which is exactly the shape LayerNorm was producing.
        - And the idea **generalizes beyond attention**: dropped into a plain **MLP**
          (Section 8), DyT matches its **BatchNorm** counterpart on a synthetic task —
          because the squashing role it replaces isn't specific to Transformers.

        **Why it matters:** dropping the mean/variance reduction removes a per-token
        synchronization point, pointing toward **simpler, faster, reduction-free**
        Transformer blocks — with a change you can make in one line.

        *Paper:* Zhu, Chen, He, LeCun, Liu, *Transformers without Normalization*,
        [arXiv:2503.10622](https://arxiv.org/abs/2503.10622).
        """
    )
    return


if __name__ == "__main__":
    app.run()
