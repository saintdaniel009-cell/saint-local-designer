# Fine-tuning on your own work (later)
Do this once `dataset/approved/` has **100–200+** items, mostly harvested (hand-fixed) ones. Before that, few-shot examples do the job.

1. `./design export-training` → writes `dataset/train/train.jsonl` and `valid.jsonl`
2. Install Apple's MLX tools: `./.venv/bin/pip install mlx-lm`
3. LoRA fine-tune (check that your mlx-lm version supports Gemma 4 first; use the Hugging Face id of the size you run):
```
./.venv/bin/mlx_lm.lora --model google/gemma-4-E4B-it --train --data dataset/train \
  --batch-size 1 --num-layers 8 --iters 600 --max-seq-length 8192 --adapter-path adapters
```
4. Fuse and load into Ollama:
```
./.venv/bin/mlx_lm.fuse --model google/gemma-4-E4B-it --adapter-path adapters --save-path saint-gemma
# Modelfile:  FROM ./saint-gemma
ollama create saint-gemma -f Modelfile
```
5. Set `"model": "saint-gemma"` in config.json. Compare old vs new on the same 5 briefs before switching for good.

What this teaches: your layouts, spacing, naming and brand habits. What it doesn't: better reasoning. That still comes from a bigger base model, so keep your dataset. It's reusable on any future model.
