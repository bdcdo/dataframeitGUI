import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

describe("GET /api/health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("informa o relógio da Machine em segundos Unix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T13:50:03.900Z"));

    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      server_time: Date.UTC(2026, 10, 3, 13, 50, 3) / 1000,
    });
  });
});
