import { describe, expect, it } from "vitest";
import { toErrorResponse } from "./errors";

describe("error responses", () => {
  it("redacts unexpected production errors", () => {
    const response = toErrorResponse(new Error("database password leaked"), "production");

    expect(response).toEqual({
      status: 500,
      body: { error: { code: "INTERNAL_ERROR", message: "Unexpected error" } }
    });
  });

  it("keeps unexpected test errors debuggable outside production", () => {
    const response = toErrorResponse(new Error("specific failure"), "test");

    expect(response.body.error.message).toBe("specific failure");
  });
});
