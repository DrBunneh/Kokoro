import { describe, expect, it } from "vitest";
import { buildImageUrl, placeholderSvg, DEFAULT_IMAGE_BASE } from "@/data/images-core";

describe("image-core", () => {
  it("derives full/thumbnail URLs from card id", () => {
    expect(buildImageUrl("6-124", "full")).toBe(`${DEFAULT_IMAGE_BASE}/full/6-124.webp`);
    expect(buildImageUrl("6-124", "thumbnail")).toBe(`${DEFAULT_IMAGE_BASE}/thumbnail/6-124.webp`);
  });

  it("supports a swappable image base", () => {
    expect(buildImageUrl("1-1", "full", "https://example.test/img/")).toBe(
      "https://example.test/img/full/1-1.webp",
    );
  });

  it("renders a deterministic, valid SVG data-URL placeholder", () => {
    const a = placeholderSvg({ id: "6-124", name: "Maui - Half-Shark", cost: 6, colors: ["ruby"] });
    const b = placeholderSvg({ id: "6-124", name: "Maui - Half-Shark", cost: 6, colors: ["ruby"] });
    expect(a).toBe(b); // deterministic
    expect(a.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    const svg = decodeURIComponent(a.replace("data:image/svg+xml;utf8,", ""));
    expect(svg).toContain("Maui");
    expect(svg).toContain("<svg");
  });

  it("escapes XML-sensitive characters in names", () => {
    const svg = decodeURIComponent(
      placeholderSvg({ id: "x", name: "A & B <C>" }).replace("data:image/svg+xml;utf8,", ""),
    );
    expect(svg).toContain("&amp;");
    expect(svg).not.toContain("<C>");
  });
});
