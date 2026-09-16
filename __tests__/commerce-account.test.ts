import { accountKind, brandNameFor, channelApiKeysFrom, createCommerceProfileLookup } from "../server/services/commerce-account";

const id = (claims?: any) => ({ uid: "u1", email: "a@b.no", name: "A", claims });

describe("accountKind", () => {
  it("reads the signup claims", () => {
    expect(accountKind(id({ channel: true }), null)).toBe("seller");
    expect(accountKind(id({ business: true }), null)).toBe("business");
    expect(accountKind(id({ business: true, channel: true }), null)).toBe("both");
    expect(accountKind(id(), null)).toBe("none");
  });

  it("uses the Commerce profile when claims are missing", () => {
    const p = { commerceUserId: 1, isBusiness: false, isSupplier: false, brandName: null, channelApiKeys: [] };
    expect(accountKind(id(), p)).toBe("none");
    expect(accountKind(id(), { ...p, isBusiness: true })).toBe("business");
    expect(accountKind(id(), { ...p, isSupplier: true })).toBe("business");
    expect(accountKind(id({ channel: true }), { ...p, isSupplier: true })).toBe("both");
  });
});

describe("brandNameFor", () => {
  it("prefers the claim, then the profile, then the person", () => {
    const p = { commerceUserId: 1, isBusiness: true, isSupplier: false, brandName: "Profile Co", channelApiKeys: [] };
    expect(brandNameFor(id({ brandName: "Claim Co" }), p)).toBe("Claim Co");
    expect(brandNameFor(id({ brandName: "  " }), p)).toBe("Profile Co");
    expect(brandNameFor(id(), null)).toBe("A");
    expect(brandNameFor(id({ brandName: "x".repeat(300) }), null)).toHaveLength(255);
  });
});

describe("createCommerceProfileLookup", () => {
  function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
    return jest.fn(async (url: string, init: any) => {
      const route = routes[url];
      return {
        ok: (route?.status ?? 200) < 400,
        status: route?.status ?? 404,
        json: async () => route?.body,
        headers: init?.headers,
      } as any;
    });
  }

  it("builds the profile from /api/users/me and /api/channel/user with the raw token", async () => {
    const f = fakeFetch({
      "https://api-ecom-staging.vio.live/api/users/me": {
        body: { id: 1305, isBusiness: true, isSupplier: false, business: { businessName: "Kondomeriet AS" } },
      },
      "https://api-ecom-staging.vio.live/api/channel/user": {
        body: [{ id: 1, userChannelApiKey: { apiKey: " K1 " } }, { id: 2, userChannelApiKey: null }],
      },
    });
    const lookup = createCommerceProfileLookup({ baseUrl: "https://api-ecom-staging.vio.live/", fetchImpl: f as any });
    await expect(lookup("tok")).resolves.toEqual({
      commerceUserId: 1305, isBusiness: true, isSupplier: false, brandName: "Kondomeriet AS", channelApiKeys: ["K1"],
    });
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[0][1].headers).toEqual({ authorization: "tok" });
  });

  it("keeps the profile when only the channel lookup fails (no keys to claim)", async () => {
    const f = fakeFetch({
      "https://c/api/users/me": { body: { id: 5, isBusiness: true } },
      "https://c/api/channel/user": { status: 500, body: {} },
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const p = await createCommerceProfileLookup({ baseUrl: "https://c", fetchImpl: f as any })("tok");
    warn.mockRestore();
    expect(p).toEqual(expect.objectContaining({ commerceUserId: 5, isBusiness: true, channelApiKeys: [] }));
  });

  it("returns null when Commerce fails (claims decide)", async () => {
    const f = fakeFetch({
      "https://c/api/users/me": { status: 401, body: {} },
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(createCommerceProfileLookup({ baseUrl: "https://c", fetchImpl: f as any })("tok")).resolves.toBeNull();
    warn.mockRestore();
  });
});

describe("channelApiKeysFrom", () => {
  it("reads keys from an array or a { data } wrapper, trimmed and unique", () => {
    const rows = [
      { userChannelApiKey: { apiKey: "A" } },
      { userChannelApiKey: { apiKey: " A " } },
      { userChannelApiKey: { apiKey: "" } },
      { userChannelApiKey: null },
      { userChannelApiKey: { apiKey: "B" } },
    ];
    expect(channelApiKeysFrom(rows)).toEqual(["A", "B"]);
    expect(channelApiKeysFrom({ data: rows })).toEqual(["A", "B"]);
    expect(channelApiKeysFrom(null)).toEqual([]);
  });
});
