---
name: marimo notebook authoring & headless validation
description: How to write and validate marimo notebooks (e.g. competition deliverables) in this repo without a GPU.
---

# marimo notebooks

Standalone Python deliverables live under `deliverables/<name>/` (not pnpm artifacts). Install deps with the python package manager (`marimo`, `torch`, etc.); this container is CPU-only (`torch ...+cpu`, `cuda False`), so notebooks must auto-detect CUDA and ship a smaller CPU-fallback profile.

## Headless validation (no GPU, no browser)
- A marimo file ending in `if __name__ == "__main__": app.run()` **executes all cells top-to-bottom when run as a plain script** (`python notebook.py`). Use this to validate end-to-end.
- `python -m marimo check notebook.py` lints; markdown-indentation warnings on indented `r"""` blocks are cosmetic (exit 0), ignore them.

## Gating expensive compute (training) so the notebook opens instantly
- Wrap heavy cells with `mo.ui.run_button` + `mo.stop(not button.value, mo.md(...))`. `mo.stop` halts the cell and its descendants until clicked — clean reactive gate, no infinite re-run on the button's value reverting to False.
- For headless runs add an env escape hatch: `should = button.value or os.environ.get("DYT_AUTORUN")`. Pair with a steps override (`DYT_STEPS`) for fast smoke tests.

**Why:** lets you prove the whole pipeline (train + plots + generate) runs in CI/CLI even though the gated buttons are never clicked and there's no GPU.
