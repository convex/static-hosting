import { describe, expect, test } from "vitest";
import {
  buildEnvironment,
  buildEnvironmentChanged,
} from "./deployEnvironment.js";

describe("deploy build environment", () => {
  test("includes the Convex cloud and site URLs", () => {
    expect(
      buildEnvironment({
        siteUrl: "https://example.convex.site/app/",
        cloudUrl: "https://example.convex.cloud",
      }),
    ).toEqual({
      cloudUrl: "https://example.convex.cloud",
      siteUrl: "https://example.convex.site/app/",
      basePath: "/app/",
    });
  });

  test("detects a mount-prefix change after backend deployment", () => {
    expect(
      buildEnvironmentChanged(
        {
          siteUrl: "https://example.convex.site/old/",
          cloudUrl: "https://example.convex.cloud",
        },
        {
          siteUrl: "https://example.convex.site/new/",
          cloudUrl: "https://example.convex.cloud",
        },
      ),
    ).toBe(true);
  });

  test("does not rebuild when the build environment is unchanged", () => {
    const urls = {
      siteUrl: "https://example.convex.site/app/",
      cloudUrl: "https://example.convex.cloud",
    };
    expect(buildEnvironmentChanged(urls, urls)).toBe(false);
  });

  test("detects a site URL change with the same mount path", () => {
    expect(
      buildEnvironmentChanged(
        {
          siteUrl: "https://old.convex.site/",
          cloudUrl: "https://example.convex.cloud",
        },
        {
          siteUrl: "https://new.convex.site/",
          cloudUrl: "https://example.convex.cloud",
        },
      ),
    ).toBe(true);
  });
});
