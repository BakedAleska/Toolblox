import { describe, expect, it } from "vitest";
import { addToast, parseToast, type Toast } from "./toast";

describe("toast messages", () => {
  it("uses the first sentence as the title and the rest as the description", () => {
    expect(parseToast("The note wasn't saved. Does retrying help? (Disk full)")).toEqual({ kind: "error", title: "The note wasn't saved", description: "Does retrying help? (Disk full)" });
    expect(parseToast("Log copied.")).toEqual({ kind: "success", title: "Log copied", description: "" });
    expect(parseToast("Theme exported to /Users/me/Downloads/theme.css.")).toEqual({ kind: "success", title: "Theme exported to /Users/me/Downloads/theme.css", description: "" });
  });

  it("treats a recovery question as an error unless a kind is given", () => {
    expect(parseToast("No Roblox windows are open. Is a client running?").kind).toBe("error");
    expect(parseToast("Hello, world!", "info")).toEqual({ kind: "info", title: "Hello, world!", description: "" });
  });

  it("puts an error in place of the newest visible success", () => {
    const toast = (id: number, kind: Toast["kind"], leaving = false): Toast => ({ id, kind, message: "", title: "", description: "", leaving });
    const stack = [toast(1, "success"), toast(2, "info"), toast(3, "success"), toast(4, "success", true)];
    expect(addToast(stack, toast(5, "error")).map(({ id }) => id)).toEqual([1, 2, 5, 4]);
    expect(addToast([toast(1, "info")], toast(2, "error")).map(({ id }) => id)).toEqual([1, 2]);
    expect(addToast(stack, toast(5, "success")).filter(({ leaving }) => !leaving).map(({ id }) => id)).toEqual([2, 3, 5]);
  });
});
