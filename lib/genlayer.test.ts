import { describe, it, expect, vi, beforeEach } from "vitest";

// Real return_data captured live from Bradbury tx
// 0x90aa1c3106ca4e1fdc7bc434a24a948c6342d9295c36a648e8ed37d56f2356f3, a
// genuine create_channel call that returned "chn_1". Used verbatim (not
// hand-constructed) so this test proves the decoder against what GenVM
// actually produces, not against my own assumptions about its shape.
const REAL_CHN1_RETURN_DATA =
  "0x2e04646174612c63686e5f31066576656e7473050b66696e6765727072696e7416066672616d657375160466756e6391080b6d6f64756c655f6e616d653c63707974686f6e160466756e63e184070b6d6f64756c655f6e616d653c63707974686f6e160466756e6391ff050b6d6f64756c655f6e616d653c63707974686f6e160466756e63d1ff050b6d6f64756c655f6e616d653c63707974686f6e160466756e63d184060b6d6f64756c655f6e616d653c63707974686f6e160466756e63c184060b6d6f64756c655f6e616d653c63707974686f6e160466756e63c9be070b6d6f64756c655f6e616d653c63707974686f6e160466756e63c1be070b6d6f64756c655f6e616d653c63707974686f6e160466756e6399be070b6d6f64756c655f6e616d653c63707974686f6e160466756e6381be070b6d6f64756c655f6e616d653c63707974686f6e160466756e63e9f7060b6d6f64756c655f6e616d653c63707974686f6e160466756e63d1f7060b6d6f64756c655f6e616d653c63707974686f6e160466756e63f9bd070b6d6f64756c655f6e616d653c63707974686f6e160466756e63b9070b6d6f64756c655f6e616d653c63707974686f6e106d6f64756c655f696e7374616e636573160763707974686f6e0e086d656d6f726965730d8302999999dea7a42d37d28deb72ae8d967dc3a604e96b7b5a1cf48042eabd1a479f09736f6674666c6f61740e086d656d6f726965730d8302fc9e4fa3448da50dc6ff514aba0568ba045276f58d3c60fdf4c5c3d28b16acc8046b696e643452657475726e0f73746f726167655f6368616e6765732d15a302372d46c3ada9f897c74d349bbfe0e450c798167c9f580f8daf85def57e96c3ea0000000083062a0000002a0000000001000000010000000000000000000000000000000000000000000000000000000000000009000000020000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000015a30259725f8c1e399a0cc02b5e2dc35a0fd786584d36667a0d14d61d8d3bfeb391460000000083167b226964223a202263686e5f31222c20226d616e64617465223a2022417564697420766572696669636174696f6e2074657374206368616e6e656c20666f7220657865637574696f6e2d726573756c74206669656c6420636865636b2e222c202270617274696573223a2022307863366536643362326163636165636563656234306164346264336466313233646463623465353337222c202266756e646572223a2022307863366536643362326163636165636563656234306164346264336466313233646463623465353337222c202262616c616e63655f756e697473223a202230222c2022746f74616c5f6c6f636b65645f756e697473223a202230222c2022746f74616c5f736574746c65645f756e697473223a202230222c2022657870697279223a2022323032362d31322d3331222c2022737461747573223a2022616374697665227d000000000000000000000000000000000000000000000015a302ed8c72daad340947ea5b5b83b4946f4f25199fc18fca4d720a1a6d7d58b567310000000083025b2263686e5f31225d000000000000000000000000000000000000000000000015a302ee6cd442caae6bbf6f90edab15aeb9b45838444b1e4a2b339ddcfa1149d5d74a00000000830263686e5f3100000000000000000000000000000000000000000000000000000015a302f4602b4f90ee252f2f43ac8ab586e33207dcbc90d2761f0348eea2c348a66d270000000083020500000049010000000000000000000000000000000000000000000000000000";

// No live claim was submitted for this fixture (the test channel used to
// capture the real one above was never funded, so submit_claim would have
// reverted). Built instead via the SDK's own encoder --
// abi.calldata.encode(new Map([["data","clm_1"],["kind","Return"],["events",[]]]))
// -- and round-trip-verified through the real decoder before being pasted
// here, so it exercises the identical format the live fixture does.
const SYNTHETIC_CLM1_RETURN_DATA = "0x1e04646174612c636c6d5f31066576656e747305046b696e643452657475726e";

