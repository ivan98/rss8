import { describe, expect, it } from "vitest";
import { byName } from "../src/index";

describe("byName", () => {
  it("keys modules by file name without extension", () => {
    expect(byName({ "../fixtures/123.html": "a", "./x/abc.def.txt": "b" })).toEqual({ "123": "a", "abc.def": "b" });
  });
});
