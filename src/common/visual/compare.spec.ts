import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

import { ImageDimensionsMismatchError, comparePng } from "./compare";

// A solid-color PNG of the given size, encoded as a buffer (the form `page.screenshot()` returns) —
// so these tests exercise the real pngjs-decode + pixelmatch path with no browser.
function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

test.describe("comparePng", () => {
  test("identical images → zero diff, no diff image", () => {
    const image = solidPng(20, 20, [255, 255, 255]);
    const result = comparePng(image, image);
    expect(result.diffPixels).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.totalPixels).toBe(400);
    expect(result.diffImage).toBeUndefined(); // not encoded when nothing differs
  });

  test("fully different images → ratio 1, diff image produced", () => {
    const white = solidPng(20, 20, [255, 255, 255]);
    const black = solidPng(20, 20, [0, 0, 0]);
    const result = comparePng(white, black);
    expect(result.diffPixels).toBe(400);
    expect(result.ratio).toBe(1);
    expect(result.diffImage).toBeInstanceOf(Buffer);
  });

  test("a small localized change → small non-zero ratio", () => {
    const base = solidPng(20, 20, [255, 255, 255]);
    const png = PNG.sync.read(base);
    png.data[0] = 0; // flip one pixel to black (R channel; threshold leaves the rest equal)
    png.data[1] = 0;
    png.data[2] = 0;
    const result = comparePng(base, PNG.sync.write(png));
    expect(result.diffPixels).toBe(1);
    expect(result.ratio).toBeCloseTo(1 / 400, 5);
  });

  test("dimension mismatch → ImageDimensionsMismatchError", () => {
    const a = solidPng(20, 20, [255, 255, 255]);
    const b = solidPng(20, 21, [255, 255, 255]);
    expect(() => comparePng(a, b)).toThrow(ImageDimensionsMismatchError);
  });
});
