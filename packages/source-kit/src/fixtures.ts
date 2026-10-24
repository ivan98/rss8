import { describe, expect, it } from "vitest";
import { htmlSignature } from "./signature";

/**
 * Keys `import.meta.glob` results by file name without extension, so
 * `../fixtures/123.html` becomes `123`.
 */
export function byName<T>(modules: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(modules).map(([path, value]) => [path.replace(/^.*\//, "").replace(/\.[^.]*$/, ""), value]),
  );
}

export interface FixtureSuite {
  /** Saved raw pages by id, for example `byName(import.meta.glob("../fixtures/*.html", { query: "?raw", import: "default", eager: true }))`. */
  pages: Record<string, string>;
  /** The source's article pipeline over one raw page. */
  process(page: string): Promise<string>;
  /** Directory of the expected outputs, relative to the test file. `vitest -u` rewrites them. */
  expectedDir: string;
  /**
   * Outputs of another implementation by id, compared by `htmlSignature`
   * (text, image, link and iframe lists) rather than byte for byte.
   * Pages without one are only checked against their expected output.
   */
  reference?: Record<string, string>;
}

/** One test per saved page: its output must equal the expected output, and match the reference by signature. */
export function describeFixtures(name: string, suite: FixtureSuite): void {
  describe(name, () => {
    for (const [id, page] of Object.entries(suite.pages)) {
      it(id, async () => {
        const output = await suite.process(page);
        await expect(output).toMatchFileSnapshot(`${suite.expectedDir}/${id}.html`);
        const reference = suite.reference?.[id];
        if (reference !== undefined) {
          expect(await htmlSignature(output), "differs from the reference output").toEqual(await htmlSignature(reference));
        }
      });
    }
  });
}
