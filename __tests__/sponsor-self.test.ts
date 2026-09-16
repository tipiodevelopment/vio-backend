import { sponsorSelfUpdateSchema } from "../server/services/sponsor-self";

describe("sponsorSelfUpdateSchema (brand edits itself)", () => {
  it("accepts identity fields", () => {
    const r = sponsorSelfUpdateSchema.safeParse({ name: " Shop AS ", logoUrl: null, primaryColor: "#ff0000" });
    expect(r.success).toBe(true);
    expect(r.success && r.data.name).toBe("Shop AS");
  });

  it("rejects fields the brand must not type", () => {
    expect(sponsorSelfUpdateSchema.safeParse({ commerceApiKey: "k" }).success).toBe(false);
    expect(sponsorSelfUpdateSchema.safeParse({ commerceUserUid: "u" }).success).toBe(false);
    expect(sponsorSelfUpdateSchema.safeParse({ paymentMethods: ["card"] }).success).toBe(false);
    expect(sponsorSelfUpdateSchema.safeParse({ userId: 1 }).success).toBe(false);
  });

  it("rejects an empty or oversized name", () => {
    expect(sponsorSelfUpdateSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(sponsorSelfUpdateSchema.safeParse({ name: "x".repeat(256) }).success).toBe(false);
  });
});
