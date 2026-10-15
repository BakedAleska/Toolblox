import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("treats the custom font sizes as sizes, not colors", () => {
    expect(cn("text-button text-primary-foreground")).toBe("text-button text-primary-foreground");
    expect(cn("text-2xs text-muted-foreground")).toBe("text-2xs text-muted-foreground");
    expect(cn("text-button", "text-xs")).toBe("text-xs");
  });

  it("lets max-h-menu replace another max height", () => {
    expect(cn("max-h-(--available-height) w-(--anchor-width)", "max-h-menu")).toBe("w-(--anchor-width) max-h-menu");
  });
});
