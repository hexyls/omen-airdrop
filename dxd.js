const { ethers, utils, constants, BigNumber, FixedNumber } = require("ethers");
const { parseBalanceMap } = require("./src/parse-balance-map.ts");
const { verifyAirdrop } = require("./scripts/verify-merkle-root.ts");
const fs = require("fs");

const provider = new ethers.providers.JsonRpcBatchProvider(
  "https://mainnet.infura.io/v3/9c6788bb15234036991db4637638429f"
);
const DXD_ABI = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      {
        indexed: false,
        internalType: "uint256",
        name: "value",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    constant: true,
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    payable: false,
    stateMutability: "view",
    type: "function",
  },
];
const DXD_ADDRESS = "0xa1d65E8fB6e87b60FECCBc582F7f97804B725521";
const dxd = new ethers.Contract(DXD_ADDRESS, DXD_ABI, provider);

const startBlock = 10012634;
const endBlock = 12559235;
const limit = 10000;

const log = (str) => {
  process.stdout.clearLine();
  process.stdout.cursorTo(0);
  process.stdout.write(str);
};

const DXD_HOLDERS_REWARD = FixedNumber.from(utils.parseUnits("4200000")); // DXD Holders: 4.2% [4,200,000 OMN]

const clearJson = () => {
  try {
    fs.unlinkSync("dxdProofs.json");
  } catch (err) {}
};

const run = async () => {
  clearJson();
  console.log("indexing addresses");
  let addresses = new Set();

  // build search space
  const blocks = [];
  for (let fromBlock = startBlock; fromBlock < endBlock; fromBlock += limit) {
    blocks.push({ fromBlock, toBlock: fromBlock + limit });
  }

  // process in chunks
  const chunks = 10;
  for (let i = 0; i < blocks.length; i += chunks) {
    await Promise.all(
      blocks.slice(i, i + chunks).map(async ({ fromBlock, toBlock }) => {
        const response = await dxd.queryFilter(
          dxd.filters.Transfer(),
          fromBlock,
          toBlock
        );

        for (let i = 0; i < response.length; i++) {
          const evnt = response[i];
          if (evnt.args.from !== constants.AddressZero) {
            addresses.add(evnt.args.from);
          }
          if (evnt.args.to !== constants.AddressZero) {
            addresses.add(evnt.args.to);
          }
        }

        log(
          `${(
            ((fromBlock - startBlock) / (endBlock - startBlock)) *
            100
          ).toFixed(2)}% complete`
        );
      })
    );
  }

  addresses = Array.from(addresses);

  console.log("\nfetching balances");
  const balances = await Promise.all(
    addresses.map(async (address) =>
      FixedNumber.from(await dxd.balanceOf(address))
    )
  );

  const totalSupply = FixedNumber.from(await dxd.totalSupply());
  const hundred = FixedNumber.from(100);

  console.log("generating merkle root");
  entries = balances.reduce((prev, balance, index) => {
    const address = addresses[index];
    if (!balance.isZero()) {
      // The DXD holder airdrop is weighted, based at time of Snapshot.
      const perc = balance.divUnsafe(totalSupply).mulUnsafe(hundred);
      const reward = perc.divUnsafe(hundred).mulUnsafe(DXD_HOLDERS_REWARD);
      if (!reward.isZero()) {
        const earnings = BigNumber.from(
          reward.toString().replace(".0", "")
        ).toHexString();
        return [...prev, { address, earnings, reasons: "" }];
      }
    }
    return prev;
  }, []);

  const proofs = parseBalanceMap(entries);
  verifyAirdrop(proofs);
  fs.writeFileSync("dxdProofs.json", JSON.stringify(proofs));
};

run();
