import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuybackReadiness } from "../src/types";
import type { AssetRow, KeeperConfig } from "../src/types";

const TOKEN = "0x1111111111111111111111111111111111111111";
const WBNB = "0x2222222222222222222222222222222222222222";
const PAIR = "0x3333333333333333333333333333333333333333";
const PROCESSOR = "0x4444444444444444444444444444444444444444";
const VAULT = "0x5555555555555555555555555555555555555555";

const mock = vi.hoisted(() => ({
  vaultFails: false,
  batch: vi.fn(),
}));

vi.mock("../src/rpc", () => ({
  getLatestBlock: async () => ({ number: 100n, timestamp: 1_700_000_000, tag: "0x64" }),
  batchContractCalls: mock.batch,
}));

const { inspectAsset } = await import("../src/planner");

const config = { readRpcUrl: "https://read.invalid/" } as KeeperConfig;
const asset: AssetRow = {
  chain_id: 97,
  token: TOKEN,
  tax_processor: PROCESSOR,
  vault: VAULT,
  pair: PAIR,
  wbnb: WBNB,
  status: "active",
  next_check_at: 0,
  last_checked_at: null,
  last_error: null,
};

function baseValues() {
  return [
    TOKEN,
    WBNB,
    [1_000_000n, 50_000n, 1_700_000_000],
    [3, 500, 1_000, false, 0n, 4_800_000_000n, 0],
    0n,
    [4_000, 1_000, 2_000, 3_000, 0, false, 0, TOKEN],
    0n,
    0n,
    10_000n,
  ];
}

describe("vault ABI inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.vaultFails = false;
    mock.batch.mockImplementation(async (_url: string, calls: { functionName: string }[]) => {
      if (calls[0]?.functionName === "token0") return baseValues();
      if (calls[0]?.functionName === "previewBuyback") {
        if (mock.vaultFails) throw new Error("execution reverted");
        return [[500n, BuybackReadiness.Ready], 0];
      }
      return [false, 1_000n, 0];
    });
  });

  it("reads the dynamic executable amount from a current vault", async () => {
    const result = await inspectAsset(config, asset);
    expect(result.vaultExecutableAmount).toBe(500n);
    expect(result.vaultReadiness).toBe(BuybackReadiness.Ready);
  });

  it("surfaces vault read failures instead of guessing readiness", async () => {
    mock.vaultFails = true;
    await expect(inspectAsset(config, asset)).rejects.toThrow("execution reverted");
  });
});
