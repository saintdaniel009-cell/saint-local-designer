# Saint Local Designer — Runbook

Nov 16, 2026 · @Saint

## Before every session

The kit lives in `~/Documents/saint-local-designer`. Do these four things in this order:

1. Plug in the external drive with Gemma on it.
2. Open the Ollama app. It runs in the background; you never type into it.
3. Open your Figma file, then run Plugins → Development → Saint Local Designer. Keep its small window open.
4. Open Terminal and go to the kit: `cd ~/Documents/saint-local-designer`

To check everything is talking: `./design check`

## Designing

Run every command in Terminal, from the kit folder.

| Command | What it does |
| --- | --- |
| `./design "brief"` | Builds screens from a written brief |
| `./design "brief" --ref ~/Desktop/ref.png` | Adds a reference image (repeat `--ref` for more) |
| `./design "brief" --ref-selection` | Uses the frames selected in Figma as references |
| `./design "brief" --brand generic` | Uses a different brand file |
| `./design "brief" --no-review` | Skips the self-review pass (faster) |
| `./design "brief" --dry` | Prints the layout data only, nothing in Figma |

**Writing a brief that works**

- 2–4 screens per run, one flow at a time.
- Name each screen and list what's on it: "Home: balance card, 4 quick actions, recent transactions, tab bar".
- Say the order of the flow; it wires the buttons between screens.

**After the screens appear**, Terminal asks for feedback:

- Type a change ("tighter spacing, move balance up") and press Enter to revise.
- `ok` approves and saves it as training data.
- `keep` saves without approving; `q` discards.

## Training it every day

The model gets better at your style only from work you approve or fix. These habits matter more than any setting.

1. **Approve good results** with `ok`. Approved work is shown to the model as examples on every new run.
2. **Harvest your fixes.** Fix a result by hand in Figma, select the screens (or their section), then run `./design harvest`. Your corrected version becomes the best example. Do this often.
3. **Build components.** Put Button, Input, List row, Card and Tab bar components in the Figma file. The model uses them instead of drawing from scratch, which is the biggest quality jump.
4. **Add a brand** for each client: copy `brands/generic.md` and `brands/generic.tokens.json` to `brands/<client>.md` and `.tokens.json`, edit the colours, fonts and rules, then use `--brand <client>`.
5. **Add rules** you keep repeating in feedback to `rules/extra.md`. They're added to every prompt.
6. **Change the model** by editing `"model"` in `config.json` (check names with `ollama list`).

Every run is saved in `dataset/runs/`; approved and harvested work in `dataset/approved/`.

## Fine-tuning (later)

Fine-tune once `dataset/approved/` holds 100–200+ items, mostly harvested ones. Before that, the examples above already do the job. Fine-tuning teaches your layouts, spacing and brand habits; it doesn't make the model smarter.

1. Build the training set: `./design export-training`
2. Install Apple's MLX tools: `./.venv/bin/pip install mlx-lm` (check its release notes say it supports Gemma 4).
3. Train:

```
./.venv/bin/mlx_lm.lora --model google/gemma-4-E4B-it --train --data dataset/train \
  --batch-size 1 --num-layers 8 --iters 600 --max-seq-length 8192 --adapter-path adapters
```

4. Merge and load into Ollama:

```
./.venv/bin/mlx_lm.fuse --model google/gemma-4-E4B-it --adapter-path adapters --save-path saint-gemma
echo "FROM ./saint-gemma" > Modelfile
ollama create saint-gemma -f Modelfile
```

5. Set `"model": "saint-gemma"` in `config.json`. Run the same 5 briefs on the old and new model and compare before switching for good.

Full notes are in `TRAINING.md` in the kit.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Ollama isn't running" | Open the Ollama app, then run the command again |
| "Model not found" | Plug in the drive, quit and reopen Ollama. Still missing: run `ollama list` and copy the exact name into `config.json` |
| "Waiting for Figma" forever | Run the plugin in Figma (Plugins → Development → Saint Local Designer) |
| "Port 8765 is busy" | Another `./design` is still running: close that Terminal window or press Ctrl+C in it |
| Very slow or Mac freezes | Set `num_ctx` to 8192 in `config.json`, use `--no-review`, ask for fewer screens |
| "Could not produce a valid spec" | Shorten the brief, ask for 1–2 screens, or try a larger model |
| Text in Inter instead of Wix Madefor Display | Install Wix Madefor Display on the Mac and restart Figma |
| Grey "MISSING:" boxes | The component name doesn't exist in this file; add the component or rename it to match |
| `./design: permission denied` | Run `chmod +x design setup.sh` once |

## Backups and upgrades

Your dataset is the asset; models can be replaced, your approved work can't.

- **Back up monthly:** `dataset/`, `brands/`, `rules/` and `skills/` to a second drive or cloud folder.
- **Keep the model files:** the Gemma folder on your external drive. Also download one or two larger open models now, even if they don't run yet, in case access tightens later.
- **Upgrade path:** a Mac with 64–128 GB of memory runs 70B-class models, which get much closer to Claude-level design. Your dataset and rules carry over unchanged; only `"model"` in `config.json` changes.
