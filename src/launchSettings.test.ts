import { describe, expect, it } from "vitest";
import { draftFrom, flagsFrom, settingsFrom } from "./screens/LaunchSettings";

describe("launch settings fields", () => {
  it("reads empty fields as unset and round-trips values", () => {
    const empty = { fpsCap: "", graphicsQuality: "", width: "", height: "" };
    expect(settingsFrom(empty)).toEqual({ fpsCap: null, graphicsQuality: null, windowSize: null });
    const settings = { fpsCap: 30, graphicsQuality: 0, windowSize: { width: 640, height: 360 } };
    expect(settingsFrom(draftFrom(settings))).toEqual(settings);
    expect(draftFrom({})).toEqual(empty);
  });

  it("rejects fractions and half-set window sizes", () => {
    expect(settingsFrom({ fpsCap: "29.5", graphicsQuality: "", width: "", height: "" })).toMatch(/whole number/);
    expect(settingsFrom({ fpsCap: "", graphicsQuality: "", width: "640", height: "" })).toMatch(/width and a height/);
  });

  it("accepts one JSON object of FastFlags", () => {
    expect(flagsFrom("")).toEqual({});
    expect(flagsFrom('{ "DFIntDebugFRMQualityLevelOverride": 1 }')).toEqual({ DFIntDebugFRMQualityLevelOverride: 1 });
    expect(flagsFrom("[1]")).toMatch(/one JSON object/);
    expect(flagsFrom("null")).toMatch(/one JSON object/);
    expect(flagsFrom("{ nope")).toMatch(/valid JSON/);
  });
});
