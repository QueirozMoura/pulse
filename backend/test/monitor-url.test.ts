import { describe, expect, it } from "vitest";
import { monitorUrlSchema } from "../src/domain/monitor-url.js";

describe("monitorUrlSchema", () => {
  it("aceita HTTPS público", () => {
    expect(monitorUrlSchema.parse("https://example.com/health")).toBe("https://example.com/health");
  });

  it.each([
    "http://example.com",
    "ftp://example.com",
    "not a url",
    "https://user:pass@example.com",
    "https://localhost/x",
    "https://127.0.0.1/",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://db.internal/",
  ])("rejeita %s", (url) => {
    expect(monitorUrlSchema.safeParse(url).success).toBe(false);
  });
});