const mockWriteContract = vi.fn();
const mockGetTransaction = vi.fn();
const mockDebugTraceTransaction = vi.fn();
const mockReadContract = vi.fn();

vi.mock("genlayer-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("genlayer-js")>();
  return {
    ...actual,
    createAccount: vi.fn(() => ({ address: "0x0000000000000000000000000000000000000000" })),
    createClient: vi.fn(() => ({
      writeContract: mockWriteContract,
      getTransaction: mockGetTransaction,
      debugTraceTransaction: mockDebugTraceTransaction,
      readContract: mockReadContract,
    })),
  };
});

describe("decodeCalldataReturnValue", () => {
  it("extracts the real channel id from a live-captured create_channel trace", async () => {
    const { decodeCalldataReturnValue } = await import("./genlayer");
    expect(decodeCalldataReturnValue(REAL_CHN1_RETURN_DATA)).toBe("chn_1");
  });

  it("extracts a claim id the same way", async () => {
    const { decodeCalldataReturnValue } = await import("./genlayer");
    expect(decodeCalldataReturnValue(SYNTHETIC_CLM1_RETURN_DATA)).toBe("clm_1");
  });
});

describe("createChannel / submitClaim recover the real record id, not the tx hash", () => {
  beforeEach(() => {
    vi.resetModules();
    mockWriteContract.mockReset();
    mockGetTransaction.mockReset();
    mockDebugTraceTransaction.mockReset();
    mockReadContract.mockReset();
    process.env.NEXT_PUBLIC_VOLT_CONTRACT_ADDRESS = "0x04d42294a674e811549a28ee9497D08D23B409Dc";
  });

  it("createChannel returns chn_1 (not the tx hash), and that id is what get_channel is called with", async () => {
    mockWriteContract.mockResolvedValue("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    mockGetTransaction.mockResolvedValue({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" });
    mockDebugTraceTransaction.mockResolvedValue({ return_data: REAL_CHN1_RETURN_DATA });
    mockReadContract.mockResolvedValue(JSON.stringify({ id: "chn_1", status: "active" }));

    const { createChannel, getChannel } = await import("./genlayer");
    const channelId = await createChannel({
      mandate: "Pay the claimant if the condition is met.",
      parties: "0xabc",
      expiry: "2027-01-01",
    });

    expect(channelId).toBe("chn_1");
    expect(channelId).not.toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

    // Prove the recovered id is actually usable for the detail read, not
    // just correctly extracted in isolation -- this is what "resolves the
    // new record" means: a page navigating to /channels/${channelId} must
    // reach a get_channel call with the REAL id.
    const channel = await getChannel(channelId);
    expect(mockReadContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "get_channel", args: ["chn_1"] }));
    expect(channel.id).toBe("chn_1");
  });

  it("submitClaim returns clm_1 (not the tx hash), and that id is what get_claim is called with", async () => {
    mockWriteContract.mockResolvedValue("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    mockGetTransaction.mockResolvedValue({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_RETURN" });
    mockDebugTraceTransaction.mockResolvedValue({ return_data: SYNTHETIC_CLM1_RETURN_DATA });
    mockReadContract.mockResolvedValue(JSON.stringify({ id: "clm_1", status: "pending" }));

    const { submitClaim, getClaim } = await import("./genlayer");
    const claimId = await submitClaim({
      channelId: "chn_1",
      evidence: "https://example.com/evidence",
      requestedAmountUsdc: 5,
    });

    expect(claimId).toBe("clm_1");
    expect(claimId).not.toBe("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const claim = await getClaim(claimId);
    expect(mockReadContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "get_claim", args: ["clm_1"] }));
    expect(claim.id).toBe("clm_1");
  });

  it("a reverted execution never reaches the return-value decode step", async () => {
    mockWriteContract.mockResolvedValue("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
    mockGetTransaction.mockResolvedValue({ statusName: "FINALIZED", txExecutionResultName: "FINISHED_WITH_ERROR" });

    const { createChannel } = await import("./genlayer");
    await expect(
      createChannel({ mandate: "x".repeat(20), parties: "0xabc", expiry: "2027-01-01" })
    ).rejects.toThrow();
    expect(mockDebugTraceTransaction).not.toHaveBeenCalled();
  });
});
