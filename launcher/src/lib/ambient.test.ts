import { describe, it, expect } from "vitest";
import { weatherGroup, photoUrl } from "./ambient";

// WMO weather code buckets that drive the ambient screen's icon + text. The
// boundaries (fog 45-48, snow 71-77 & 85-86, storm >=95) are easy to get wrong.
describe("weatherGroup", () => {
  it("maps clear and cloud codes", () => {
    expect(weatherGroup(0)).toBe("clear");
    expect(weatherGroup(1)).toBe("cloudy");
    expect(weatherGroup(3)).toBe("cloudy");
  });
  it("maps fog, rain, snow and storm ranges", () => {
    expect(weatherGroup(45)).toBe("fog");
    expect(weatherGroup(48)).toBe("fog");
    expect(weatherGroup(61)).toBe("rain"); // drizzle/rain fall-through
    expect(weatherGroup(71)).toBe("snow");
    expect(weatherGroup(77)).toBe("snow");
    expect(weatherGroup(85)).toBe("snow");
    expect(weatherGroup(86)).toBe("snow");
    expect(weatherGroup(95)).toBe("storm");
    expect(weatherGroup(99)).toBe("storm");
  });
  it("defaults to cloudy when the code is missing", () => {
    expect(weatherGroup(undefined)).toBe("cloudy");
  });
});

describe("photoUrl", () => {
  it("encodes the file name into the query", () => {
    expect(photoUrl("beach.jpg")).toBe("/tvbox/api/ambient/photo?name=beach.jpg");
    expect(photoUrl("my photo&1.jpg")).toBe("/tvbox/api/ambient/photo?name=my%20photo%261.jpg");
  });
});
