"""AI depth for a 360° sphere picture (equirectangular), run on the PC's processor.

Writes <name>.<model>.depth.png next to the picture, in Sphere Walk's depth format
(millimeters along each pixel's view ray: red x 256 + green; 0 = unknown, e.g. sky).
Open the picture and that file together in Sphere Walk ("Open files...").

Depth models only guess distances up to an overall size, so the result is scaled until the
floor straight below the camera is --eye-height meters down (the phone's height while capturing).

Models (code in vendor/, weights in models/; see README.md in this folder):
  da2  DA² "Depth Anything in Any Direction", Apache-2.0 licence (fine to use in a product)
  dap  DAP "Depth Any Panoramas", CC BY-NC 4.0 licence (testing only, no commercial use)

Examples (from the photo-sphere-app folder):
  sphere-walk/tools/.venv/Scripts/python sphere-walk/tools/depth.py sphere.jpg
  sphere-walk/tools/.venv/Scripts/python sphere-walk/tools/depth.py test-room.png --model dap --truth test-room.true-depth.png
"""

import argparse
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

TOOLS = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(TOOLS, "vendor")
MODELS = os.path.join(TOOLS, "models")
MAX_MM = 65535


def load_da2():
    import json
    import types

    from safetensors.torch import load_file

    # Load only the model: DA-2's package start-up also loads its training and 3D-export
    # helpers, which need libraries the depth tool doesn't use (accelerate, utils3d, ...).
    package = types.ModuleType("da2")
    package.__path__ = [os.path.join(VENDOR, "DA-2", "src", "da2")]
    sys.modules["da2"] = package
    from da2.model.spherevit import SphereViT

    with open(os.path.join(VENDOR, "DA-2", "configs", "infer.json")) as f:
        config = json.load(f)
    model = SphereViT(config)
    model.load_state_dict(load_file(os.path.join(MODELS, "da2", "model.safetensors")))
    model.to("cpu")
    model.eval()

    def run(rgb):  # rgb: H x W x 3 floats 0-1
        x = torch.from_numpy(rgb.transpose(2, 0, 1)).unsqueeze(0)
        return model(x)[0].numpy()  # distance along the ray, unknown overall scale

    return run


def load_dap():
    root = os.path.join(VENDOR, "DAP")
    sys.path.insert(0, root)
    from networks.models import make

    cwd = os.getcwd()
    os.chdir(root)  # DAP finds its backbone code by a path relative to its own folder
    try:
        model = make({
            "name": "dap",
            "args": {"midas_model_type": "vitl", "fine_tune_type": "hypersim", "min_depth": 0.01,
                     "max_depth": 1.0, "train_decoder": True},
        })
    finally:
        os.chdir(cwd)
    state = torch.load(os.path.join(MODELS, "dap", "model.pth"), map_location="cpu")
    state = {k.removeprefix("module."): v for k, v in state.items()}
    missing, _ = model.load_state_dict(state, strict=False)
    if missing:
        raise RuntimeError(f"DAP weights don't fit the model ({len(missing)} missing, e.g. {missing[0]})")
    model.eval()

    def run(rgb):
        x = torch.from_numpy(rgb.transpose(2, 0, 1)).unsqueeze(0)
        out = model(x)
        depth = out["pred_depth"][0, 0].numpy() * 100  # trained on depth / 100 m
        far = out["pred_mask"][0, 0].numpy() >= 0.5  # "beyond range", such as sky
        depth[far] = 0
        return depth

    return run


LOADERS = {"da2": load_da2, "dap": load_dap}


def read_depth_png(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    return (a[..., 0] * 256 + a[..., 1]) / 1000


def write_depth_png(path, depth):
    mm = np.clip(np.round(depth * 1000), 0, MAX_MM).astype(np.uint32)
    rgb = np.zeros(depth.shape + (3,), np.uint8)
    rgb[..., 0] = mm >> 8
    rgb[..., 1] = mm & 255
    Image.fromarray(rgb).save(path)


def floor_heights(depth):
    """Height of the floor below the camera, per pixel more than 50° below the horizon."""
    h = depth.shape[0]
    first = int(h * (0.5 + 50 / 180))
    pitch = (0.5 - (np.arange(first, h) + 0.5) / h) * np.pi
    heights = depth[first:] * np.sin(-pitch)[:, None]
    return heights[depth[first:] > 0]


def resize_nearest(depth, shape):
    h, w = shape
    ys = ((np.arange(h) + 0.5) * depth.shape[0] / h).astype(int)
    xs = ((np.arange(w) + 0.5) * depth.shape[1] / w).astype(int)
    return depth[ys][:, xs]


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("image", help="360° picture (JPEG or PNG, twice as wide as high)")
    p.add_argument("--model", choices=LOADERS, default="da2")
    p.add_argument("--width", type=int, default=1024, help="width the picture is shrunk to for the model (default 1024)")
    p.add_argument("--eye-height", type=float, default=1.5, help="phone height above the floor in meters (default 1.5)")
    p.add_argument("--truth", help="true depth PNG to compare with (the test room)")
    p.add_argument("--threads", type=int, default=0, help="processor threads (default: all)")
    args = p.parse_args()

    if args.threads:
        torch.set_num_threads(args.threads)
    width = args.width // 16 * 16
    img = Image.open(args.image).convert("RGB").resize((width, width // 2), Image.LANCZOS)
    rgb = np.asarray(img).astype(np.float32) / 255

    t0 = time.time()
    run = LOADERS[args.model]()
    t1 = time.time()
    with torch.inference_mode():
        depth = run(rgb).astype(np.float32)
    t2 = time.time()

    # Real-world scale from the phone's height above the floor.
    floor = floor_heights(depth)
    found = float(np.median(floor)) if floor.size else 0
    scale = args.eye_height / found if found > 0 else 1
    depth *= scale
    floor *= scale

    base = os.path.splitext(args.image)[0]
    out = f"{base}.{args.model}.depth.png"
    write_depth_png(out, depth)

    print(f"Model {args.model}: loaded in {t1 - t0:.1f} s, depth for {width} x {width // 2} in {t2 - t1:.1f} s")
    print(f"Floor found {found:.3f} (model units) below the camera -> depth x {scale:.3f}")
    if floor.size:
        lo, hi = np.percentile(floor, [10, 90])
        print(f"Floor flatness: 80% of floor points within {lo:.2f}-{hi:.2f} m below the camera")
    if args.truth:
        truth = resize_nearest(read_depth_png(args.truth), depth.shape)
        ok = (truth > 0) & (depth > 0)
        err = np.abs(depth[ok] - truth[ok]) / truth[ok]
        print(f"Compared with the true depth: typical error {np.median(err) * 100:.1f}%, "
              f"{np.mean(err <= 0.1) * 100:.0f}% of pixels within 10%, {np.mean(err <= 0.25) * 100:.0f}% within 25%")
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
