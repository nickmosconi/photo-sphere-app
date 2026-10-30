# Sphere Walk tools (PC)

`depth.py` estimates how far away every pixel of a 360° sphere is, using an AI depth model on
the PC's processor, and saves `<name>.<model>.depth.png` for Sphere Walk's viewer.
`make-test-room.mjs` saves the synthetic test room and its exact depth, to check the models.

Big and downloaded files are kept out of Git (see `.gitignore`): `.venv/`, `models/`, `vendor/`, `output/`.

## Setup (done once, Oct 29 2026)

1. Python 3.12 in `.venv/`, made with [uv](https://docs.astral.sh/uv/) (installed with the PC's Python 3.9: `py -3.9 -m pip install --user uv`):
   `uv venv --python 3.12 .venv`
2. PyTorch for the processor, plus helpers:
   `uv pip install --python .venv/Scripts/python.exe --index-url https://download.pytorch.org/whl/cpu torch==2.7.1 torchvision==0.22.1`
   `uv pip install --python .venv/Scripts/python.exe numpy pillow opencv-python-headless einops pyyaml huggingface_hub safetensors timm transformers==4.46.3 omegaconf`
3. Model code in `vendor/`:
   `git clone --depth 1 https://github.com/EnVision-Research/DA-2.git vendor/DA-2`
   `git clone --depth 1 https://github.com/Insta360-Research-Team/DAP.git vendor/DAP`
4. Model weights in `models/`:
   - `models/da2/model.safetensors` from https://huggingface.co/haodongli/DA-2 (1.4 GB)
   - `models/dap/model.pth` from https://huggingface.co/Insta360-Research/DAP-weights (1.5 GB)

| Model | Licence | Output |
|---|---|---|
| DA² | Apache-2.0: fine in a product | Distance along each ray, unknown overall size |
| DAP | CC BY-NC 4.0: testing only, no commercial use | Meters (trained up to 100 m), plus a sky mask |

## Use

From the `photo-sphere-app` folder:

```
node sphere-walk/tools/make-test-room.mjs
sphere-walk/tools/.venv/Scripts/python sphere-walk/tools/depth.py sphere-walk/tools/output/test-room.png --model da2 --truth sphere-walk/tools/output/test-room.true-depth.png
```

Then open Sphere Walk, choose **Open files…** and pick the picture plus its `.depth.png`
(and the `.true-depth.png` for an accuracy check).
