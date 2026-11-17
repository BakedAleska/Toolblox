import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

const props = (resetKey: unknown) => ({ scope: "test", resetKey, fallback: () => null, children: null });

describe("ErrorBoundary", () => {
  it("keeps the error message for the fallback", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("MenuGroupContext is missing"))).toEqual({ error: "MenuGroupContext is missing" });
    expect(ErrorBoundary.getDerivedStateFromError("plain")).toEqual({ error: "plain" });
  });

  it("clears a caught error only when the reset key changes", () => {
    const failed = { error: "boom", key: "/accounts/players" };
    expect(ErrorBoundary.getDerivedStateFromProps(props("/accounts/players"), failed)).toBeNull();
    expect(ErrorBoundary.getDerivedStateFromProps(props("/"), failed)).toEqual({ error: undefined, key: "/" });
  });
});
