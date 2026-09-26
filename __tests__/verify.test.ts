import { createHmac } from "node:crypto";
import { verify } from "../lib/line-verify";

const SECRET = "test-secret";
const BODY = '{"events":[]}';

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("verify", () => {
  it("accepts a valid signature", () => {
    expect(verify(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verify(BODY, sign(BODY, "wrong-secret"), SECRET)).toBe(false);
  });

  it("rejects null signature", () => {
    expect(verify(BODY, null, SECRET)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verify(BODY + "x", sign(BODY, SECRET), SECRET)).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(verify(BODY, "", SECRET)).toBe(false);
  });
});
