import { describe, it, expect } from "vitest";
import { extractVideoId, extractMakerWorldDesignId, cleanHtml, isPrivateIp, isBlockedUrl } from "../src/lib/linkpreview.js";

describe("extractVideoId", () => {
  it("handles standard watch URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=10")).toBe("dQw4w9WgXcQ");
  });

  it("handles youtu.be, shorts and embed", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-youtube or malformed ids", () => {
    expect(extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch")).toBeNull();
    expect(extractVideoId("not a url")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=ab")).toBeNull();
  });
});

describe("extractMakerWorldDesignId", () => {
  it("parses plain, localized and slugged model URLs", () => {
    expect(extractMakerWorldDesignId("https://makerworld.com/models/1390818")).toBe("1390818");
    expect(extractMakerWorldDesignId("https://makerworld.com/en/models/550165-utility-carabiner")).toBe("550165");
    expect(extractMakerWorldDesignId("https://www.makerworld.com/models/1390818#profileId-oms")).toBe("1390818");
    expect(extractMakerWorldDesignId("https://makerworld.com/models/1390818?from=search")).toBe("1390818");
  });

  it("returns null for non-model makerworld or other URLs", () => {
    expect(extractMakerWorldDesignId("https://makerworld.com/en/@User")).toBeNull();
    expect(extractMakerWorldDesignId("https://example.com/models/1390818")).toBeNull();
    expect(extractMakerWorldDesignId("not a url")).toBeNull();
  });
});

describe("cleanHtml", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(cleanHtml("<boostme><boosttitle>Boost Me</boosttitle></boostme><p>&nbsp;</p>Hello &amp; goodbye&nbsp;!"))
      .toBe("Hello & goodbye !");
  });
});

describe("isPrivateIp", () => {
  it("flags private, loopback and link-local ranges", () => {
    const privateIps = [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.10.10",
      "0.0.0.0", "100.64.0.1", "198.18.0.1", "::1", "::", "::ffff:127.0.0.1", "fd00::1", "fe80::1",
    ];
    for (const ip of privateIps) expect(isPrivateIp(ip)).toBe(true);
  });

  it("allows public addresses", () => {
    const publicIps = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.1.1", "2606:4700::1111", "2001:db8::1"];
    for (const ip of publicIps) expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("isBlockedUrl", () => {
  it("rejects invalid schemes and non-http(s)", async () => {
    expect(await isBlockedUrl("not a url")).toBe("invalid url");
    expect(await isBlockedUrl("javascript:alert(1)")).toBe("scheme not http(s)");
    expect(await isBlockedUrl("ftp://example.com/x")).toBe("scheme not http(s)");
  });

  it("blocks localhost and literal private IPs without any network call", async () => {
    expect(await isBlockedUrl("http://localhost/x")).toBe("local hostname");
    expect(await isBlockedUrl("http://127.0.0.1/x")).toBe("private ip");
    expect(await isBlockedUrl("http://192.168.1.5/x")).toBe("private ip");
    expect(await isBlockedUrl("http://[::1]/x")).toBe("private ip");
  });

  it("allows a literal public IP without resolving", async () => {
    expect(await isBlockedUrl("http://8.8.8.8/x")).toBeNull();
  });
});