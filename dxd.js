const { request, gql } = require("graphql-request");
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

const VESTING_FACTORY_ABI = [
  {
    anonymous: false,
    inputs: [
      {
        indexed: false,
        internalType: "address",
        name: "vestingContractAddress",
        type: "address",
      },
    ],
    name: "VestingCreated",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "beneficiary", type: "address" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "cliffDuration", type: "uint256" },
      { internalType: "uint256", name: "duration", type: "uint256" },
      { internalType: "bool", name: "revocable", type: "bool" },
    ],
    name: "create",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];
const VESTING_FACTORY_ADDRESS = "0x9A75944Ed8B1Fff381f1eBf9DD0a75ea72F75727";
const vesting = new ethers.Contract(
  VESTING_FACTORY_ADDRESS,
  VESTING_FACTORY_ABI,
  provider
);
const VESTING_ABI = [
  {
    inputs: [],
    name: "beneficiary",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

const startBlock = 10012634; // dxd deployment block
const hundred = FixedNumber.from(100);

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

const getVestingMap = async (blockNumber) => {
  const fromBlock = 10699672; // vesting factory deployment block

  const events = await vesting.queryFilter(
    vesting.filters.VestingCreated(),
    fromBlock,
    blockNumber
  );

  const beneficiaries = await Promise.all(
    events.map(async (event) => {
      const vestingContractAddress = event.args.vestingContractAddress;
      const contract = new ethers.Contract(
        vestingContractAddress,
        VESTING_ABI,
        provider
      );
      const beneficiary = await contract.beneficiary();
      return beneficiary;
    })
  );

  const vestingMap = events.reduce(
    (prev, curr, index) => ({
      ...prev,
      [curr.args.vestingContractAddress]: beneficiaries[index],
    }),
    {}
  );

  return vestingMap;
};

// swapr
const SWAPR_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/luzzif/swapr-mainnet-alpha";
const swaprEthPair = ["0xb0dc4b36e0b4d2e3566d2328f6806ea0b76b4f13"];
const swaprUsdtPair = ["0x67bf56e4cb13363cc1a5f243e51354e7b72a8930"];

// uniswap
const UNI_SUBGRAPH =
  "https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2";
const uniPair = ["0x1c9052e823b5f4611ef7d5fb4153995b040ccbf5"];

const LP_QUERY = gql`
  query LPS($pairs: [ID!]!) {
    liquidityPositions(
      where: { pair_in: $pairs, liquidityTokenBalance_gt: "0" }
    ) {
      pair {
        totalSupply
        reserve0
      }
      user {
        id
      }
      liquidityTokenBalance
    }
  }
`;

const addLps = async (addresses, balanceMap, subgraph, pairs) => {
  const data = await request(subgraph, LP_QUERY, { pairs });
  for (let i = 0; i < data.liquidityPositions.length; i++) {
    const position = data.liquidityPositions[i];
    const address = position.user.id;
    const totalSupply = FixedNumber.from(position.pair.totalSupply);
    const balance = FixedNumber.from(position.liquidityTokenBalance);
    const reserve = FixedNumber.from(position.pair.reserve0);
    const perc = balance.divUnsafe(totalSupply).mulUnsafe(hundred);
    const dxd = perc.divUnsafe(hundred).mulUnsafe(reserve);
    if (!(await isContract(address))) {
      // add to balance
      if (!addresses.includes(address)) {
        addresses.push(address);
      }
      const existingBal = balanceMap[address];
      balanceMap[address] = existingBal ? existingBal.addUnsafe(dxd) : dxd;
    }
  }
};

const isContract = async (addr) => {
  const code = await provider.getCode(addr);
  if (code === "0x") {
    return false;
  }
  return true;
};

const run = async () => {
  clearJson();

  const blockNumber = await provider.getBlockNumber();

  let addresses = new Set();
  console.log("indexing addresses");

  const vestingMap = await getVestingMap(blockNumber);

  const progress = (chunk, len) => {
    log(`${(chunk >= len ? 100 : (chunk / len) * 100).toFixed(2)}% complete`);
  };

  // search every block from dxd contract creation for a transfer event
  // and index every unique address in the to / from event args
  const blocks = [];
  const limit = 10000;
  for (
    let fromBlock = startBlock;
    fromBlock < blockNumber;
    fromBlock += limit
  ) {
    blocks.push({ fromBlock, toBlock: fromBlock + limit });
  }

  const chunks = 10;
  for (let i = 0; i < blocks.length; i += chunks) {
    const chunk = i + chunks;
    await Promise.all(
      blocks.slice(i, chunk).map(async ({ fromBlock, toBlock }) => {
        const response = await dxd.queryFilter(
          dxd.filters.Transfer(),
          fromBlock,
          toBlock
        );

        for (let i = 0; i < response.length; i++) {
          const evnt = response[i];
          const from = evnt.args.from;
          const to = evnt.args.to;
          if (from !== constants.AddressZero) {
            addresses.add(from);
          }
          if (to !== constants.AddressZero) {
            addresses.add(to);
          }
        }
      })
    );
    progress(chunk, blocks.length);
  }

  addresses = Array.from(addresses);

  const contracts = await Promise.all(
    addresses.map(async (address) => await isContract(address))
  );

  // remove any contracts
  addresses = addresses.filter((addr, index) => {
    if (contracts[index]) {
      if (!vestingMap[addr]) {
        return false;
      }
    }
    return true;
  });

  // fetch dxd balances for every address we found
  console.log("\nfetching balances");
  let balances = [];
  const addressChunks = 200;
  for (let i = 0; i < addresses.length; i += addressChunks) {
    const chunk = i + addressChunks;
    const response = await Promise.all(
      addresses.slice(i, chunk).map(async (address) => {
        const balance = FixedNumber.from(await dxd.balanceOf(address));
        return balance;
      })
    );
    balances = [...balances, ...response];
    progress(chunk, addresses.length);
  }

  // reassign balances from vesting contracts to beneficiaries
  const balanceMap = addresses.reduce((prev, addr, index) => {
    const address = vestingMap[addr] || addr;
    const balance = balances[index];
    if (prev[address]) {
      return { ...prev, [address]: prev[address].addUnsafe(balance) };
    }
    return { ...prev, [address]: balance };
  }, {});

  // add lps
  console.log("\nadding swapr dxd/eth lps");
  await addLps(addresses, balanceMap, SWAPR_SUBGRAPH, swaprEthPair);
  console.log("\nadding swapr dxd/usdt lps");
  await addLps(addresses, balanceMap, SWAPR_SUBGRAPH, swaprUsdtPair);
  console.log("\nadding uniswap dxd/eth lps");
  await addLps(addresses, balanceMap, UNI_SUBGRAPH, uniPair);

  const snapshotDXDSupply = Object.values(balanceMap)
    .filter((b) => b)
    .reduce((prev, curr) => prev.addUnsafe(curr), FixedNumber.from(0));

  console.log("\ngenerating merkle root");

  // calculate rewards for each address
  entries = addresses.reduce((prev, address) => {
    const balance = balanceMap[address];
    if (balance && !balance.isZero()) {
      // The DXD holder airdrop is weighted, based at time of Snapshot.
      const perc = balance.divUnsafe(snapshotDXDSupply).mulUnsafe(hundred);
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

  // make sure earnings are correct
  const totalEarnings = entries.reduce(
    (total, { earnings }) => total.add(earnings),
    BigNumber.from(0)
  );
  if (totalEarnings.gt(BigNumber.from(DXD_HOLDERS_REWARD))) {
    throw new Error("Total earnings higher than expected");
  }

  const proofs = parseBalanceMap(entries);
  verifyAirdrop(proofs);
  fs.writeFileSync("dxdProofs.json", JSON.stringify(proofs));
};

run();
