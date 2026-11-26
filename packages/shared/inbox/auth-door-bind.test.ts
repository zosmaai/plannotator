import { describe, expect, test } from "bun:test";
import { DEFAULT_INBOX_AUTH_BIND, doorBindAddress, INBOX_AUTH_BIND_ENV } from "./auth-door";

describe("the address the door listens on", () => {
  test("nothing asked for is loopback, because the proxy is usually on this machine", () => {
    expect(DEFAULT_INBOX_AUTH_BIND).toBe("127.0.0.1");
    expect(doorBindAddress({})).toBe("127.0.0.1");
    expect(doorBindAddress({ [INBOX_AUTH_BIND_ENV]: "" })).toBe("127.0.0.1");
    expect(doorBindAddress({ [INBOX_AUTH_BIND_ENV]: "   " })).toBe("127.0.0.1");
  });

  test("the address asked for, and nothing around it", () => {
    expect(doorBindAddress({ [INBOX_AUTH_BIND_ENV]: "0.0.0.0" })).toBe("0.0.0.0");
    expect(doorBindAddress({ [INBOX_AUTH_BIND_ENV]: " 172.27.0.2\n" })).toBe("172.27.0.2");
  });

  test("the name is the one the guide and the container's own setup use", () => {
    expect(INBOX_AUTH_BIND_ENV).toBe("PLANNOTATOR_INBOX_AUTH_BIND");
  });
});
