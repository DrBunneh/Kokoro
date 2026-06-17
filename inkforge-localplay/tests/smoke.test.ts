import { describe, expect, it } from "vitest";
import { cn } from "@/lib/cn";

describe("scaffold smoke", () => {
  it("cn joins truthy class names", () => {
    expect(cn("a", false, "b", undefined, "c")).toBe("a b c");
  });
});
