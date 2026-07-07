import { describe, expect, it } from "vitest";
import { greetingKey } from "./greeting";

describe("greetingKey", () => {
  it("maps hours to the right part of day", () => {
    expect(greetingKey(0)).toBe("night");
    expect(greetingKey(4)).toBe("night");
    expect(greetingKey(5)).toBe("morning");
    expect(greetingKey(9)).toBe("morning");
    expect(greetingKey(10)).toBe("day");
    expect(greetingKey(17)).toBe("day");
    expect(greetingKey(18)).toBe("evening");
    expect(greetingKey(23)).toBe("evening");
  });
});
