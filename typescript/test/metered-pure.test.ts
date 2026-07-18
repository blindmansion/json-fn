import { describe, expect, test } from "bun:test";
import { callFunction, getArity, meteredPure } from "../src";

describe("meteredPure", () => {
  test("provides a meter without exposing it as a json-fn argument", () => {
    const measured = meteredPure((meter, values: unknown[]) => {
      meter.charge(values.length);
      return null;
    });
    const usage = { fuel: 0 };

    expect(getArity(measured)).toBe(1);
    expect(callFunction("measured", [[1, 2, 3]], { measured }, { usage })).toBeNull();
    expect(usage.fuel).toBeGreaterThan(1);
  });

  test("charges the shared execution budget", () => {
    const measured = meteredPure((meter, values: unknown[]) => {
      meter.charge(values.length);
      return null;
    });

    expect(() => callFunction("measured", [[1, 2, 3]], { measured }, { maxFuel: 3 })).toThrow(
      "Maximum fuel",
    );
  });
});
