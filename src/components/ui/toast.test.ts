import { describe, expect, it } from "vitest";
import { parseToast } from "./toast";

describe("toast messages", () => {
  it("uses the first sentence as the title and the rest as the description", () => {
    expect(parseToast("The note wasn't saved. Does retrying help? (Disk full)")).toEqual({ kind: "error", title: "The note wasn't saved", description: "Does retrying help? (Disk full)" });
    expect(parseToast("Copied.")).toEqual({ kind: "success", title: "Copied", description: "" });
    expect(parseToast("Exported to /Users/me/Downloads/theme.css.")).toEqual({ kind: "success", title: "Exported to /Users/me/Downloads/theme.css", description: "" });
  });

  it("treats a recovery question as an error unless a kind is given", () => {
    expect(parseToast("No Roblox windows are open. Is a client running?").kind).toBe("error");
    expect(parseToast("Hello, world!", "info")).toEqual({ kind: "info", title: "Hello, world!", description: "" });
  });
});
